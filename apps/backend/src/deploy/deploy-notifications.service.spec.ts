jest.mock('@kubernetes/client-node', () => ({
  PatchStrategy: { MergePatch: 'merge-patch' }, setHeaderOptions: jest.fn(),
}));
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));

import axios from 'axios';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsersRepository } from '../onboarding/users.repository';
import type { ArgoCdApplication } from '../pipelines/types/argo-cd.types';
import { DeployNotificationsService, readyImageDigest } from './deploy-notifications.service';

const digest = `sha256:${'a'.repeat(64)}`;
const image = `ghcr.io/alice/app:latest@${digest}`;
function readyApp(): ArgoCdApplication {
  return {
    metadata: { name: 'swkoo-user-alice' },
    spec: { project: 'default', source: { kustomize: { images: [image] } } },
    status: {
      sync: { status: 'Synced', comparedTo: { source: { kustomize: { images: [image] } } } },
      health: { status: 'Healthy' }, operationState: { phase: 'Succeeded' },
      summary: { images: [image] },
    },
  };
}

describe('readyImageDigest', () => {
  it('accepts the healthy synchronized image for this repository', () => {
    expect(readyImageDigest(readyApp(), 'alice', 'app')).toBe(digest);
    expect(readyImageDigest(readyApp(), 'bob', 'app')).toBeNull();
  });

  it.each(['Running', 'Failed', 'Error'])('rejects operation phase %s', (phase) => {
    const app = readyApp();
    app.status!.operationState!.phase = phase;
    expect(readyImageDigest(app, 'alice', 'app')).toBeNull();
  });

  it('rejects stale Healthy status after desired image changes', () => {
    const app = readyApp();
    app.spec.source!.kustomize!.images = [`ghcr.io/alice/app:latest@sha256:${'b'.repeat(64)}`];
    expect(readyImageDigest(app, 'alice', 'app')).toBeNull();
  });

  it('rejects missing or different observed images and unhealthy applications', () => {
    const app = readyApp();
    app.status!.summary!.images = [];
    expect(readyImageDigest(app, 'alice', 'app')).toBeNull();
    app.status!.summary!.images = [image];
    app.status!.health!.status = 'Degraded';
    expect(readyImageDigest(app, 'alice', 'app')).toBeNull();
  });
});

describe('background deploy notifications', () => {
  let directory: string;
  let users: UsersRepository;
  let userId: number;
  let service: DeployNotificationsService;
  const email = { enabled: jest.fn(), sendDeploySuccess: jest.fn() };
  const deploy = { getCurrentDeployment: jest.fn() };
  const argo = { getApplication: jest.fn() };

  function openRepository(): void {
    users = new UsersRepository({ dbPath: join(directory, 'test.sqlite') } as never);
    users.onModuleInit();
    service = new DeployNotificationsService(users, deploy as never, argo as never, email as never, { checkRuntime: jest.fn().mockResolvedValue({ status: 'success' }) } as never);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-09-15T00:00:00Z'));
    directory = mkdtempSync(join(tmpdir(), 'swkoo-notifications-'));
    openRepository();
    userId = users.upsertUser({ githubId: 1, githubLogin: 'alice',
      name: null, email: 'alice@example.com', avatarUrl: null }).id;
    users.setAllowed('alice', true);
    email.enabled.mockReturnValue(true);
    email.sendDeploySuccess.mockResolvedValue(true);
    deploy.getCurrentDeployment.mockResolvedValue({ login: 'alice', repo: 'app',
      liveUrl: 'https://alice-app.apps.swkoo.kr', state: 'active' });
    argo.getApplication.mockResolvedValue(readyApp());
    (axios.get as jest.Mock).mockResolvedValue({ status: 200 });
  });

  afterEach(() => {
    users.onModuleDestroy();
    rmSync(directory, { recursive: true, force: true });
    jest.useRealTimers();
  });

  it('sends without a browser request and suppresses repeated ticks', async () => {
    await service.notifyReadyDeployments();
    await service.notifyReadyDeployments();
    expect(email.sendDeploySuccess).toHaveBeenCalledTimes(1);
    expect(users.getLastNotifiedImageSha(userId)).toBe(digest);
    expect(users.listAuditByActor('alice')[0].action).toBe('DEPLOY_NOTIFY');
  });

  it('persists a failed delivery and retries with the same key and payload after restart', async () => {
    email.sendDeploySuccess.mockResolvedValueOnce(false);
    await service.notifyReadyDeployments();
    const firstCall = email.sendDeploySuccess.mock.calls[0];
    expect(users.getLastNotifiedImageSha(userId)).toBeNull();
    expect(users.listAuditByActor('alice')).toHaveLength(0);
    users.onModuleDestroy();
    openRepository();
    await service.notifyReadyDeployments();
    expect(email.sendDeploySuccess).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(5 * 60_000);
    await service.notifyReadyDeployments();
    expect(email.sendDeploySuccess.mock.calls[1]).toEqual(firstCall);
    expect(users.getLastNotifiedImageSha(userId)).toBe(digest);
  });

  it('does not retry an ambiguous delivery beyond the provider deduplication window', async () => {
    email.sendDeploySuccess.mockResolvedValue(false);
    await service.notifyReadyDeployments();
    jest.advanceTimersByTime(23 * 60 * 60_000);
    await service.notifyReadyDeployments();
    expect(email.sendDeploySuccess).toHaveBeenCalledTimes(1);
    expect(users.listAuditByActor('alice')[0].action).toBe('DEPLOY_NOTIFY_EXPIRED');
    expect(users.listDeployNotifications(userId)[0]).toEqual(expect.objectContaining({ state: 'expired' }));
  });

  it('does not send for a deleting deployment, unhealthy image, or failed URL', async () => {
    deploy.getCurrentDeployment.mockResolvedValueOnce({ state: 'deleting' });
    await service.notifyReadyDeployments();
    const unhealthy = readyApp();
    unhealthy.status!.health!.status = 'Progressing';
    argo.getApplication.mockResolvedValueOnce(unhealthy);
    await service.notifyReadyDeployments();
    (axios.get as jest.Mock).mockResolvedValueOnce({ status: 503 });
    await service.notifyReadyDeployments();
    expect(email.sendDeploySuccess).not.toHaveBeenCalled();
  });

  it('removes pending email data on account deletion and never retries it', async () => {
    email.sendDeploySuccess.mockResolvedValue(false);
    await service.notifyReadyDeployments();
    users.softDeleteUser(userId);
    jest.advanceTimersByTime(5 * 60_000);
    await service.notifyReadyDeployments();
    expect(users.listDeployNotifications(userId)).toEqual([]);
    expect(email.sendDeploySuccess).toHaveBeenCalledTimes(1);
  });

  it('respects legacy sent digests and disabled email configuration', async () => {
    email.enabled.mockReturnValueOnce(false);
    await service.notifyReadyDeployments();
    expect(deploy.getCurrentDeployment).not.toHaveBeenCalled();
    users.setLastNotifiedImageSha(userId, digest);
    await service.notifyReadyDeployments();
    expect(email.sendDeploySuccess).not.toHaveBeenCalled();
  });

  it('prevents overlapping ticks from sending the same pending email', async () => {
    let complete!: (sent: boolean) => void;
    email.sendDeploySuccess.mockImplementationOnce(() => new Promise<boolean>((resolve) => { complete = resolve; }));
    const tick = service.notifyReadyDeployments();
    for (let i = 0; i < 10 && !complete; i++) await Promise.resolve();
    await service.notifyReadyDeployments();
    expect(email.sendDeploySuccess).toHaveBeenCalledTimes(1);
    complete(true);
    await tick;
  });
});
