import { firstValueFrom, of, Subject, throwError } from 'rxjs';
import { AccountMutationInterceptor } from './account-mutation.interceptor';

describe('account mutation exclusion', () => {
  const ctx = (id: number, path = '/api/deploy/register', method = 'POST') => ({
    switchToHttp: () => ({ getRequest: () => ({ user: { id }, path, method }) }),
  } as any);
  it('blocks duplicate requests and delete/env/domain changes until registration settles', async () => {
    const guard = new AccountMutationInterceptor(), pending = new Subject<string>();
    const first = firstValueFrom(guard.intercept(ctx(1), { handle: () => pending }));
    for (const [path, method] of [['/api/deploy/register','POST'], ['/api/deploy','DELETE'],
      ['/api/account','DELETE'], ['/API/ACCOUNT/','DELETE'], ['/DEPLOY/REGISTER/','POST'], ['/api/deploy/env/alice/app','PUT'], ['/api/deploy/domain/alice/app','POST']]) {
      const handle = jest.fn(() => of('wrong'));
      expect(() => guard.intercept(ctx(1, path, method), { handle })).toThrow('처리 중');
      expect(handle).not.toHaveBeenCalled();
    }
    pending.next('ok'); expect(await first).toBe('ok');
    expect(await firstValueFrom(guard.intercept(ctx(1), { handle: () => of('retry') }))).toBe('retry');
  });
  it('allows reads and independent account changes but serializes shared registration writes', async () => {
    const guard = new AccountMutationInterceptor(), pending = new Subject<string>();
    const first = firstValueFrom(guard.intercept(ctx(1), { handle: () => pending }));
    expect(await firstValueFrom(guard.intercept(ctx(1, '/api/deploy/current', 'GET'), { handle: () => of('read') }))).toBe('read');
    expect(await firstValueFrom(guard.intercept(ctx(2, '/api/deploy/env/bob/app', 'PUT'), { handle: () => of('other') }))).toBe('other');
    expect(() => guard.intercept(ctx(2), { handle: () => of('wrong') })).toThrow('처리 중');
    pending.next('ok'); await first;
  });
  it('retains exclusion if the response subscriber disconnects', async () => {
    const guard = new AccountMutationInterceptor(), pending = new Subject<string>();
    const subscription = guard.intercept(ctx(1), { handle: () => pending }).subscribe(); subscription.unsubscribe();
    expect(() => guard.intercept(ctx(1), { handle: () => of('wrong') })).toThrow('처리 중');
    pending.next('ok'); await Promise.resolve(); await Promise.resolve();
    expect(await firstValueFrom(guard.intercept(ctx(1), { handle: () => of('done') }))).toBe('done');
  });
  it('releases after synchronous or asynchronous failures', async () => {
    const guard = new AccountMutationInterceptor();
    await expect(firstValueFrom(guard.intercept(ctx(1), { handle: () => { throw Error('sync'); } }))).rejects.toThrow('sync');
    await expect(firstValueFrom(guard.intercept(ctx(1), { handle: () => throwError(() => Error('async')) }))).rejects.toThrow('async');
    expect(await firstValueFrom(guard.intercept(ctx(1), { handle: () => of('retry') }))).toBe('retry');
  });
});
