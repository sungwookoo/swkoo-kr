jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));
import axios from 'axios';
import { DeployStatusService } from './deploy-status.service';

const sha = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const image = `ghcr.io/alice/app:latest@${digest}`;

describe('Deployment status evidence chain', () => {
  let service: DeployStatusService;
  let app: any;
  let deployment: any;
  let pod: any;
  let run: any;
  let liveStatus: number;
  let versions: any[];
  let kube: any;

  beforeEach(() => {
    jest.clearAllMocks();
    run = { id: 1, status: 'completed', conclusion: 'success', head_sha: sha,
      event: 'push', html_url: 'https://github.com/alice/app/actions/runs/1' };
    app = { metadata: { name: 'swkoo-user-alice' }, spec: { source: { kustomize: { images: [image] } } },
      status: { sync: { status: 'Synced', comparedTo: { source: { kustomize: { images: [image] } } } },
        health: { status: 'Healthy' }, operationState: { phase: 'Succeeded' }, summary: { images: [image] } } };
    deployment = { metadata: { generation: 2 }, spec: { replicas: 1, template: { spec: { containers: [{ name: 'app', image }] } } },
      status: { observedGeneration: 2, updatedReplicas: 1, availableReplicas: 1 } };
    pod = { metadata: {}, spec: { containers: [{ name: 'app', image }] }, status: {
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [{ name: 'app', ready: true, imageID: 'containerd://child-manifest', state: { running: {} } }] } };
    versions = [{ name: digest, metadata: { container: { tags: [sha] } } }];
    liveStatus = 200;
    kube = { apps: { readNamespacedDeployment: jest.fn(async () => deployment) },
      core: { listNamespacedPod: jest.fn(async () => ({ items: [pod] })) } };
    service = new DeployStatusService(
      { getValidAccessToken: async () => 'test' } as never,
      { getInstallationTokenForRepo: async () => 'test', listUserPackageVersions: async () => versions } as never,
      { getApplication: async () => app } as never, kube,
      { manifestRepo: 'operator/manifests', manifestBranch: 'main' } as never);
    (axios.get as jest.Mock).mockImplementation(async (url: string) => {
      if (url.includes('/contents/')) return { data: { content: '' } };
      if (url === 'https://api.github.com/repos/alice/app') return { data: { default_branch: 'master' } };
      if (url.endsWith('/commits/master')) return { data: { sha } };
      if (url.endsWith('/actions/workflows/build.yml/runs')) return { data: { workflow_runs: [run] } };
      if (url.endsWith('/jobs')) return { data: { jobs: [] } };
      if (url === 'https://app.example') return { status: liveStatus };
      throw new Error(`Unexpected URL: ${url}`);
    });
  });

  const stages = () => service.getStages(1, 'alice', 'app', 'https://app.example');
  it('verifies the default branch, exact commit, workflow, image and ready runtime', async () => {
    expect(Object.values(await stages()).every((s) => s.status === 'success')).toBe(true);
    expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/workflows/build.yml/runs'),
      expect.objectContaining({ params: { branch: 'master', head_sha: sha, per_page: 10 } }));
  });
  it.each(['failure', 'cancelled'])('does not accept the previous healthy app after a %s build', async (conclusion) => {
    run.conclusion = conclusion;
    const result = await stages();
    expect(result.build.status).toBe('failed');
    expect(result.live.status).toBe('pending');
    expect(kube.core.listNamespacedPod).not.toHaveBeenCalled();
  });
  it('does not accept a workflow for an older commit', async () => {
    run.head_sha = 'old';
    expect((await stages()).build.status).toBe('pending');
  });
  it('does not accept a pull request workflow', async () => {
    run.event = 'pull_request';
    expect((await stages()).build.status).toBe('pending');
  });
  it('does not accept an unrelated repository image', async () => {
    app.spec.source.kustomize.images = [image.replace('alice/app', 'alice/old')];
    expect((await stages()).imageDetected.status).toBe('pending');
  });
  it('requires registry evidence linking the source commit to the digest', async () => {
    versions = [];
    expect((await stages()).imageDetected.status).toBe('pending');
  });
  it('rejects stale Argo comparison even while Healthy', async () => {
    app.status.sync.comparedTo.source.kustomize.images = [];
    expect((await stages()).deploy.status).toBe('running');
  });
  it.each(['ImagePullBackOff', 'CrashLoopBackOff'])('reports %s before Argo becomes Degraded', async (reason) => {
    app.status.health.status = 'Progressing';
    pod.status.containerStatuses[0].state = { waiting: { reason } };
    expect((await stages()).deploy.reason).toBe('POD_NOT_READY');
  });
  it('waits for the current Deployment generation and ready pods', async () => {
    deployment.status.observedGeneration = 1;
    expect((await stages()).deploy.status).toBe('running');
    deployment.status.observedGeneration = 2;
    pod.status.containerStatuses[0].ready = false;
    expect((await stages()).deploy.status).toBe('running');
  });
  it('does not treat a terminating pod as a ready replacement', async () => {
    pod.metadata.deletionTimestamp = new Date().toISOString();
    expect((await stages()).deploy.status).toBe('running');
  });
  it('reports an application HTTP failure after successful rollout', async () => {
    liveStatus = 500;
    const result = await stages();
    expect(result.deploy.status).toBe('success');
    expect(result.live.reason).toBe('LIVE_HEALTHCHECK_FAILED');
  });
  it('does not report success when runtime access is unavailable', async () => {
    kube.core.listNamespacedPod.mockRejectedValue(new Error('Forbidden'));
    expect((await stages()).deploy.status).toBe('running');
  });
});
