import { ConflictException, ForbiddenException } from '@nestjs/common';
import axios from 'axios';
import { createHash } from 'node:crypto';
import { GithubAppService } from '../github-app/github-app.service';

export interface SourceSetupPlan {
  repo: string; branch: string; sha: string; digest: string;
  files: { path: string; action: 'create' | 'keep' | 'review'; before: string | null; after: string }[];
}
export const SOURCE_SETUP_CONSENT = 'source-setup-v1';

/** GitHub-only source setup. This never registers a Kubernetes deployment. */
export class SourceSetup {
  constructor(private readonly github: GithubAppService) {}
  private async client(repo: string, write = false) {
    const [owner, name] = repo.split('/');
    let token: string;
    try {
      token = await this.github.getInstallationTokenForRepo(owner, name, write
        ? { contents: 'write', workflows: 'write', pull_requests: 'write' }
        : { contents: 'read', pull_requests: 'read' });
    } catch (err) {
      if ((err as Error).message?.startsWith('INSTALLATION_NOT_FOUND')) throw new ForbiddenException('GitHub App을 이 저장소에 설치하고 다시 조회해 주세요.');
      throw err;
    }
    return axios.create({ baseURL: `https://api.github.com/repos/${repo}`, timeout: 20_000,
      maxContentLength: 4_000_000, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
  }

  async inspect(repo: string, desired: Record<string, string>): Promise<SourceSetupPlan> {
    const gh = await this.client(repo);
    const branch = (await gh.get('')).data.default_branch;
    if (branch !== 'main') throw new ConflictException('현재는 기본 브랜치 main만 지원합니다.');
    const sha = (await gh.get('/git/ref/heads/main')).data.object.sha;
    const commit = (await gh.get(`/git/commits/${sha}`)).data;
    const tree = (await gh.get(`/git/trees/${commit.tree.sha}`, { params: { recursive: '1' } })).data;
    if (tree.truncated || !Array.isArray(tree.tree)) throw new ConflictException('저장소 파일 목록을 완전히 확인할 수 없습니다.');
    const files: SourceSetupPlan['files'] = [];
    for (const [path, after] of Object.entries(desired)) {
      const entry = tree.tree.find((item: { path: string }) => item.path === path);
      let before: string | null = null;
      if (entry) {
        if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || entry.size > 200_000) {
          throw new ConflictException(`${path}: 일반 텍스트 파일만 검토할 수 있습니다. 수동 설정이 필요합니다.`);
        }
        const blob = (await gh.get(`/git/blobs/${entry.sha}`)).data;
        if (blob.encoding !== 'base64' || blob.size > 200_000) throw new ConflictException(`${path} 내용을 확인할 수 없습니다.`);
        before = Buffer.from(blob.content, 'base64').toString('utf8');
      }
      files.push({ path, before, after, action: before === null ? 'create' :
        before.replace(/\r\n/g, '\n') === after.replace(/\r\n/g, '\n') ? 'keep' : 'review' });
    }
    const digest = createHash('sha256').update(JSON.stringify({ repo, branch, sha, files })).digest('hex');
    return { repo, branch, sha, files, digest };
  }

  assertReviewed(plan: SourceSetupPlan, digest?: string, consent?: string): void {
    if (consent !== SOURCE_SETUP_CONSENT || digest !== plan.digest) {
      throw new ConflictException('저장소 변경 내용을 다시 확인하고 동의해 주세요. 소스 또는 템플릿이 변경되었을 수 있습니다.');
    }
  }

  async createMissing(plan: SourceSetupPlan): Promise<string> {
    if (plan.files.some(file => file.action === 'review')) throw new ConflictException('기존 파일 변경은 PR 검토가 필요합니다. 기본 브랜치를 덮어쓰지 않습니다.');
    const files = Object.fromEntries(plan.files.filter(file => file.action === 'create').map(file => [file.path, file.after]));
    if (!Object.keys(files).length) return plan.sha;
    const [owner, repo] = plan.repo.split('/');
    const token = await this.github.getInstallationTokenForRepo(owner, repo, { contents: 'write', workflows: 'write' });
    return this.github.commitFilesAtomic({ owner, repo, branch: plan.branch, expectedHeadSha: plan.sha,
      files, token, message: 'chore: add user-approved swkoo.kr deployment files' });
  }

  async createPr(plan: SourceSetupPlan): Promise<{ prUrl: string }> {
    if (!plan.files.some(file => file.action === 'review')) throw new ConflictException('기존 파일 변경이 없어 PR이 필요하지 않습니다. 변경 내용을 확인하고 배포하세요.');
    const gh = await this.client(plan.repo, true);
    const branch = `swkoo/setup-${plan.digest.slice(0, 24)}`;
    const prs = (await gh.get('/pulls', { params: { state: 'all', head: `${plan.repo.split('/')[0]}:${branch}`, base: plan.branch } })).data;
    if (prs.length) {
      if (prs[0].state !== 'open') throw new ConflictException('이 수정안의 PR이 이미 닫혔습니다. GitHub에서 확인하거나 파일을 직접 정리한 뒤 다시 조회하세요.');
      return { prUrl: prs[0].html_url };
    }
    const open = (await gh.get('/pulls', { params: { state: 'open', base: plan.branch, per_page: 100 } })).data
      .find((pr: any) => pr.head?.ref?.startsWith('swkoo/setup-') && pr.head?.repo?.full_name?.toLowerCase() === plan.repo.toLowerCase());
    if (open) throw new ConflictException(`열린 배포 설정 PR을 먼저 검토하세요: ${open.html_url}`);
    const current = (await gh.get('/git/ref/heads/main')).data.object.sha;
    if (current !== plan.sha || (await gh.get('')).data.default_branch !== plan.branch) throw new ConflictException('기준 브랜치가 변경되었습니다. 다시 조회하세요.');
    const base = (await gh.get(`/git/commits/${plan.sha}`)).data;
    const treeEntries = [];
    for (const file of plan.files.filter(file => file.action !== 'keep')) {
      const blob = (await gh.post('/git/blobs', { content: Buffer.from(file.after).toString('base64'), encoding: 'base64' })).data;
      treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const tree = (await gh.post('/git/trees', { base_tree: base.tree.sha, tree: treeEntries })).data;
    const commit = (await gh.post('/git/commits', { message: 'chore: propose user-requested swkoo.kr deployment setup', tree: tree.sha, parents: [plan.sha] })).data;
    try { await gh.post('/git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha }); }
    catch (err) {
      if (!axios.isAxiosError(err) || err.response?.status !== 422) throw err;
      const ref = (await gh.get(`/git/ref/heads/${branch}`)).data;
      const existing = (await gh.get(`/git/commits/${ref.object.sha}`)).data;
      if (existing.tree.sha !== tree.sha || existing.parents.length !== 1 || existing.parents[0].sha !== plan.sha) {
        throw new ConflictException('제안 브랜치가 수정되었습니다. 기존 브랜치를 덮어쓰지 않습니다.');
      }
    }
    const body = ['## 사용자가 요청한 배포 설정 변경', `기준: ${plan.branch} / ${plan.sha}`,
      ...plan.files.map(file => `- ${file.path}: ${file.action === 'create' ? '생성' : file.action === 'keep' ? '유지' : '변경 제안'}`),
      '기존 파일과 서비스 템플릿의 차이를 검토하는 초안입니다. 기존 설정이 잘못되었다는 판정이 아니며, 앱 빌드·테스트는 실행하지 않았습니다.',
      '**자동 병합하지 않습니다.** 변경을 검토하고 병합한 뒤 swkoo.kr 배포 화면에서 다시 조회하고 배포를 계속하세요.',
      'PR 생성만으로 신규 배포를 등록하지 않습니다. 이미 배포 중인 앱은 병합 시 기존 자동 빌드·배포가 실행될 수 있습니다.'].join('\n\n');
    try {
      const pr = (await gh.post('/pulls', { title: '배포 설정 변경 제안 (사용자 검토 필요)', head: branch, base: plan.branch, body, draft: true })).data;
      return { prUrl: pr.html_url };
    } catch (err) {
      const existing = (await gh.get('/pulls', { params: { state: 'open', head: `${plan.repo.split('/')[0]}:${branch}`, base: plan.branch } })).data[0];
      if (existing) return { prUrl: existing.html_url };
      throw err;
    }
  }
}
