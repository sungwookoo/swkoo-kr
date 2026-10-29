jest.mock('../kube/kube.client', () => ({ KubeClient: class {} }));
jest.mock('./deploy.service', () => ({ DeployService: class {} }));
import { DeploymentRecoveryService } from './deployment-recovery.service';

describe('administrator reservation recovery', () => {
  function setup() {
    const deploy = { getRecoveryRegistrationState: jest.fn().mockResolvedValue({ registration: false, application: false }) };
    const core = { readNamespace: jest.fn().mockRejectedValue({ code: 404 }), listPersistentVolume: jest.fn().mockResolvedValue({ items: [] }) };
    const users = { listAdmissionReservations: jest.fn(() => [{ login: 'alice', createdAt: 123 }]), recoverAdmissionReservation: jest.fn(() => true) };
    return { deploy, core, users, service: new DeploymentRecoveryService(deploy as any, { core } as any, users as any) };
  }
  it('is read-only on inspection and releases only the same reviewed reservation', async () => {
    const s = setup(), plan = await s.service.inspect('Alice');
    expect(plan.canRelease).toBe(true); expect(s.users.recoverAdmissionReservation).not.toHaveBeenCalled();
    await expect(s.service.release('alice', plan.digest, 'admin')).resolves.toEqual({ ok: true, login: 'alice' });
    expect(s.users.recoverAdmissionReservation).toHaveBeenCalledWith('alice', 123, 'admin');
  });
  it.each(['registration', 'application', 'namespace', 'volume'])('never releases with leftover %s', async kind => {
    const s = setup(), plan = await s.service.inspect('alice');
    if (kind === 'registration' || kind === 'application') s.deploy.getRecoveryRegistrationState.mockResolvedValue({ registration: kind === 'registration', application: kind === 'application' });
    if (kind === 'namespace') s.core.readNamespace.mockResolvedValue({} as never);
    if (kind === 'volume') s.core.listPersistentVolume.mockResolvedValue({ items: [{ spec: { claimRef: { namespace: 'user-alice' } }, status: { phase: 'Released' } }] });
    await expect(s.service.release('alice', plan.digest, 'admin')).rejects.toThrow();
    expect(s.users.recoverAdmissionReservation).not.toHaveBeenCalled();
  });
  it('fails closed on Git, Argo, Kubernetes authorization and transport failures', async () => {
    for (const dependency of ['git', 'namespace', 'volume']) {
      const s = setup();
      (dependency === 'git' ? s.deploy.getRecoveryRegistrationState : dependency === 'namespace' ? s.core.readNamespace : s.core.listPersistentVolume).mockRejectedValue({ code: 403 });
      await expect(s.service.inspect('alice')).rejects.toThrow('확인하지 못했습니다');
      expect(s.users.recoverAdmissionReservation).not.toHaveBeenCalled();
    }
  });
  it('rejects changed reservations, stale digests, disappeared rows and invalid/anonymized names', async () => {
    const s = setup(), plan = await s.service.inspect('alice');
    s.users.listAdmissionReservations.mockReturnValue([{ login: 'alice', createdAt: 456 }]);
    await expect(s.service.release('alice', plan.digest, 'admin')).rejects.toThrow();
    s.users.listAdmissionReservations.mockReturnValue([]);
    await expect(s.service.release('alice', plan.digest, 'admin')).rejects.toThrow();
    for (const login of ['../alice', 'deleted_1', '-alice', 'a'.repeat(40)]) await expect(s.service.inspect(login)).rejects.toThrow();
    expect(s.users.recoverAdmissionReservation).not.toHaveBeenCalled();
  });
  it('ignores another tenant PV but never releases on an atomic reservation mismatch', async () => {
    const s = setup(); s.core.listPersistentVolume.mockResolvedValue({ items: [{ spec: { claimRef: { namespace: 'user-bob' } } }] });
    const plan = await s.service.inspect('alice'); expect(plan.canRelease).toBe(true);
    s.users.recoverAdmissionReservation.mockReturnValue(false);
    await expect(s.service.release('alice', plan.digest, 'admin')).rejects.toThrow('바뀌었습니다');
  });
});
