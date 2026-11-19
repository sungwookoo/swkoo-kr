import { CallHandler, ConflictException, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { firstValueFrom, from, Observable } from 'rxjs';

/** Single backend replica with Recreate deployments. Hold through completion,
 * including after an HTTP client disconnects; never release on unsubscribe. */
@Injectable()
export class AccountMutationInterceptor implements NestInterceptor {
  private readonly active = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();

  async waitForCompletion(): Promise<void> {
    await Promise.allSettled(this.pending);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const path = req.path.toLowerCase().replace(/^\/api(?=\/)/, '').replace(/\/+$/, '');
    const recovery = /^\/admin\/deployment-recovery\/[^/]+\/release$/.test(path);
    const policyChange = req.method === 'PATCH' && /^\/admin\/users\/[^/]+\/deploy-policy$/.test(path);
    const appLifecycle = req.method === 'POST' && /^\/admin\/users\/[^/]+\/deployments\/[^/]+\/lifecycle$/.test(path);
    if (!req.user || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ||
        !(recovery || policyChange || appLifecycle || path.startsWith('/deploy/') || path === '/deploy' || (path === '/account' && req.method === 'DELETE'))) {
      return next.handle();
    }
    const keys = [`account:${req.user.id}`];
    if (req.user.githubLogin) keys.push(`login:${req.user.githubLogin.toLowerCase()}`);
    if (appLifecycle && req.params?.login) keys.push(`login:${req.params.login.toLowerCase()}`);
    // Different accounts share the registration Git branch; don't race commits
    // or capacity admission while a previous registration is still being saved.
    if (recovery || policyChange || appLifecycle || path === '/deploy/register' || path === '/deploy' || path.startsWith('/deploy/apps/') || path === '/account') keys.push('registration');
    if (keys.some(key => this.active.has(key))) {
      throw new ConflictException({ reason: 'OPERATION_IN_PROGRESS',
        message: '변경 작업을 처리 중입니다. 현재 상태를 확인하고 잠시 후 다시 시도해 주세요.' });
    }
    keys.forEach(key => this.active.add(key));
    const complete = async () => {
      try { return await firstValueFrom(next.handle()); }
      finally { keys.forEach(key => this.active.delete(key)); }
    };
    const operation = complete();
    this.pending.add(operation);
    const remove = () => { this.pending.delete(operation); };
    void operation.then(remove, remove);
    return from(operation);
  }
}
