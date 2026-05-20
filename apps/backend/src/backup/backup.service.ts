import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { createReadStream, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as common from 'oci-common';
import * as objectstorage from 'oci-objectstorage';

import { backupConfig } from '../config/backup.config';
import { UsersRepository } from '../onboarding/users.repository';

export interface BackupUploadResult {
  bucket: string;
  key: string;
  sizeBytes: number;
}

/**
 * Daily SQLite snapshot uploader. Picks up Instance Principal credentials
 * from the OCI metadata service (169.254.169.254) — so it only works when
 * the backend pod runs on an OCI compute instance whose Dynamic Group has
 * a Policy granting `manage objects in compartment ... where target.bucket
 * .name='<bucket>'`. See deploy/README.md for the IAM bootstrap.
 *
 * Disabled (no-op) if any of OCI_REGION / OCI_OBJECT_STORAGE_NAMESPACE /
 * OCI_BACKUP_BUCKET is unset — lets dev/test environments boot without
 * the OCI side configured.
 */
@Injectable()
export class BackupService implements OnModuleInit {
  private readonly logger = new Logger(BackupService.name);
  private client: objectstorage.ObjectStorageClient | null = null;

  constructor(
    @Inject(backupConfig.KEY)
    private readonly config: ConfigType<typeof backupConfig>,
    private readonly users: UsersRepository
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.warn(
        'backup disabled (set OCI_REGION / OCI_OBJECT_STORAGE_NAMESPACE / OCI_BACKUP_BUCKET to enable)'
      );
      return;
    }
    try {
      const provider =
        await new common.InstancePrincipalsAuthenticationDetailsProviderBuilder().build();
      this.client = new objectstorage.ObjectStorageClient({
        authenticationDetailsProvider: provider,
      });
      this.logger.log(
        `backup initialized (region=${this.config.region}, bucket=${this.config.bucket})`
      );
    } catch (err) {
      this.logger.error(
        `backup init failed (instance principal auth): ${(err as Error).message}`
      );
    }
  }

  /** Daily SQLite snapshot → OCI Object Storage. Runs after CleanupService
   * (03:00) so the snapshot reflects post-cleanup state — matches the
   * K-PIPA promise that hard-deleted users don't linger in backups. */
  @Cron('0 4 * * *', { timeZone: 'Asia/Seoul' })
  async dailyBackup(): Promise<void> {
    if (!this.client) return;
    try {
      const result = await this.runBackup();
      this.logger.log(
        `daily backup ok: ${result.key} (${result.sizeBytes} bytes)`
      );
    } catch (err) {
      this.logger.error(`daily backup failed: ${(err as Error).message}`);
      this.users.audit({
        actor: 'system',
        action: 'BACKUP_FAILED',
        target: null,
        reason: (err as Error).message,
        metaJson: null,
      });
    }
  }

  /** One-shot backup. Idempotent within a day — re-running overwrites the
   * same key. Used by both the cron and the admin-triggered endpoint. */
  async runBackup(): Promise<BackupUploadResult> {
    if (!this.client) {
      throw new Error('BACKUP_DISABLED');
    }
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const key = `daily/${date}/observatory.sqlite`;
    const tmpPath = join(tmpdir(), `swkoo-backup-${Date.now()}.sqlite`);

    await this.users.dumpToFile(tmpPath);
    try {
      const sizeBytes = statSync(tmpPath).size;
      // Stream upload — loading the whole dump as a Buffer crashes V8 on
      // small containers (256 MB default heap) even for modest DBs once
      // the OCI SDK's own resident footprint is factored in.
      await this.client.putObject({
        namespaceName: this.config.namespace,
        bucketName: this.config.bucket,
        objectName: key,
        putObjectBody: createReadStream(tmpPath),
        contentLength: sizeBytes,
        contentType: 'application/x-sqlite3',
      });
      this.users.audit({
        actor: 'system',
        action: 'BACKUP_UPLOADED',
        target: key,
        reason: null,
        metaJson: JSON.stringify({ sizeBytes }),
      });
      return { bucket: this.config.bucket, key, sizeBytes };
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort
      }
    }
  }
}
