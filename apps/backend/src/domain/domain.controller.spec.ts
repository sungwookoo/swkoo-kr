jest.mock('@kubernetes/client-node', () => ({
  PatchStrategy: { MergePatch: 'merge-patch' },
  setHeaderOptions: jest.fn(),
}));

import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { CurrentDeployment, DeployService } from '../deploy/deploy.service';
import type { AuthedRequest } from '../onboarding/jwt-auth.guard';
import { DomainController } from './domain.controller';
import type { DomainService } from './domain.service';

function makeReq(overrides: Partial<{
  id: number;
  githubLogin: string;
  isAllowed: boolean;
}> = {}): AuthedRequest {
  return {
    user: {
      id: overrides.id ?? 1,
      githubLogin: overrides.githubLogin ?? 'alice',
      isAllowed: overrides.isAllowed ?? true,
    },
  } as unknown as AuthedRequest;
}

function makeCurrent(overrides: Partial<CurrentDeployment> = {}): CurrentDeployment {
  return {
    login: 'alice',
    repo: 'nextjs-sample',
    fullName: 'alice/nextjs-sample',
    appName: 'nextjs-sample',
    liveUrl: 'https://alice-nextjs-sample.apps.swkoo.kr',
    syncStatus: 'Synced',
    healthStatus: 'Healthy',
    state: 'active',
    ...overrides,
  };
}

function makeController(opts: {
  current?: CurrentDeployment | null;
  serviceImpl?: Partial<DomainService>;
} = {}) {
  const service = {
    get: jest.fn(async () => ({ domain: null })),
    register: jest.fn(async () => ({ domain: 'app.alice-example.com', status: 'pending' })),
    verify: jest.fn(async () => ({ status: 'applying' })),
    delete: jest.fn(async () => undefined),
    ...opts.serviceImpl,
  } as unknown as DomainService;
  const deploy = {
    getCurrentDeployment: jest.fn(async () => opts.current ?? null),
  } as unknown as DeployService;
  return { controller: new DomainController(service, deploy), service, deploy };
}

describe('DomainController — current-deployment binding guard', () => {
  it('403 NOT_OWNER when JWT login differs from route :login', async () => {
    const { controller } = makeController({ current: makeCurrent() });
    await expect(
      controller.get(makeReq({ githubLogin: 'hizieun' }), 'alice', 'nextjs-sample')
    ).rejects.toMatchObject({
      constructor: ForbiddenException,
      response: expect.objectContaining({ reason: 'NOT_OWNER' }),
    });
  });

  it('403 NOT_ALLOWED when user is not on the allowlist', async () => {
    const { controller, deploy } = makeController({ current: makeCurrent() });
    await expect(
      controller.get(makeReq({ isAllowed: false }), 'alice', 'nextjs-sample')
    ).rejects.toMatchObject({
      constructor: ForbiddenException,
      response: expect.objectContaining({ reason: 'NOT_ALLOWED' }),
    });
    // Guard must short-circuit before reading the deployment.
    expect(deploy.getCurrentDeployment).not.toHaveBeenCalled();
  });

  it('404 NO_DEPLOYMENT when user has no current deployment', async () => {
    const { controller, service } = makeController({ current: null });
    await expect(
      controller.get(makeReq(), 'alice', 'nextjs-sample')
    ).rejects.toMatchObject({
      constructor: NotFoundException,
      response: expect.objectContaining({ reason: 'NO_DEPLOYMENT' }),
    });
    // Guard must short-circuit before reaching the service.
    expect(service.get).not.toHaveBeenCalled();
  });

  it("404 NO_DEPLOYMENT when current deployment is in 'deleting' state", async () => {
    // ApplicationSet hasn't pruned yet but the registration file is gone.
    // Treat as no deployment — adding a domain to an app being torn down
    // would land a dangling Ingress.
    const { controller } = makeController({ current: makeCurrent({ state: 'deleting' }) });
    await expect(
      controller.get(makeReq(), 'alice', 'nextjs-sample')
    ).rejects.toMatchObject({
      response: expect.objectContaining({ reason: 'NO_DEPLOYMENT' }),
    });
  });

  it('409 REPO_NOT_CURRENT when route :repo differs from current deployment repo', async () => {
    // The user's current app is "nextjs-sample"; they're hitting
    // /api/deploy/domain/alice/fake-repo. Block to prevent bypassing
    // the per-user-app DB UNIQUE constraint by inventing a second
    // app_name out of thin air.
    const { controller, service } = makeController({ current: makeCurrent({ repo: 'nextjs-sample' }) });
    await expect(
      controller.register(
        makeReq(),
        'alice',
        'fake-repo',
        { domain: 'app.alice-example.com' }
      )
    ).rejects.toMatchObject({
      constructor: ConflictException,
      response: expect.objectContaining({ reason: 'REPO_NOT_CURRENT' }),
    });
    expect(service.register).not.toHaveBeenCalled();
  });

  it('happy path: allowlist OK + current matches → service called with the live deployment', async () => {
    const { controller, service } = makeController({
      current: makeCurrent({ liveUrl: 'https://alice-nextjs-sample.apps.swkoo.kr' }),
    });
    await controller.register(
      makeReq(),
      'alice',
      'nextjs-sample',
      { domain: 'app.alice-example.com' }
    );
    expect(service.register).toHaveBeenCalledWith({
      userId: 1,
      current: expect.objectContaining({
        appName: 'nextjs-sample',
        liveUrl: 'https://alice-nextjs-sample.apps.swkoo.kr',
      }),
      domain: 'app.alice-example.com',
    });
  });

  it('sanitizeName match treats case + special chars the same way the templates do', async () => {
    // Route repo `NextJS_Sample` and current.repo `NextJS_Sample` both
    // sanitize to "nextjs-sample". Should match. Catches a regression
    // where the guard used raw string equality.
    const { controller, service } = makeController({
      current: makeCurrent({ repo: 'NextJS_Sample', appName: 'nextjs-sample' }),
    });
    await controller.get(makeReq(), 'alice', 'NextJS_Sample');
    expect(service.get).toHaveBeenCalled();
  });
});
