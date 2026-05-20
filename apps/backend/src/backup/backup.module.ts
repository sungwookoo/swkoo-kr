import { Module } from '@nestjs/common';

import { OnboardingModule } from '../onboarding/onboarding.module';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';

@Module({
  imports: [OnboardingModule],
  controllers: [BackupController],
  providers: [BackupService],
  exports: [BackupService],
})
export class BackupModule {}
