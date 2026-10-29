import { Body, Controller, Get, Header, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../onboarding/admin.guard';
import { AuthedRequest, JwtAuthGuard } from '../onboarding/jwt-auth.guard';
import { UsersRepository } from '../onboarding/users.repository';
import { DeploymentRecoveryService } from './deployment-recovery.service';

@Controller('admin/deployment-recovery')
@UseGuards(JwtAuthGuard, AdminGuard)
export class DeploymentRecoveryController {
  constructor(private readonly recovery: DeploymentRecoveryService, private readonly users: UsersRepository) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list() { return { reservations: this.users.listAdmissionReservations() }; }

  @Get(':login')
  @Header('Cache-Control', 'no-store')
  inspect(@Param('login') login: string) { return this.recovery.inspect(login); }

  @Post(':login/release')
  @Header('Cache-Control', 'no-store')
  release(@Param('login') login: string, @Body() body: { digest?: unknown }, @Req() req: AuthedRequest) {
    return this.recovery.release(login, body?.digest, req.user.githubLogin);
  }
}
