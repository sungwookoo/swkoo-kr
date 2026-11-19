import { Body, Controller, Get, Header, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../onboarding/admin.guard';
import { AuthedRequest, JwtAuthGuard } from '../onboarding/jwt-auth.guard';
import { DeployService } from './deploy.service';

@Controller('admin/users/:login/deployments')
@UseGuards(JwtAuthGuard, AdminGuard)
export class DeploymentLifecycleController {
  constructor(private readonly deploy: DeployService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@Param('login') login: string) {
    return this.deploy.listAdminDeployments(login);
  }

  @Post(':key/lifecycle')
  @Header('Cache-Control', 'private, no-store')
  change(@Param('login') login: string, @Param('key') key: string,
    @Body() body: { action?: unknown; confirmation?: unknown }, @Req() req: AuthedRequest) {
    return this.deploy.changeDeploymentLifecycle(login, key, body?.action, body?.confirmation, req.user.githubLogin);
  }
}
