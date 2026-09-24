import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { webhooksConfig } from '../config/webhooks.config';
import type { PackageChange } from './security-patch.policy';
import type { AuditEvidence } from './security-patch.audit';

export interface PatchPlan {
  id: string; userId: number; repo: string; base: string; sha: string;
  state: 'preparing' | 'ready' | 'blocked' | 'failed' | 'creating' | 'pr';
  createdAt: number; updatedAt: number; manifest: string; original: string;
  lockfile?: string; changes?: PackageChange[]; before?: number; after?: number;
  message?: string; prUrl?: string;
  evidence?: AuditEvidence;
}

@Injectable()
export class SecurityPatchRepository implements OnModuleInit, OnModuleDestroy {
  private db!: Database.Database;
  constructor(@Inject(webhooksConfig.KEY) private readonly config: ConfigType<typeof webhooksConfig>) {}
  onModuleInit(): void {
    mkdirSync(dirname(this.config.dbPath), { recursive: true });
    this.db = new Database(this.config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS security_patch_plans (user_id INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, created_at INTEGER NOT NULL)');
  }
  onModuleDestroy(): void { this.db?.close(); }
  get(userId: number): PatchPlan | null {
    const row = this.db.prepare('SELECT data FROM security_patch_plans WHERE user_id=?').get(userId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }
  save(plan: PatchPlan): void {
    this.db.prepare('INSERT INTO security_patch_plans VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET id=excluded.id,data=excluded.data,created_at=excluded.created_at')
      .run(plan.userId, plan.id, JSON.stringify(plan), plan.createdAt);
  }
  countPreparing(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM security_patch_plans WHERE json_extract(data,'$.state')='preparing' AND created_at > ?")
      .get(Date.now() - 420_000) as { n: number }).n;
  }
  prune(): void {
    this.db.prepare('DELETE FROM security_patch_plans WHERE created_at < ? OR user_id NOT IN (SELECT id FROM users WHERE deleted_at IS NULL)')
      .run(Date.now() - 24 * 60 * 60_000);
  }
}
