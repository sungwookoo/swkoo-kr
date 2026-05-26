import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';

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
  constructor(private readonly service: DomainService) {}

  @Get(':login/:repo')
  async get(
    @Req() req: AuthedRequest,
    @Param('login') login: string,
    @Param('repo') repo: string
  ): Promise<DomainInfo> {
    this.assertOwn(req, login);
    return this.service.get(login.toLowerCase(), repo);
  }

  @Post(':login/:repo')
  async register(
    @Req() req: AuthedRequest,
    @Param('login') login: string,
    @Param('repo') repo: string,
    @Body() body: RegisterDomainDto
  ): Promise<DomainInfo> {
    this.assertOwn(req, login);
    return this.service.register({
      userId: req.user.id,
      login: login.toLowerCase(),
      repo,
      domain: body.domain,
    });
  }

  @Post(':login/:repo/verify')
  async verify(
    @Req() req: AuthedRequest,
    @Param('login') login: string,
    @Param('repo') repo: string
  ): Promise<DomainInfo> {
    this.assertOwn(req, login);
    return this.service.verify(login.toLowerCase(), repo);
  }

  @Delete(':login/:repo')
  @HttpCode(204)
  async remove(
    @Req() req: AuthedRequest,
    @Param('login') login: string,
    @Param('repo') repo: string
  ): Promise<void> {
    this.assertOwn(req, login);
    await this.service.delete(login.toLowerCase(), repo);
  }

  private assertOwn(req: AuthedRequest, login: string): void {
    if (req.user.githubLogin.toLowerCase() !== login.toLowerCase()) {
      throw new ForbiddenException({
        reason: 'NOT_OWNER',
        message: '본인 도메인만 관리할 수 있습니다.',
      });
    }
  }
}
