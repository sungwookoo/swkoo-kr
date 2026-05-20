import { Controller, Logger, Post, UseGuards } from '@nestjs/common';

import { AdminGuard } from '../onboarding/admin.guard';
import { JwtAuthGuard } from '../onboarding/jwt-auth.guard';
import { BackupService, BackupUploadResult } from './backup.service';

/** Admin-only manual backup trigger. Useful for smoke-testing the OCI
 * upload path without waiting for 04:00 KST cron, and for taking a
 * one-shot pre-migration snapshot. */
@Controller('admin/backup')
@UseGuards(JwtAuthGuard, AdminGuard)
export class BackupController {
  private readonly logger = new Logger(BackupController.name);

  constructor(private readonly backup: BackupService) {}

  @Post('trigger')
  async trigger(): Promise<BackupUploadResult> {
    this.logger.log('admin-triggered backup starting');
    const result = await this.backup.runBackup();
    this.logger.log(`admin-triggered backup ok: ${result.key}`);
    return result;
  }
}
