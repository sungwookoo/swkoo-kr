import { Logger } from '@nestjs/common';
import { writeFileSync } from 'node:fs';
import * as common from 'oci-common';
import type { Readable } from 'node:stream';

import { UsersRepository } from '../onboarding/users.repository';
import { BackupService } from './backup.service';

const mockPutObject = jest.fn(async (request: { putObjectBody: Readable }) => {
  for await (const chunk of request.putObjectBody) {
    expect(chunk.toString()).toBe('snapshot');
  }
});

jest.mock('oci-objectstorage', () => ({
  ObjectStorageClient: jest.fn(() => ({ putObject: mockPutObject })),
}));

describe('BackupService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('starts without OCI and retries authentication on the next backup', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const build = jest.spyOn(
      common.InstancePrincipalsAuthenticationDetailsProviderBuilder.prototype,
      'build',
    ).mockRejectedValueOnce(new Error('metadata temporarily unavailable'))
      .mockResolvedValue({} as Awaited<ReturnType<typeof common.InstancePrincipalsAuthenticationDetailsProviderBuilder.prototype.build>>);
    const users = {
      audit: jest.fn(),
      dumpToFile: jest.fn(async (path: string) => writeFileSync(path, 'snapshot')),
    };
    const service = new BackupService(
      { enabled: true, region: 'test', namespace: 'test', bucket: 'test' },
      users as unknown as UsersRepository,
    );

    service.onModuleInit();
    expect(build).not.toHaveBeenCalled();
    await service.dailyBackup();
    expect(users.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'BACKUP_FAILED' }));
    expect(users.dumpToFile).not.toHaveBeenCalled();

    await service.dailyBackup();
    expect(build).toHaveBeenCalledTimes(2);
    expect(mockPutObject).toHaveBeenCalledTimes(1);
    expect(users.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'BACKUP_UPLOADED' }));
  });
});
