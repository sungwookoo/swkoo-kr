import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import axios from 'axios';
import { sign as jwtSign } from 'jsonwebtoken';

import { onboardingConfig } from '../config/onboarding.config';

interface InstallationResp {
  id: number;
}

export interface GhcrPackageVersion {
  /** Version digest, format `sha256:<64hex>`. */
  name: string;
  metadata: {
    container: { tags: string[] };
  };
}

interface InstallationTokenResp {
  token: string;
  expires_at: string;
}

interface GitRefResp {
  object: { sha: string };
}

interface GitCommitResp {
  sha: string;
  tree: { sha: string };
}

interface GitTreeEntry {
  path: string;
  mode: '100644' | '100755' | '040000' | '160000' | '120000';
  type: 'blob' | 'tree' | 'commit';
  sha?: string | null;
}

interface GitTreeResp {
  sha: string;
  tree: Array<{ path: string; mode: string; type: string; sha: string }>;
}

const BOT_AUTHOR = {
  name: 'swkoo.kr deploy bot',
  email: 'bot@swkoo.kr',
};

/**
 * Wraps the GitHub App auth flow: generates the App JWT, exchanges it for an
 * installation token, and exposes higher-level helpers for atomic commits.
 */
@Injectable()
export class GithubAppService {
  private readonly logger = new Logger(GithubAppService.name);

  constructor(
    @Inject(onboardingConfig.KEY)
    private readonly config: ConfigType<typeof onboardingConfig>
  ) {}

  private generateAppJwt(): string {
    if (!this.config.githubAppId || !this.config.githubAppPrivateKey) {
      throw new Error('GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY not configured');
    }
    const now = Math.floor(Date.now() / 1000);
    return jwtSign(
      { iat: now - 60, exp: now + 600, iss: this.config.githubAppId },
      this.config.githubAppPrivateKey,
      { algorithm: 'RS256' }
    );
  }

  private get appAuthHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.generateAppJwt()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  private installationAuthHeaders(token: string): Record<string, string> {
    return {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  /** Finds the App installation that has access to the given repo and mints
   * a fresh installation token (valid ~1h). Returns INSTALLATION_NOT_FOUND
   * when the App hasn't been installed on that repo. */
  async getInstallationTokenForRepo(owner: string, repo: string): Promise<string> {
    let installationId: number;
    try {
      const resp = await axios.get<InstallationResp>(
        `https://api.github.com/repos/${owner}/${repo}/installation`,
        { headers: this.appAuthHeaders }
      );
      installationId = resp.data.id;
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404) {
        throw new Error(`INSTALLATION_NOT_FOUND:${owner}/${repo}`);
      }
      throw err;
    }
    return this.mintInstallationToken(installationId);
  }

  /** Like getInstallationTokenForRepo but resolves the installation by org —
   * used when we need to create a repo (no repo exists yet to anchor the
   * lookup). The App must be installed on the org with Administration:write. */
  async getInstallationTokenForOrg(org: string): Promise<string> {
    let installationId: number;
    try {
      const resp = await axios.get<InstallationResp>(
        `https://api.github.com/orgs/${org}/installation`,
        { headers: this.appAuthHeaders }
      );
      installationId = resp.data.id;
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404) {
        throw new Error(`INSTALLATION_NOT_FOUND:org/${org}`);
      }
      throw err;
    }
    return this.mintInstallationToken(installationId);
  }

  private async mintInstallationToken(installationId: number): Promise<string> {
    const tokenResp = await axios.post<InstallationTokenResp>(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {},
      { headers: this.appAuthHeaders }
    );
    return tokenResp.data.token;
  }

  /** Creates `<org>/<name>` (private, auto-initialized with a README) if it
   * doesn't already exist. Idempotent: if the repo is already there but
   * archived (which is the state we leave it in on unregister), unarchives
   * it so subsequent write calls don't 403. Used on register to ensure a
   * per-user deploy repo. */
  async ensureRepoInOrg(args: {
    org: string;
    name: string;
    description: string;
    token: string;
  }): Promise<void> {
    const { org, name, description, token } = args;
    const headers = this.installationAuthHeaders(token);
    try {
      const resp = await axios.get<{ archived?: boolean }>(
        `https://api.github.com/repos/${org}/${name}`,
        { headers }
      );
      if (resp.data.archived) {
        await axios.patch(
          `https://api.github.com/repos/${org}/${name}`,
          { archived: false },
          { headers }
        );
        this.logger.log(`unarchived deploy repo ${org}/${name} (was archived from a prior unregister)`);
      }
      return;
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status !== 404) throw err;
    }
    await axios.post(
      `https://api.github.com/orgs/${org}/repos`,
      {
        name,
        description,
        private: true,
        auto_init: true,
        has_issues: false,
        has_projects: false,
        has_wiki: false,
      },
      { headers }
    );
    this.logger.log(`created deploy repo ${org}/${name}`);
  }

  /** Lists archived repos under an org along with their archive timestamp.
   * GitHub's repo listing exposes `archived` and `updated_at` — the latter
   * approximates "archived at" for our purposes (we never touch archived
   * repos, so updated_at is when we archived them). */
  async listArchivedRepos(
    org: string,
    token: string
  ): Promise<Array<{ name: string; archivedSinceIso: string }>> {
    const headers = this.installationAuthHeaders(token);
    const out: Array<{ name: string; archivedSinceIso: string }> = [];
    let page = 1;
    while (true) {
      const resp = await axios.get<
        Array<{ name: string; archived: boolean; updated_at: string }>
      >(`https://api.github.com/orgs/${org}/repos`, {
        headers,
        params: { per_page: 100, page, type: 'private' },
      });
      for (const r of resp.data) {
        if (r.archived) out.push({ name: r.name, archivedSinceIso: r.updated_at });
      }
      if (resp.data.length < 100) break;
      page += 1;
    }
    return out;
  }

  /** Hard-deletes a repo. No going back. Used by the cleanup cron after
   * the 30-day archive retention window expires. */
  async deleteRepo(args: { owner: string; repo: string; token: string }): Promise<void> {
    const { owner, repo, token } = args;
    try {
      await axios.delete(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: this.installationAuthHeaders(token),
      });
      this.logger.log(`hard-deleted deploy repo ${owner}/${repo}`);
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404) return;
      throw err;
    }
  }

  /** Archives a repo (read-only, recoverable from GitHub UI). Used on
   * unregister so the manifests aren't lost outright — operator can
   * unarchive or delete later. */
  async archiveRepo(args: { owner: string; repo: string; token: string }): Promise<void> {
    const { owner, repo, token } = args;
    try {
      await axios.patch(
        `https://api.github.com/repos/${owner}/${repo}`,
        { archived: true },
        { headers: this.installationAuthHeaders(token) }
      );
      this.logger.log(`archived deploy repo ${owner}/${repo}`);
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404) return; // already gone — fine
      throw err;
    }
  }

  /** Atomic multi-file commit using the Git Data API. If `replaceDirPath` is
   * set, files under that directory not present in `files` are deleted in the
   * same commit (so re-deploys leave no orphans). `deletePaths` removes
   * specific files outright. Returns the new commit sha. */
  async commitFilesAtomic(args: {
    owner: string;
    repo: string;
    branch: string;
    files: Record<string, string>;
    message: string;
    token: string;
    replaceDirPath?: string;
    deletePaths?: string[];
  }): Promise<string> {
    const { owner, repo, branch, files, message, token, replaceDirPath, deletePaths } = args;
    const headers = this.installationAuthHeaders(token);

    const refResp = await axios.get<GitRefResp>(
      `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`,
      { headers }
    );
    const baseCommitSha = refResp.data.object.sha;

    const baseCommitResp = await axios.get<GitCommitResp>(
      `https://api.github.com/repos/${owner}/${repo}/git/commits/${baseCommitSha}`,
      { headers }
    );
    const baseTreeSha = baseCommitResp.data.tree.sha;

    const newPaths = new Set(Object.keys(files));
    const deletions: GitTreeEntry[] = [];
    if (replaceDirPath) {
      const treeResp = await axios.get<GitTreeResp>(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${baseTreeSha}?recursive=1`,
        { headers }
      );
      for (const entry of treeResp.data.tree) {
        if (
          entry.type === 'blob' &&
          entry.path.startsWith(`${replaceDirPath}/`) &&
          !newPaths.has(entry.path)
        ) {
          deletions.push({
            path: entry.path,
            mode: '100644',
            type: 'blob',
            sha: null,
          });
        }
      }
    }
    if (deletePaths) {
      for (const path of deletePaths) {
        if (!newPaths.has(path)) {
          deletions.push({ path, mode: '100644', type: 'blob', sha: null });
        }
      }
    }

    const blobEntries: GitTreeEntry[] = [];
    for (const [path, content] of Object.entries(files)) {
      const blobResp = await axios.post<{ sha: string }>(
        `https://api.github.com/repos/${owner}/${repo}/git/blobs`,
        { content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' },
        { headers }
      );
      blobEntries.push({
        path,
        mode: '100644',
        type: 'blob',
        sha: blobResp.data.sha,
      });
    }

    if (deletions.length === 0 && blobEntries.length === 0) {
      throw new Error('NOTHING_TO_COMMIT');
    }

    const newTreeResp = await axios.post<{ sha: string }>(
      `https://api.github.com/repos/${owner}/${repo}/git/trees`,
      { base_tree: baseTreeSha, tree: [...deletions, ...blobEntries] },
      { headers }
    );

    if (newTreeResp.data.sha === baseTreeSha) {
      this.logger.log(
        `no-op commit skipped for ${owner}/${repo}@${branch} (tree unchanged) — ${message}`
      );
      return baseCommitSha;
    }

    const newCommitResp = await axios.post<{ sha: string }>(
      `https://api.github.com/repos/${owner}/${repo}/git/commits`,
      {
        message,
        tree: newTreeResp.data.sha,
        parents: [baseCommitSha],
        author: { ...BOT_AUTHOR, date: new Date().toISOString() },
      },
      { headers }
    );

    await axios.patch(
      `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`,
      { sha: newCommitResp.data.sha },
      { headers }
    );

    this.logger.log(
      `committed ${blobEntries.length} files (${deletions.length} deletions) to ${owner}/${repo}@${branch}: ${newCommitResp.data.sha.slice(0, 7)} — ${message}`
    );
    return newCommitResp.data.sha;
  }

  /** Lists GHCR container package versions for a user-owned package, using
   * the App installation token of the source repo. Spike on 2026-05-21
   * confirmed the App's metadata:read scope is sufficient — packages:read
   * is *not* required for user-owned containers when the App is installed
   * on the package's source repo. Returns null when the token can't see
   * the package (org-owned packages or App not installed on source repo). */
  async listUserPackageVersions(args: {
    owner: string;
    packageName: string;
    token: string;
    perPage?: number;
  }): Promise<GhcrPackageVersion[] | null> {
    const { owner, packageName, token, perPage = 30 } = args;
    try {
      const resp = await axios.get<GhcrPackageVersion[]>(
        `https://api.github.com/users/${owner}/packages/container/${encodeURIComponent(packageName)}/versions`,
        {
          headers: this.installationAuthHeaders(token),
          params: { per_page: perPage },
        }
      );
      return resp.data;
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404 || status === 403) {
        // 404: package doesn't exist or token can't see it.
        // 403: org-owned package needing different scope. Caller falls back.
        return null;
      }
      throw err;
    }
  }
}
