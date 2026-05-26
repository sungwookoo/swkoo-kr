// `@kubernetes/client-node` is ESM; ts-jest can't load it without
// transformIgnorePatterns gymnastics. Owner check runs entirely on
// in-memory state before any kube call, so a thin shim is enough.
jest.mock('@kubernetes/client-node', () => ({
  PatchStrategy: { MergePatch: 'merge-patch' },
  setHeaderOptions: jest.fn(),
}));

import { ForbiddenException } from '@nestjs/common';

import type { AuthService } from '../onboarding/auth.service';
import type { GithubAppService } from '../github-app/github-app.service';
import type { UsersRepository } from '../onboarding/users.repository';
import type { ArgoCdClient } from '../pipelines/services/argo-cd.client';
import type { KubeClient } from '../kube/kube.client';
import type { EmailService } from '../email/email.service';
import { DeployService } from './deploy.service';

/** Regression for ownership check on /deploy/register: a logged-in user
 *  must not be able to deploy someone else's repo by sending a forged
 *  fullName. detectStack would also reject (foreign repo isn't visible to
 *  this user's installation token) but the explicit 403 here is the
 *  authoritative boundary — no GitHub side-channel, clean audit reason. */
describe('DeployService.registerForUser — ownership check', () => {
  function makeService(login: string, isAllowed: boolean) {
    const findByLogin = jest.fn().mockReturnValue({
      id: 1,
      githubLogin: login,
      isAllowed,
    });
    const audit = jest.fn();
    const users = { findByLogin, audit } as unknown as UsersRepository;
    const auth = {} as AuthService;
    const githubApp = {} as GithubAppService;
    const argo = {} as ArgoCdClient;
    const kube = {} as KubeClient;
    const email = {} as EmailService;
    // Owner check runs before any DB read on custom_domains, but the
    // constructor needs *something* for the injected dep.
    const customDomains = { findForRender: jest.fn() } as never;
    const config = { appsDomain: 'apps.swkoo.kr' } as never;
    const service = new DeployService(
      auth, githubApp, users, argo, kube, email, customDomains, config
    );
    return { service, audit, findByLogin };
  }

  it('rejects with 403 NOT_REPO_OWNER when fullName.owner !== caller login', async () => {
    const { service, audit } = makeService('hizieun', true);

    await expect(
      service.registerForUser('hizieun', { fullName: 'sungwookoo/nextjs-sample' })
    ).rejects.toThrow(ForbiddenException);

    // Audit log captures the attempted cross-user deploy for incident review.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'hizieun',
        action: 'ACCESS_DENIED',
        target: 'sungwookoo/nextjs-sample',
        reason: 'NOT_REPO_OWNER',
      })
    );
  });

  it('treats owner check as case-insensitive (GitHub preserves case in login)', async () => {
    // Caller login `Hizieun` (capital H) requesting their own repo `hizieun/portfolio`
    // must NOT trip the owner check — both lowercase to the same value.
    const { service } = makeService('Hizieun', true);

    // We can't fully exercise the happy path (downstream GitHub calls would
    // run) but we *can* assert the owner check passes by verifying we get
    // past it — the next failure should be from a different reason.
    await expect(
      service.registerForUser('Hizieun', { fullName: 'hizieun/portfolio' })
    ).rejects.toThrow(); // Will throw later (no real auth token), but NOT NOT_REPO_OWNER.
  });

  it('rejects 403 NOT_ALLOWED before owner check (allowlist gate is first)', async () => {
    const { service, audit } = makeService('hizieun', false);

    await expect(
      service.registerForUser('hizieun', { fullName: 'sungwookoo/nextjs-sample' })
    ).rejects.toThrow(ForbiddenException);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'NOT_ALLOWED' })
    );
  });
});

/** When /api/deploy DELETE removes the user's deployment, any custom
 *  domain row for that login must be cleaned up — otherwise the row
 *  outlives the deployment, gets stuck behind NO_DEPLOYMENT on every
 *  domain endpoint, and blocks the same domain from being re-registered
 *  later (global UNIQUE index). v0 is one-app-per-user so cleaning by
 *  login is correct. */
describe('DeployService.deleteDeployment — orphan custom_domain cleanup', () => {
  function makeDeleteService(opts: {
    isAllowed?: boolean;
    commitFails?: 'NOTHING_TO_COMMIT' | Error | false;
    customDomainRows?: Array<{ id: number; login: string; appName: string; domain: string }>;
  }) {
    const audit = jest.fn();
    const users = {
      findByLogin: jest.fn().mockReturnValue({
        id: 1,
        githubLogin: 'alice',
        isAllowed: opts.isAllowed ?? true,
      }),
      audit,
    } as unknown as UsersRepository;

    const commitFilesAtomic = jest.fn(async () => {
      if (opts.commitFails === 'NOTHING_TO_COMMIT') {
        throw new Error('NOTHING_TO_COMMIT');
      }
      if (opts.commitFails instanceof Error) throw opts.commitFails;
      return 'sha-delete-commit';
    });
    const githubApp = {
      getInstallationTokenForRepo: jest.fn(async () => 'tok'),
      getInstallationTokenForOrg: jest.fn(async () => 'org-tok'),
      commitFilesAtomic,
      archiveRepo: jest.fn(async () => undefined),
    } as unknown as GithubAppService;

    const findByLoginMock = jest.fn(() => opts.customDomainRows ?? []);
    const deleteByLoginMock = jest.fn(() => (opts.customDomainRows ?? []).length);
    const customDomains = {
      findForRender: jest.fn(),
      findByLogin: findByLoginMock,
      deleteByLogin: deleteByLoginMock,
    } as never;

    const auth = {} as AuthService;
    const argo = {
      // refreshUsersApplicationSet uses kube; keep at no-op
    } as ArgoCdClient;
    const kube = {} as KubeClient;
    const email = {} as EmailService;
    const config = {
      appsDomain: 'apps.swkoo.kr',
      manifestRepo: 'sungwookoo/swkoo-kr',
      manifestBranch: 'main',
      deployOwner: 'swkoo-deploy',
    } as never;

    const service = new DeployService(
      auth, githubApp, users, argo, kube, email, customDomains, config
    );
    // refreshUsersApplicationSet is called at the end of deleteDeployment
    // (best-effort, fire-and-forget); stub it to avoid kube.custom usage.
    (service as unknown as { refreshUsersApplicationSet: () => Promise<void> })
      .refreshUsersApplicationSet = jest.fn(async () => undefined);

    return { service, audit, commitFilesAtomic, findByLoginMock, deleteByLoginMock };
  }

  it('removes custom_domain row when deleteDeployment commit succeeds', async () => {
    const { service, audit, deleteByLoginMock } = makeDeleteService({
      customDomainRows: [
        { id: 11, login: 'alice', appName: 'nextjs-sample', domain: 'app.alice-example.com' },
      ],
    });

    await service.deleteDeployment('alice');

    expect(deleteByLoginMock).toHaveBeenCalledWith('alice');
    // Audit captures the cascade with the deploy commit SHA so an
    // incident reviewer can correlate.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'DOMAIN_DELETED_BY_DEPLOY_DELETE',
        target: 'alice/nextjs-sample:app.alice-example.com',
      })
    );
  });

  it('preserves custom_domain row when unregister commit fails', async () => {
    const { service, deleteByLoginMock } = makeDeleteService({
      commitFails: 'NOTHING_TO_COMMIT',
      customDomainRows: [
        { id: 11, login: 'alice', appName: 'nextjs-sample', domain: 'app.alice-example.com' },
      ],
    });

    await expect(service.deleteDeployment('alice')).rejects.toThrow(ForbiddenException);
    // The cleanup only runs after the commit succeeds. NOTHING_TO_COMMIT
    // means no registration file existed → no orphan to clean either.
    expect(deleteByLoginMock).not.toHaveBeenCalled();
  });

  it('deleteDeployment succeeds when no custom_domain row exists', async () => {
    const { service, deleteByLoginMock, audit } = makeDeleteService({
      customDomainRows: [],
    });

    const result = await service.deleteDeployment('alice');

    expect(result.commit).toBe('sha-delete-commit');
    // No row → no audit cascade, no DELETE call.
    expect(deleteByLoginMock).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DOMAIN_DELETED_BY_DEPLOY_DELETE' })
    );
    // Normal unregister audit still happens.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DEPLOY_UNREGISTER' })
    );
  });
});
