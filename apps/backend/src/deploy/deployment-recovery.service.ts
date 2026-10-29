import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { KubeClient } from '../kube/kube.client';
import { UsersRepository } from '../onboarding/users.repository';
import { DeployService } from './deploy.service';

@Injectable()
export class DeploymentRecoveryService {
  constructor(private readonly deploy: DeployService, private readonly kube: KubeClient, private readonly users: UsersRepository) {}

  async inspect(rawLogin: string) {
    const login = rawLogin.toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(login)) throw new BadRequestException('GitHub 로그인 이름을 입력해 주세요. 익명화된 예약은 자동 복구할 수 없습니다.');
    if (!this.kube.core) throw new ServiceUnavailableException('클러스터 상태를 확인할 수 없습니다.');
    try {
      const namespace = `user-${login}`;
      const [git, ns, volumes] = await Promise.all([
        this.deploy.getRecoveryRegistrationState(login),
        this.kube.core.readNamespace({ name: namespace }).then(() => true).catch(error => {
          if (error?.code === 404 || error?.statusCode === 404 || error?.response?.statusCode === 404) return false;
          throw error;
        }),
        this.kube.core.listPersistentVolume(),
      ]);
      // Includes Released/Failed PVs, not only bound claims. Never delete data.
      const persistentVolumes = volumes.items.filter(pv => pv.spec?.claimRef?.namespace === namespace).length;
      const reservation = this.users.listAdmissionReservations().find(row => row.login === login) ?? null;
      const state = { login, reservation, registration: git.registration, application: git.application, namespace: ns, persistentVolumes };
      const canRelease = Boolean(reservation && !git.registration && !git.application && !ns && persistentVolumes === 0);
      return { ...state, canRelease, digest: createHash('sha256').update(JSON.stringify(state)).digest('hex') };
    } catch {
      throw new ServiceUnavailableException({ reason: 'RECOVERY_UNVERIFIED', message: '복구 상태를 확인하지 못했습니다. 예약과 리소스를 그대로 유지합니다.' });
    }
  }

  async release(login: string, digest: unknown, actor: string) {
    const plan = await this.inspect(login);
    if (!plan.canRelease || typeof digest !== 'string' || digest !== plan.digest) {
      throw new ConflictException({ reason: 'RECOVERY_NOT_SAFE', message: '남은 리소스가 있거나 조회 이후 상태가 바뀌었습니다. 다시 조회해 주세요.' });
    }
    if (!this.users.recoverAdmissionReservation(plan.login, plan.reservation!.createdAt, actor)) {
      throw new ConflictException('예약 상태가 바뀌었습니다. 다시 조회해 주세요.');
    }
    return { ok: true, login: plan.login };
  }
}
