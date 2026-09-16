import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Equals, IsString, IsUUID, Matches } from 'class-validator';
import { AuthedRequest, JwtAuthGuard } from '../onboarding/jwt-auth.guard';
import { PATCH_POLICY } from './security-patch.policy';
import { SecurityPatchService } from './security-patch.service';

class PreparePatchDto {
  @IsString() @Matches(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) repo!: string;
  @Equals(PATCH_POLICY) consent!: string;
}
class CreatePatchPrDto extends PreparePatchDto { @IsUUID() id!: string; }

@Controller('deploy/security-patch')
@UseGuards(JwtAuthGuard)
export class SecurityPatchController {
  constructor(private readonly service: SecurityPatchService) {}
  @Get()
  status(@Req() req: AuthedRequest, @Query('repo') repo: string = '') { return this.service.status(req.user, repo); }
  @Post('prepare')
  prepare(@Req() req: AuthedRequest, @Body() body: PreparePatchDto) { return this.service.prepare(req.user, body.repo, body.consent); }
  @Post('pr')
  createPr(@Req() req: AuthedRequest, @Body() body: CreatePatchPrDto) { return this.service.createPr(req.user, body.repo, body.id, body.consent); }
}
