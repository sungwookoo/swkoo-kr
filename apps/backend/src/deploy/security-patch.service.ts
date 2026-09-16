import { BadRequestException, ConflictException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { GithubAppService } from '../github-app/github-app.service';
import { KubeClient } from '../kube/kube.client';
import { UserRow, UsersRepository } from '../onboarding/users.repository';
import { DeployService } from './deploy.service';
import { PATCH_POLICY, PatchResult, validatePatchInput, validatePatchResult } from './security-patch.policy';
import { PatchPlan, SecurityPatchRepository } from './security-patch.repository';
import { patchJob } from './security-patch.worker';

@Injectable()
export class SecurityPatchService {
  // Single backend replica, same deployment constraint as existing schedulers.
  // Persisted plans/unique branch names additionally make retries restart-safe.
  private readonly busy = new Set<number>();
  constructor(private readonly github: GithubAppService, private readonly kube: KubeClient,
    private readonly users: UsersRepository, private readonly deploy: DeployService,
    private readonly plans: SecurityPatchRepository) {}

  @Cron('0 * * * *')
  prune(): void { this.plans.prune(); }

  private async ownedRepo(user: UserRow, repo: string): Promise<void> {
    if (!user.isAllowed || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
        repo.split('/')[0].toLowerCase() !== user.githubLogin.toLowerCase()) throw new ForbiddenException('본인 저장소만 요청할 수 있습니다.');
    const current = await this.deploy.getCurrentDeployment(user.githubLogin);
    if (current?.state !== 'active' || current.fullName.toLowerCase() !== repo.toLowerCase()) throw new ForbiddenException('현재 배포 중인 본인 저장소만 지원합니다.');
  }

  private async exclusive<T>(user: UserRow, task: () => Promise<T>): Promise<T> {
    if (this.busy.has(user.id)) throw new ConflictException('요청을 처리 중입니다. 잠시 후 다시 시도하세요.');
    this.busy.add(user.id);
    try { return await task(); }
    catch (err) {
      if (axios.isAxiosError(err)) {
        if ([403, 404].includes(err.response?.status ?? 0)) throw new ForbiddenException('GitHub App의 해당 저장소 접근 및 Contents·Pull requests 권한을 확인하세요.');
        throw new ServiceUnavailableException('GitHub 요청을 완료하지 못했습니다. 같은 수정안으로 다시 시도하세요.');
      }
      throw err;
    } finally { this.busy.delete(user.id); }
  }

  private async client(repo: string, write = false) {
    const [owner, name] = repo.split('/');
    const token = await this.github.getInstallationTokenForRepo(owner, name,
      write ? { contents: 'write', pull_requests: 'write' } : { contents: 'read', pull_requests: 'read' });
    return axios.create({ baseURL: `https://api.github.com/repos/${repo}`, timeout: 20_000,
      maxContentLength: 2_000_000, maxBodyLength: 2_000_000,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
  }

  private view(plan: PatchPlan | null) {
    if (!plan) return null;
    const { manifest: _manifest, original: _original, lockfile: _lockfile, userId: _userId, ...safe } = plan;
    return { ...safe, policy: PATCH_POLICY, tests: 'not_run', build: 'not_run' };
  }
  private audit(user: UserRow, action: string, plan: PatchPlan): void {
    this.users.audit({ actor: user.githubLogin, action, target: plan.repo, reason: plan.state,
      metaJson: JSON.stringify({ id: plan.id, sha: plan.sha, policy: PATCH_POLICY, prUrl: plan.prUrl }) });
  }

  async prepare(user: UserRow, repo: string, consent: string) {
    if (consent !== PATCH_POLICY) throw new BadRequestException('보안 수정안 준비 동의가 필요합니다.');
    return this.exclusive(user, async () => {
      await this.ownedRepo(user, repo);
      this.plans.prune();
      const prior = this.plans.get(user.id);
      if (prior && prior.repo.toLowerCase() === repo.toLowerCase() && ['preparing', 'ready', 'creating'].includes(prior.state)) return this.view(prior);
      if (prior && Date.now() - prior.createdAt < 60_000) throw new ConflictException('수정안 준비는 1분에 한 번 요청할 수 있습니다.');
      if (!this.kube.available()) throw new ServiceUnavailableException('수정안 준비 작업을 실행할 수 없습니다.');
      const jobs = await this.kube.batch!.listNamespacedJob({ namespace: 'swkoo' });
      if (jobs.items.filter(j => j.metadata?.name?.startsWith('security-patch-') && !j.status?.succeeded && !j.status?.failed).length >= 2) {
        throw new ConflictException('다른 수정안을 준비 중입니다. 잠시 후 다시 요청하세요.');
      }
      const gh = await this.client(repo);
      const meta = (await gh.get('')).data;
      const base: string = meta.default_branch;
      const sha: string = (await gh.get(`/commits/${encodeURIComponent(base)}`)).data.sha;
      const openPr = (await gh.get('/pulls', { params: { state: 'open', per_page: 100, base } })).data
        .find((p: { head?: { ref?: string; repo?: { full_name?: string } } }) =>
          p.head?.ref?.startsWith('swkoo/security-') && p.head.repo?.full_name?.toLowerCase() === repo.toLowerCase());
      if (openPr) throw new ConflictException(`열린 보안 수정 PR이 있습니다. 먼저 검토하세요: ${openPr.html_url}`);
      const read = async (path: string) => {
        const data = (await gh.get(`/contents/${path}`, { params: { ref: sha } })).data;
        if (data.type !== 'file' || data.encoding !== 'base64' || data.size > 800_000) throw new BadRequestException('지원하지 않는 파일 크기 또는 형식입니다.');
        return Buffer.from(data.content, 'base64').toString('utf8');
      };
      let manifest: string, original: string;
      try {
        [manifest, original] = await Promise.all([read('package.json'), read('package-lock.json')]);
        validatePatchInput(manifest, original);
      } catch (err) {
        if (axios.isAxiosError(err)) throw new BadRequestException('package.json·package-lock.json을 읽을 수 없습니다. 설치 권한과 파일을 확인하세요.');
        throw new BadRequestException((err as Error).message);
      }
      const plan: PatchPlan = { id: randomUUID(), userId: user.id, repo, base, sha, manifest, original,
        createdAt: Date.now(), updatedAt: Date.now(), state: 'preparing' };
      let job;
      try { job = patchJob(plan.id, manifest, original); } catch (err) { throw new BadRequestException((err as Error).message); }
      if (this.plans.countPreparing() >= 2) throw new ConflictException('다른 수정안을 준비 중입니다. 잠시 후 다시 요청하세요.');
      this.plans.save(plan);
      this.audit(user, 'SECURITY_PATCH_REQUESTED', plan);
      try { await this.kube.batch!.createNamespacedJob({ namespace: 'swkoo', body: job }); }
      catch { plan.state = 'failed'; plan.message = '격리 작업을 시작하지 못했습니다. 다시 요청하세요.'; this.plans.save(plan); }
      return this.view(plan);
    });
  }

  async status(user: UserRow, repo: string) {
    return this.exclusive(user, async () => {
      await this.ownedRepo(user, repo);
      this.plans.prune();
      const plan = this.plans.get(user.id);
      if (!plan || plan.repo.toLowerCase() !== repo.toLowerCase()) return null;
      if (plan.state !== 'preparing') return this.view(plan);
      const name = `security-patch-${plan.id}`;
      try {
        const job = await this.kube.batch!.readNamespacedJob({ namespace: 'swkoo', name });
        if (!job.status?.succeeded && !job.status?.failed && Date.now() - plan.createdAt < 420_000) return this.view(plan);
        if (!job.status?.succeeded) throw new Error('수정안 준비에 실패했습니다. 지원 범위 또는 npm 연결 상태를 확인하고 다시 요청하세요.');
        const pods = await this.kube.core!.listNamespacedPod({ namespace: 'swkoo', labelSelector: `job-name=${name}` });
        const pod = pods.items[0]?.metadata?.name;
        if (!pod) throw new Error('작업 결과가 만료되었습니다. 다시 요청하세요.');
        const logs = await this.kube.core!.readNamespacedPodLog({ namespace: 'swkoo', name: pod, container: 'patch', limitBytes: 2_000_000 });
        const result: PatchResult = JSON.parse(logs);
        try {
          plan.changes = validatePatchResult(plan.manifest, plan.original, result);
          plan.lockfile = result.lockfile; plan.before = result.before; plan.after = result.after; plan.state = 'ready';
        } catch (err) { plan.state = 'blocked'; plan.message = (err as Error).message; }
      } catch { plan.state = 'failed'; plan.message = '작업이 실패하거나 결과가 만료되었습니다. 자동 변경은 적용되지 않았습니다.'; }
      plan.updatedAt = Date.now(); this.plans.save(plan); this.audit(user, 'SECURITY_PATCH_PREPARED', plan);
      await this.kube.batch!.deleteNamespacedJob({ namespace: 'swkoo', name, propagationPolicy: 'Background' }).catch(() => undefined);
      return this.view(plan);
    });
  }

  async createPr(user: UserRow, repo: string, id: string, consent: string) {
    if (consent !== PATCH_POLICY) throw new BadRequestException('초안 PR 생성 동의가 필요합니다.');
    return this.exclusive(user, async () => {
      await this.ownedRepo(user, repo);
      const plan = this.plans.get(user.id);
      if (!plan || plan.id !== id || plan.repo.toLowerCase() !== repo.toLowerCase() || Date.now() - plan.createdAt > 24 * 60 * 60_000) {
        throw new ConflictException('수정안이 없거나 만료되었습니다. 다시 준비하세요.');
      }
      if (plan.state === 'pr') return this.view(plan);
      if (!['ready', 'creating'].includes(plan.state) || !plan.lockfile) throw new ConflictException('PR을 생성할 수 있는 수정안이 아닙니다.');
      validatePatchResult(plan.manifest, plan.original, { lockfile: plan.lockfile, changes: plan.changes!, before: plan.before!, after: plan.after! });
      const gh = await this.client(repo, true);
      const branch = `swkoo/security-${plan.id}`;
      const findPr = async () => (await gh.get('/pulls', { params: { state: 'all', head: `${repo.split('/')[0]}:${branch}`, base: plan.base } })).data[0];
      let pr = await findPr();
      if (!pr) {
        const defaultBranch = (await gh.get('')).data.default_branch;
        const current = (await gh.get(`/commits/${encodeURIComponent(plan.base)}`)).data.sha;
        if (current !== plan.sha || defaultBranch !== plan.base) {
          plan.state = 'blocked'; plan.message = '기준 브랜치가 변경되었습니다. 최신 소스로 수정안을 다시 준비하세요.'; this.plans.save(plan);
          throw new ConflictException(plan.message);
        }
        plan.state = 'creating'; plan.updatedAt = Date.now(); this.plans.save(plan);
        this.audit(user, 'SECURITY_PATCH_PR_REQUESTED', plan);
        // Build immutable objects from the reviewed SHA. Never PATCH a ref,
        // never write to the base branch, never merge or enable auto-merge.
        const baseCommit = (await gh.get(`/git/commits/${plan.sha}`)).data;
        const blob = (await gh.post('/git/blobs', { content: Buffer.from(plan.lockfile).toString('base64'), encoding: 'base64' })).data;
        const tree = (await gh.post('/git/trees', { base_tree: baseCommit.tree.sha, tree: [{ path: 'package-lock.json', mode: '100644', type: 'blob', sha: blob.sha }] })).data;
        const commit = (await gh.post('/git/commits', { message: 'fix: propose opt-in npm security lockfile updates', tree: tree.sha, parents: [plan.sha] })).data;
        try { await gh.post('/git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha }); }
        catch (err) {
          if (!axios.isAxiosError(err) || err.response?.status !== 422) throw err;
          const existing = (await gh.get(`/git/ref/heads/${branch}`)).data;
          const existingCommit = (await gh.get(`/git/commits/${existing.object.sha}`)).data;
          if (existingCommit.tree.sha !== tree.sha || existingCommit.parents.length !== 1 || existingCommit.parents[0].sha !== plan.sha) {
            plan.state = 'blocked'; plan.message = '제안 브랜치가 변경되었습니다. 기존 브랜치를 덮어쓰지 않습니다.'; this.plans.save(plan);
            throw new ConflictException('제안 브랜치가 변경되었습니다. 기존 브랜치를 덮어쓰지 않습니다.');
          }
        }
        const body = [
          '## 사용자가 요청한 보안 수정 제안',
          `정책: ${PATCH_POLICY} · 기준 commit: ${plan.sha}`,
          '변경 파일: package-lock.json만. package.json·앱 코드·DB·Dockerfile·workflow는 변경하지 않습니다.',
          `npm audit 취약점 집계: ${plan.before} → ${plan.after}. 운영 이미지 Trivy 결과와 집계 기준이 다릅니다.`,
          '기존 버전 범위 안의 수정안입니다. 메이저 업그레이드 및 0.x minor 변경은 차단했습니다.',
          '## 검증 한계',
          'npm audit 재검사와 정책 검사를 수행했습니다. 앱 테스트·프로덕션 빌드·DB 연결은 실행하지 않았습니다. GitHub에서 별도로 검증한 뒤 초안을 해제하고 병합하세요.',
          '**swkoo.kr는 이 PR을 자동 병합하지 않습니다. 사용자가 병합하면 기존 자동 배포가 실행될 수 있습니다.**',
          '## 패키지 변경',
          ...(plan.changes ?? []).map(c => `- ${c.path}: ${c.from ?? '(추가)'} → ${c.to ?? '(제거)'}`),
        ].join('\n\n');
        try { pr = (await gh.post('/pulls', { title: '보안 수정 제안: npm lockfile (사용자 검토 필요)', head: branch, base: plan.base, body, draft: true })).data; }
        catch (err) { pr = await findPr(); if (!pr) throw err; }
      }
      plan.state = 'pr'; plan.prUrl = pr.html_url; plan.updatedAt = Date.now(); this.plans.save(plan);
      this.audit(user, 'SECURITY_PATCH_PR_CREATED', plan);
      return this.view(plan);
    });
  }
}
