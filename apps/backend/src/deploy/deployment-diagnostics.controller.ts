import { BadRequestException, Controller, Get, Header, Param, Query, Req, UseGuards } from '@nestjs/common';
import { AuthedRequest, JwtAuthGuard } from '../onboarding/jwt-auth.guard';
import { DeploymentDiagnosticsService } from './deployment-diagnostics.service';

@Controller('deploy/diagnostics')
@UseGuards(JwtAuthGuard)
export class DeploymentDiagnosticsController {
  constructor(private readonly service: DeploymentDiagnosticsService) {}

  @Get(':login/:repo')
  @Header('Cache-Control', 'no-store')
  get(@Req() req: AuthedRequest, @Param('login') login: string, @Param('repo') repo: string, @Query('logs') logs?: string) {
    if (logs !== undefined && logs !== '1') throw new BadRequestException('잘못된 로그 조회 요청입니다.');
    return this.service.get(req.user, login, repo, logs === '1');
  }
}
