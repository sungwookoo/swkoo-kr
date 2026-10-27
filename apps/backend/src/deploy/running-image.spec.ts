import { runningImage } from './running-image';

describe('running image identity', () => {
  const pod = (digest: string) => ({ metadata: {}, spec: { containers: [{ name: 'app', image: 'ghcr.io/user/app:latest' }] },
    status: { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, imageID: `docker-pullable://ghcr.io/user/app@sha256:${digest.repeat(64)}` }] } } as any);
  it('uses the runtime digest instead of a mutable tag', () => {
    expect(runningImage([pod('a')], 'app')).toBe(`ghcr.io/user/app@sha256:${'a'.repeat(64)}`);
  });
  it('does not label mixed, missing or unready images as current', () => {
    expect(runningImage([pod('a'), pod('b')], 'app')).toBeNull();
    expect(runningImage([], 'app')).toBeNull();
    const unready = pod('a'); unready.status.containerStatuses[0].ready = false;
    expect(runningImage([unready], 'app')).toBeNull();
  });
});
