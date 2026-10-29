import { DeploymentAdmissionService } from './deployment-admission.service';
const Gi = 1024 ** 3;
const sample = (value: number, metric: Record<string, string> = {}) => ({ metric, value: [Date.now() / 1000, String(value)] as [number, string] });
describe('deployment admission', () => {
  function setup() {
    const data = [
      [sample(4, { node: 'node', resource: 'cpu' }), sample(24 * Gi, { node: 'node', resource: 'memory' })],
      ['Ready','MemoryPressure','DiskPressure'].map(condition => sample(condition === 'Ready' ? 1 : 0, { node: 'node', condition })),
      [sample(1, { namespace: 'swkoo', pod: 'backend', resource: 'cpu' }), sample(Gi, { namespace: 'swkoo', pod: 'backend', resource: 'memory' })],
      [], [sample(.1)], [sample(.3)], [sample(12 * Gi)], [sample(10)], [sample(10)], [sample(10)], [sample(10)], [sample(10)], [sample(Gi)],
      [sample(130 * Gi)], [sample(10)], [sample(.8)], [sample(.9)], [sample(10)], [sample(Gi)],
    ];
    const reservations = new Map<string, number>();
    const users = { listAdmissionReservations: () => [...reservations].map(([login, createdAt]) => ({ login, createdAt })),
      reserveAdmission: jest.fn((login, at) => reservations.set(login, at)), releaseAdmissionReservation: jest.fn(login => reservations.delete(login)) };
    let i = 0;
    const metrics = { query: jest.fn(async () => data[(i++) % data.length]) };
    return { service: new DeploymentAdmissionService(metrics as any, users as any), users, metrics, reservations, data };
  }
  it('keeps a pending reservation and does not double count a retry', async () => {
    const s = setup(); await s.service.reserve('Alice'); await s.service.reserve('alice');
    expect([...s.reservations.keys()]).toEqual(['alice']);
  });
  it.each([[4, .7], [5, .7], [6, 5.99 * Gi], [7, 91], [8, 91], [9, 91], [10, 7], [11, 7]])('rejects threshold or stale/incomplete metric #%i', async (index, value) => {
    const s = setup(); s.data[index] = [sample(value)];
    await expect(s.service.reserve('alice')).rejects.toThrow(); expect(s.users.reserveAdmission).not.toHaveBeenCalled();
  });
  it('accounts for outstanding registrations before any pod is visible', async () => {
    const s = setup(); s.data[0][0] = sample(2.3, { node: 'node', resource: 'cpu' });
    await s.service.reserve('alice');
    await expect(s.service.reserve('bob')).rejects.toThrow('여유가 부족');
    expect([...s.reservations.keys()]).toEqual(['alice']);
  });
  it('uses maximum init requests and sums application containers', async () => {
    const s = setup(); s.data[3] = [sample(3, { namespace: 'swkoo', pod: 'backend', resource: 'cpu' })];
    await expect(s.service.reserve('alice')).rejects.toThrow('여유가 부족');
  });
  it('reserves 4Gi memory headroom and a replacement slot', async () => {
    const s = setup(); s.data[0][1] = sample(5.49 * Gi, { node: 'node', resource: 'memory' });
    await expect(s.service.reserve('alice')).rejects.toThrow('여유가 부족');
  });
  it('does not reallocate unfilled existing PVC storage and rejects missing storage metrics', async () => {
    const s = setup(); s.data[12] = [sample(125 * Gi)];
    await expect(s.service.reserve('alice')).rejects.toThrow('여유가 부족');
    s.data[12] = [];
    await expect(s.service.reserve('alice')).rejects.toThrow('확인하지 못해');
    expect(s.users.reserveAdmission).not.toHaveBeenCalled();
  });
  it('reconciles a reservation only when its namespace is included in the request snapshot', async () => {
    const s = setup(); s.reservations.set('bob', Date.now() - 1000);
    s.data[2].push(sample(.1, { namespace: 'user-bob', pod: 'app', resource: 'cpu' }));
    await s.service.reserve('alice'); expect(s.users.releaseAdmissionReservation).toHaveBeenCalledWith('bob');
  });
  it('refuses leftover namespaces, node pressure, missing values and multi-node ambiguity', async () => {
    for (const change of [
      (s: ReturnType<typeof setup>) => s.data[2].push(sample(.1, { namespace: 'user-alice', pod: 'old', resource: 'cpu' })),
      (s: ReturnType<typeof setup>) => s.data[1][1].value[1] = '1',
      (s: ReturnType<typeof setup>) => s.data[6] = [],
      (s: ReturnType<typeof setup>) => s.data[0].push(sample(4, { node: 'another', resource: 'cpu' })),
    ]) {
      const s = setup(); change(s); await expect(s.service.reserve('alice')).rejects.toThrow(); expect(s.users.reserveAdmission).not.toHaveBeenCalled();
    }
  });
  it('does not admit on a monitoring failure', async () => {
    const s = setup(); s.metrics.query.mockRejectedValue(Error('unavailable'));
    await expect(s.service.reserve('alice')).rejects.toThrow(); expect(s.users.reserveAdmission).not.toHaveBeenCalled();
  });
  it.each([[13, 5 * Gi], [14, 91], [15, .09], [16, .09], [17, 91], [18, 7 * Gi]])('rejects storage headroom, inode exhaustion or stale evidence #%i', async (index, value) => {
    const s = setup(); s.data[index] = [sample(value)];
    await expect(s.service.reserve('alice')).rejects.toThrow();
    expect(s.users.reserveAdmission).not.toHaveBeenCalled();
  });
  it('uses the separate data disk for PVC budgets and fails closed on its missing metrics', async () => {
    const s = setup(); s.data[12] = [sample(20 * Gi)];
    await expect(s.service.reserve('alice')).resolves.toBeUndefined();
    s.data[13] = [];
    await expect(s.service.reserve('bob')).rejects.toThrow('확인하지 못해');
  });
});
