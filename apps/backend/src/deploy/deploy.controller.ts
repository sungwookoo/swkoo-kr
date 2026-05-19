import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  InternalServerErrorException,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, Matches } from 'class-validator';

import { AuthedRequest, JwtAuthGuard } from '../onboarding/jwt-auth.guard';
import { UsersRepository } from '../onboarding/users.repository';
import {
  CurrentDeployment,
  DeploymentStatus,
  DeployService,
  RegisterResponse,
  RepoSummary,
  StackPreview,
} from './deploy.service';
import { EnvService } from './env.service';
import {
  subdomainErrorMessage,
  validateSubdomainFormat,
} from './subdomain';
import { sanitizeName } from './templates';

class RegisterDto {
  @IsString()
  @Matches(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, { message: 'fullName must match owner/name' })
  fullName!: string;

  // Optional user-chosen sub-slug. Omit/empty → backend keeps the user's
  // existing slug or falls back to `<login>-<repo>`. Format/reserved checks
  // run in the service; controller just enforces type.
  @IsOptional()
  @IsString()
  subdomain?: string;
}

@Controller('deploy')
@UseGuards(JwtAuthGuard)
export class DeployController {
  constructor(
    private readonly service: DeployService,
    private readonly envService: EnvService,
    private readonly users: UsersRepository
  ) {}

  /** Pre-submit availability check for a sub-slug. Cheap (format + reserved
   * + single SELECT) so safe to call on input blur from the deploy form.
   * Treats the requester's own current slug as available — re-deploying
   * with the same slug must not error. */
  @Get('subdomain/check')
  checkSubdomain(
    @Req() req: AuthedRequest,
    @Query('slug') slug: string | undefined
  ): { available: boolean; reason?: 'FORMAT' | 'RESERVED' | 'TAKEN'; message?: string } {
    if (!slug) {
      return { available: false, reason: 'FORMAT', message: subdomainErrorMessage('FORMAT') };
    }
    const normalized = slug.trim().toLowerCase();
    const format = validateSubdomainFormat(normalized);
    if (!format.ok) {
      return { available: false, reason: format.reason, message: subdomainErrorMessage(format.reason) };
    }
    const owner = this.users.findBySubdomain(normalized);
    if (owner && owner.id !== req.user.id) {
      return { available: false, reason: 'TAKEN', message: subdomainErrorMessage('TAKEN') };
    }
    return { available: true };
  }

  @Get('repos')
  listRepos(@Req() req: AuthedRequest): Promise<RepoSummary[]> {
    return this.service.listRepos(req.user.id);
  }

  @Get('preview')
  detectStack(
    @Req() req: AuthedRequest,
    @Query('repo') repo: string | undefined
  ): Promise<StackPreview> {
    if (!repo) {
      throw new BadRequestException('repo query param required (owner/name)');
    }
    const [owner, name] = repo.split('/');
    if (!owner || !name) {
      throw new BadRequestException('invalid repo format; expected owner/name');
    }
    return this.service.detectStack(req.user.id, owner, name);
  }

  @Post('register')
  register(
    @Req() req: AuthedRequest,
    @Body() body: RegisterDto
  ): Promise<RegisterResponse> {
    return this.service.registerForUser(req.user.githubLogin, body);
  }

  @Get('status/:login/:repo')
  getStatus(
    @Req() req: AuthedRequest,
    @Param('login') login: string,
    @Param('repo') repo: string
  ): Promise<DeploymentStatus> {
    return this.service.getDeploymentStatus(req.user.id, login, repo);
  }

  @Get('current')
  getCurrent(@Req() req: AuthedRequest): Promise<CurrentDeployment | null> {
    return this.service.getCurrentDeployment(req.user.githubLogin);
  }

  @Delete()
  @HttpCode(200)
  remove(@Req() req: AuthedRequest): Promise<{ commit: string }> {
    return this.service.deleteDeployment(req.user.githubLogin);
  }

  @Get('env/:login/:repo')
  async getEnv(
    @Req() req: AuthedRequest,
    @Param('login') login: string,
    @Param('repo') repo: string
  ): Promise<{ vars: Record<string, string> }> {
    this.assertOwnDeployment(req, login);
    const appName = sanitizeName(repo);
    try {
      const vars = await this.envService.getEnv(login, appName);
      return { vars };
    } catch (err) {
      this.translateKubeError(err);
    }
  }

  @Put('env/:login/:repo')
  @HttpCode(200)
  async setEnv(
    @Req() req: AuthedRequest,
    @Param('login') login: string,
    @Param('repo') repo: string,
    @Body() body: { vars?: Record<string, unknown> }
  ): Promise<{ ok: true; count: number }> {
    this.assertOwnDeployment(req, login);
    if (!body || typeof body.vars !== 'object' || body.vars === null) {
      throw new BadRequestException({
        reason: 'INVALID_BODY',
        message: 'vars must be a key-value object',
      });
    }
    const vars = body.vars as Record<string, unknown>;
    const totalSize = Object.entries(vars).reduce(
      (acc, [k, v]) => acc + k.length + (typeof v === 'string' ? v.length : 0),
      0
    );
    if (totalSize > 64_000) {
      throw new BadRequestException({
        reason: 'TOO_LARGE',
        message: 'total env size exceeds 64KB',
      });
    }
    const stringVars: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) {
      if (typeof v !== 'string') {
        throw new BadRequestException({
          reason: 'INVALID_VALUE',
          message: `value for ${k} must be a string`,
        });
      }
      if (k.length > 256 || v.length > 4096) {
        throw new BadRequestException({
          reason: 'INVALID_VALUE',
          message: `${k}: key max 256 chars, value max 4096`,
        });
      }
      stringVars[k] = v;
    }

    const appName = sanitizeName(repo);
    try {
      await this.envService.setEnv(login, appName, stringVars);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith('INVALID_KEY:')) {
        throw new BadRequestException({
          reason: 'INVALID_KEY',
          message: `유효하지 않은 키 '${msg.split(':')[1]}' (대문자/숫자/언더스코어, 첫 글자는 대문자 또는 언더스코어)`,
        });
      }
      this.translateKubeError(err);
    }
    return { ok: true, count: Object.keys(stringVars).length };
  }

  private assertOwnDeployment(req: AuthedRequest, login: string): void {
    if (login.toLowerCase() !== req.user.githubLogin.toLowerCase()) {
      throw new ForbiddenException({
        reason: 'NOT_YOURS',
        message: '본인 배포만 접근할 수 있습니다.',
      });
    }
  }

  private translateKubeError(err: unknown): never {
    const msg = (err as Error).message ?? '';
    if (msg === 'KUBE_NOT_AVAILABLE') {
      throw new InternalServerErrorException({
        reason: 'KUBE_NOT_AVAILABLE',
        message: '백엔드가 클러스터 안에서 실행 중이 아닙니다.',
      });
    }
    const status = (err as { code?: number; statusCode?: number }).code ??
      (err as { statusCode?: number }).statusCode;
    if (status === 403) {
      throw new ForbiddenException({
        reason: 'RBAC_MISSING',
        message:
          '사용자 namespace의 RBAC이 아직 적용되지 않았습니다. 한 번 재배포하시면 권한이 생성됩니다.',
      });
    }
    throw err;
  }
}
