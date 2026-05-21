import type { ConfigType } from '@nestjs/config';

import type { pipelinesConfig } from '../config/pipelines.config';
import { PipelinesService } from './pipelines.service';
import { ProvenanceService } from './provenance.service';
import type { ArgoCdClient } from './services/argo-cd.client';
import type { GitHubClient } from './services/github.client';
import type { ArgoCdApplication } from './types/argo-cd.types';

/** Regression: hizieun drift case — annotation says
 *  `swkoo.kr/source-repo: hizieun/portfolio` but the actual deployed image
 *  is `ghcr.io/hizieun/my-arxiv`. Every downstream consumer must trust
 *  the image, not the annotation. Observed live on 2026-05-21; fixed in
 *  c976fe0 + 66f6dce; this test pins the behavior. */
describe('PipelinesService — hizieun annotation drift regression', () => {
  const driftedApplication: ArgoCdApplication = {
    metadata: {
      name: 'swkoo-user-hizieun',
      namespace: 'argocd',
      annotations: {
        // Stale — set at register time when source was named "portfolio".
        'swkoo.kr/source-repo': 'hizieun/portfolio',
      },
    },
    spec: {
      project: 'default',
      destination: { namespace: 'user-hizieun' },
      source: {
        // Per-user deploy repo (manifests only — no GHA workflow).
        repoURL: 'https://github.com/swkoo-deploy/hizieun.git',
        targetRevision: 'main',
        kustomize: {
          // Real image-updater output: a *different* repo from the annotation.
          images: [
            'ghcr.io/hizieun/my-arxiv:latest@sha256:63ee82c71496687c455436397ca0512d0876ee5e1e5116fb0dcc4113ce352527',
          ],
        },
      },
    },
    status: {
      sync: { status: 'Synced' },
      health: { status: 'Healthy' },
      summary: {
        images: [
          'ghcr.io/hizieun/my-arxiv:latest@sha256:63ee82c71496687c455436397ca0512d0876ee5e1e5116fb0dcc4113ce352527',
        ],
      },
      history: [
        {
          revision: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          deployedAt: '2026-05-21T06:04:30Z',
          source: {
            kustomize: {
              images: [
                'ghcr.io/hizieun/my-arxiv:latest@sha256:63ee82c71496687c455436397ca0512d0876ee5e1e5116fb0dcc4113ce352527',
              ],
            },
          },
        },
      ],
    },
  };

  function makeService(application: ArgoCdApplication) {
    const argo = {
      isConfigured: () => true,
      listApplications: jest.fn(async () => [application]),
      getApplication: jest.fn(async () => application),
    } as unknown as ArgoCdClient;

    const fetchWorkflows = jest.fn(async () => ({
      configured: true,
      repoUrl: 'https://github.com/hizieun/my-arxiv',
      workflows: ['Build and Push to GHCR'],
      runs: [],
      pagination: { page: 1, perPage: 10, total: 0 },
    }));
    const github = {
      isConfigured: () => true,
      fetchWorkflows,
      fetchWorkflowRunForSha: jest.fn(async () => null),
      fetchSuccessfulRunsWithin: jest.fn(async () => null),
      fetchCommit: jest.fn(async () => null),
    } as unknown as GitHubClient;

    const provenance = {
      resolve: jest.fn(async () => ({
        imageOwner: 'hizieun',
        imageName: 'my-arxiv',
        digest: 'sha256:63ee82c71496687c455436397ca0512d0876ee5e1e5116fb0dcc4113ce352527',
        sourceSha: 'd8d2bc2d8d2bc2d8d2bc2d8d2bc2d8d2bc2d8d2b',
        sourceRunUrl: 'https://github.com/hizieun/my-arxiv/actions/runs/1',
        method: 'gh_package_tag_digest' as const,
        evidence: 'gh_package_tag_digest',
        confidence: 'verified' as const,
      })),
    } as unknown as ProvenanceService;

    const pipelinesCfg = {
      baseUrl: 'https://argocd.swkoo.kr',
      cacheTtl: 15,
      projects: [],
    } as ConfigType<typeof pipelinesConfig>;

    const service = new PipelinesService(argo, github, provenance, pipelinesCfg);
    return { service, fetchWorkflows, github };
  }

  it('pipeline.repoUrl resolves to the deployed image repo (my-arxiv), not the annotation (portfolio)', async () => {
    const { service } = makeService(driftedApplication);

    const summary = await service.getPipeline('swkoo-user-hizieun');

    expect(summary.repoUrl).toBe('https://github.com/hizieun/my-arxiv.git');
    expect(summary.repoUrl).not.toContain('portfolio');
  });

  it('getWorkflows() queries my-arxiv on GitHub, not portfolio', async () => {
    const { service, fetchWorkflows } = makeService(driftedApplication);

    await service.getWorkflows('swkoo-user-hizieun');

    expect(fetchWorkflows).toHaveBeenCalledTimes(1);
    expect(fetchWorkflows).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'hizieun', repo: 'my-arxiv' })
    );
    // Belt-and-braces: explicitly assert we did NOT use the stale annotation repo.
    expect(fetchWorkflows).not.toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'portfolio' })
    );
  });

  it('falls back to annotation when no image has been deployed yet (pre-first-deploy)', async () => {
    // New user app — image-updater hasn't run, no kustomize.images yet.
    const preDeploy: ArgoCdApplication = {
      ...driftedApplication,
      spec: {
        ...driftedApplication.spec,
        source: {
          repoURL: 'https://github.com/swkoo-deploy/hizieun.git',
          targetRevision: 'main',
        },
      },
      status: { sync: { status: 'OutOfSync' }, health: { status: 'Missing' } },
    };
    const { service } = makeService(preDeploy);

    const summary = await service.getPipeline('swkoo-user-hizieun');

    // Annotation is our only hint here — *correct* to use it pre-first-deploy.
    expect(summary.repoUrl).toBe('https://github.com/hizieun/portfolio.git');
  });
});
