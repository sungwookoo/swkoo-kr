import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../onboarding/admin.guard';
import { JwtAuthGuard } from '../onboarding/jwt-auth.guard';
import { DeploymentAdmissionService } from './deployment-admission.service';

@Controller('admin/deployment-capacity')
@UseGuards(JwtAuthGuard, AdminGuard)
export class DeploymentCapacityController {
  constructor(private readonly admission: DeploymentAdmissionService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  capacity() {
    return this.admission.capacity();
  }
}
