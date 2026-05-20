import { registerAs } from '@nestjs/config';

export interface BackupConfig {
  // True only when all three OCI fields are set. Auth uses Instance
  // Principal (pulled from the VM metadata service at 169.254.169.254);
  // no static keys live in env.
  enabled: boolean;
  region: string;
  namespace: string;
  bucket: string;
}

export const backupConfig = registerAs('backup', (): BackupConfig => {
  const region = process.env.OCI_REGION ?? '';
  const namespace = process.env.OCI_OBJECT_STORAGE_NAMESPACE ?? '';
  const bucket = process.env.OCI_BACKUP_BUCKET ?? '';
  return {
    region,
    namespace,
    bucket,
    enabled: Boolean(region && namespace && bucket),
  };
});
