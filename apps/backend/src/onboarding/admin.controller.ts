import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { onboardingConfig } from '../config/onboarding.config';

import { AdminGuard } from './admin.guard';
import { AuthedRequest, JwtAuthGuard } from './jwt-auth.guard';
import { UsersRepository } from './users.repository';
import { DeployPolicy, isDeployPolicy, resolveDeployPolicy } from './deploy-policy';

interface AdminUserView {
  githubLogin: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  createdAt: string;
  lastLoginAt: string;
  isAllowed: boolean;
  deployPolicy: DeployPolicy;
}

interface PatchUserBody {
  isAllowed?: unknown;
}

@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly users: UsersRepository,
    @Inject(onboardingConfig.KEY) private readonly config: ConfigType<typeof onboardingConfig>,
  ) {}

  @Get('users')
  @Header('Cache-Control', 'private, no-store')
  listUsers(): { users: AdminUserView[] } {
    const rows = this.users.listAllUsers();
    return {
      users: rows.map((u) => ({
        githubLogin: u.githubLogin,
        name: u.name,
        email: u.email,
        avatarUrl: u.avatarUrl,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
        isAllowed: u.isAllowed,
        deployPolicy: resolveDeployPolicy(u.deployPolicy, this.isAdmin(u.githubLogin)),
      })),
    };
  }

  @Patch('users/:login/deploy-policy')
  patchDeployPolicy(@Param('login') login: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    if (!isDeployPolicy(body)) {
      throw new BadRequestException('최대 앱 수는 0 이상의 정수(기본값은 비워 두기), CPU는 100~4000m, 메모리는 256~8192MiB로 입력해 주세요.');
    }
    const { maxApps, cpuMillicores, memoryMiB } = body;
    const policy = { maxApps, cpuMillicores, memoryMiB };
    if (!this.users.setDeployPolicy(login, policy, req.user.githubLogin)) {
      throw new NotFoundException('사용자를 찾을 수 없습니다.');
    }
    return { ok: true, deployPolicy: resolveDeployPolicy(policy, this.isAdmin(login)) };
  }

  private isAdmin(login: string): boolean {
    return this.config.adminLogins.some(admin => admin.toLowerCase() === login.toLowerCase());
  }

  @Patch('users/:login')
  patchUser(
    @Param('login') login: string,
    @Body() body: PatchUserBody,
    @Req() req: AuthedRequest
  ): { ok: true; login: string; isAllowed: boolean } {
    if (typeof body?.isAllowed !== 'boolean') {
      throw new BadRequestException({
        reason: 'INVALID_BODY',
        message: 'isAllowed boolean required',
      });
    }
    const updated = this.users.setAllowed(login, body.isAllowed);
    if (!updated) {
      throw new NotFoundException({
        reason: 'USER_NOT_FOUND',
        message: `no user with login ${login}`,
      });
    }
    this.users.audit({
      actor: req.user.githubLogin,
      action: body.isAllowed ? 'ALLOWLIST_GRANT' : 'ALLOWLIST_REVOKE',
      target: login,
      reason: null,
      metaJson: null,
    });
    return { ok: true, login, isAllowed: body.isAllowed };
  }
}
