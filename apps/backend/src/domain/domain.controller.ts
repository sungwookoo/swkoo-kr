import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
  forwardRef,
} from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';

import { CurrentDeployment, DeployService } from '../deploy/deploy.service';
import { sanitizeName } from '../deploy/templates';
import { AuthedRequest, JwtAuthGuard } from '../onboarding/jwt-auth.guard';
import { DomainInfo, DomainService } from './domain.service';

class RegisterDomainDto {
  @IsString()
  @MaxLength(253)
  domain!: string;
}

@Controller('deploy/domain')
@UseGuards(JwtAuthGuard)
export class DomainController {
  constructor(
    private readonly service: DomainService,
    // forwardRef matches the module-level cycle declared between
    // DeployModule and DomainModule.
    @Inject(forwardRef(() => DeployService))
    private readonly deploy: DeployService
  ) {}

  @Get(':login/:repo')
  async get(
    @Req() req: AuthedRequest,
    @Param('login') login: string,
    @Param('repo') repo: string
  ): Promise<DomainInfo> {
    const current = await this.resolveCurrentDeployment(req, login, repo);
    return this.service.get(login.toLowerCase(), current);
  }

  @Post(':login/:repo')
  async register(
    @Req() req: AuthedRequest,
    @Param('login') login: string,
    @Param('repo') repo: string,
    @Body() body: RegisterDomainDto
  ): Promise<DomainInfo> {
    const current = await this.resolveCurrentDeployment(req, login, repo);
    return this.service.register({
      userId: req.user.id,
      current,
      domain: body.domain,
    });
  }

  @Post(':login/:repo/verify')
  async verify(
    @Req() req: AuthedRequest,
    @Param('login') login: string,
    @Param('repo') repo: string
  ): Promise<DomainInfo> {
    const current = await this.resolveCurrentDeployment(req, login, repo);
    return this.service.verify(current);
  }

  @Delete(':login/:repo')
  @HttpCode(204)
  async remove(
    @Req() req: AuthedRequest,
    @Param('login') login: string,
    @Param('repo') repo: string
  ): Promise<void> {
    const current = await this.resolveCurrentDeployment(req, login, repo);
    await this.service.delete(current);
  }

  /** All custom-domain endpoints are bound to the user's *current* live
   * deployment. Gates:
   *   1. Owner match — JWT login must equal route :login (case-insensitive).
   *      Cross-user attempts (hizieun touching sungwookoo's domain) 403.
   *   2. Allowlist — only allowed users can manage domains. Prevents a
   *      stale OAuth session from a revoked user.
   *   3. Active deployment — there must be a current registration AND
   *      it must be in 'active' state (not 'deleting'). 404 NO_DEPLOYMENT
   *      otherwise. Guards against attempts to add a domain to a
   *      non-existent or torn-down app.
   *   4. Route ↔ current binding — the route :repo must sanitize to
   *      the same appName as the current deployment. 409 REPO_NOT_CURRENT
   *      otherwise. Blocks bypassing the per-user-app uniqueness DB
   *      constraint by claiming distinct fake repo names. */
  private async resolveCurrentDeployment(
    req: AuthedRequest,
    login: string,
    routeRepo: string
  ): Promise<CurrentDeployment> {
    if (req.user.githubLogin.toLowerCase() !== login.toLowerCase()) {
      throw new ForbiddenException({
        reason: 'NOT_OWNER',
        message: '본인 도메인만 관리할 수 있습니다.',
      });
    }
    if (req.user.isAllowed !== true) {
      throw new ForbiddenException({
        reason: 'NOT_ALLOWED',
        message: '도메인 관리 권한이 없습니다. 운영자에게 문의하세요.',
      });
    }
    const current = await this.deploy.getCurrentDeployment(req.user.githubLogin);
    if (!current || current.state !== 'active') {
      throw new NotFoundException({
        reason: 'NO_DEPLOYMENT',
        message: '활성 배포가 없습니다. 먼저 swkoo.kr/deploy 에서 앱을 배포하세요.',
      });
    }
    if (sanitizeName(current.repo) !== sanitizeName(routeRepo)) {
      throw new ConflictException({
        reason: 'REPO_NOT_CURRENT',
        message: `이 앱은 현재 배포된 앱(${current.repo})이 아닙니다. URL의 repo 부분을 확인하세요.`,
      });
    }
    return current;
  }
}
