jest.mock('@kubernetes/client-node', () => ({}));
import 'reflect-metadata';
import { SchedulerRegistry, ScheduleModule } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { CleanupService } from './cleanup.service';
import { UsersRepository } from '../onboarding/users.repository';
import { GithubAppService } from '../github-app/github-app.service';
import { ScanService } from './scan.service';
import { onboardingConfig } from '../config/onboarding.config';

it('schedules daily cleanup for 03:00 Seoul regardless of the host timezone', async () => {
  const module = await Test.createTestingModule({
    imports: [ScheduleModule.forRoot()],
    providers: [CleanupService,
      { provide: UsersRepository, useValue: {} }, { provide: GithubAppService, useValue: {} },
      { provide: ScanService, useValue: {} }, { provide: onboardingConfig.KEY, useValue: {} }],
  }).compile();
  await module.init();
  try {
    const jobs = [...module.get(SchedulerRegistry).getCronJobs().values()];
    expect(jobs).toHaveLength(1);
    const next = jobs[0].nextDate().setZone('Asia/Seoul');
    expect([next.hour, next.minute, next.second]).toEqual([3, 0, 0]);
  } finally { await module.close(); }
});
