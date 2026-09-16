import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
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
  async status(@Req() req: AuthedRequest, @Res() response: Response, @Query('repo') repo: string = '') {
    // Nest's default adapter sends an empty body for null. The client expects
    // JSON even before the user's first proposal or after its expiration.
    response.json(await this.service.status(req.user, repo));
  }
  @Post('prepare')
  prepare(@Req() req: AuthedRequest, @Body() body: PreparePatchDto) { return this.service.prepare(req.user, body.repo, body.consent); }
  @Post('pr')
  createPr(@Req() req: AuthedRequest, @Body() body: CreatePatchPrDto) { return this.service.createPr(req.user, body.repo, body.id, body.consent); }
}
