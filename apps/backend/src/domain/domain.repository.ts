import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import Database, { Database as Db } from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

import { webhooksConfig } from '../config/webhooks.config';

export type CustomDomainStatus =
  | 'pending'
  | 'verified'
  | 'applying'
  | 'active'
  | 'error';

export interface CustomDomainRow {
  id: number;
  userId: number;
  login: string;
  appName: string;
  domain: string;
  status: CustomDomainStatus;
  verificationToken: string;
  expectedCname: string;
  /** Set when the manifest commit lands in the deploy repo. NULL while the
   * row is still pending DNS verification — preservation guard relies on
   * this being non-null OR status in (applying|active) to re-emit the
   * custom ingress on user redeploy. */
  appliedCommit: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCustomDomainInput {
  userId: number;
  login: string;
  appName: string;
  domain: string;
  verificationToken: string;
  expectedCname: string;
}

@Injectable()
export class CustomDomainsRepository implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CustomDomainsRepository.name);
  private db!: Db;

  constructor(
    @Inject(webhooksConfig.KEY)
    private readonly config: ConfigType<typeof webhooksConfig>
  ) {}

  onModuleInit(): void {
    mkdirSync(dirname(this.config.dbPath), { recursive: true });
    this.db = new Database(this.config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS custom_domains (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id             INTEGER NOT NULL,
        login               TEXT    NOT NULL,
        app_name            TEXT    NOT NULL,
        domain              TEXT    NOT NULL,
        status              TEXT    NOT NULL,
        verification_token  TEXT    NOT NULL,
        expected_cname      TEXT    NOT NULL,
        applied_commit      TEXT,
        verified_at         TEXT,
        last_error          TEXT,
        created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_domains_domain
        ON custom_domains(domain);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_domains_user_app
        ON custom_domains(user_id, app_name);
    `);
    this.logger.log('custom_domains table ready');
  }

  onModuleDestroy(): void {
    this.db?.close();
  }

  private readonly cols = `
    id,
    user_id            AS userId,
    login,
    app_name           AS appName,
    domain,
    status,
    verification_token AS verificationToken,
    expected_cname     AS expectedCname,
    applied_commit     AS appliedCommit,
    verified_at        AS verifiedAt,
    last_error         AS lastError,
    created_at         AS createdAt,
    updated_at         AS updatedAt
  `;

  /** Returns the single custom domain for (login, appName), if any. v0
   * caps one per app, enforced by the UNIQUE index. */
  findByLoginApp(login: string, appName: string): CustomDomainRow | undefined {
    const stmt = this.db.prepare(
      `SELECT ${this.cols} FROM custom_domains
       WHERE login = ? AND app_name = ?`
    );
    return stmt.get(login, appName) as CustomDomainRow | undefined;
  }

  /** Domain-uniqueness check used before INSERT to surface a clean 409
   * instead of relying on SQLITE_CONSTRAINT propagating up. */
  findByDomain(domain: string): CustomDomainRow | undefined {
    const stmt = this.db.prepare(
      `SELECT ${this.cols} FROM custom_domains WHERE domain = ?`
    );
    return stmt.get(domain) as CustomDomainRow | undefined;
  }

  /** Subset used by the re-render preservation guard. status reflects
   * pending|verified|applying|active|error; the guard adds OR
   * applied_commit IS NOT NULL so an errored-but-already-applied row
   * still preserves its ingress on the next user redeploy. */
  findForRender(login: string, appName: string): CustomDomainRow | undefined {
    const row = this.findByLoginApp(login, appName);
    if (!row) return undefined;
    const inActivePhase = row.status === 'applying' || row.status === 'active';
    if (inActivePhase) return row;
    if (row.appliedCommit) return row;
    return undefined;
  }

  create(input: CreateCustomDomainInput): CustomDomainRow {
    const stmt = this.db.prepare(`
      INSERT INTO custom_domains
        (user_id, login, app_name, domain, status,
         verification_token, expected_cname)
      VALUES
        (@userId, @login, @appName, @domain, 'pending',
         @verificationToken, @expectedCname)
      RETURNING ${this.cols}
    `);
    return stmt.get(input) as CustomDomainRow;
  }

  updateStatus(
    id: number,
    status: CustomDomainStatus,
    opts: { lastError?: string | null; verifiedAt?: string | null } = {}
  ): CustomDomainRow | undefined {
    const stmt = this.db.prepare(`
      UPDATE custom_domains SET
        status      = @status,
        last_error  = COALESCE(@lastError, last_error),
        verified_at = COALESCE(@verifiedAt, verified_at),
        updated_at  = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = @id
      RETURNING ${this.cols}
    `);
    return stmt.get({
      id,
      status,
      lastError: opts.lastError ?? null,
      verifiedAt: opts.verifiedAt ?? null,
    }) as CustomDomainRow | undefined;
  }

  /** Set when the manifest commit lands. Idempotent — repeated calls with
   * the same SHA are harmless (UPDATE always touches updated_at). */
  markApplied(id: number, commitSha: string): CustomDomainRow | undefined {
    const stmt = this.db.prepare(`
      UPDATE custom_domains SET
        applied_commit = @sha,
        updated_at     = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = @id
      RETURNING ${this.cols}
    `);
    return stmt.get({ id, sha: commitSha }) as CustomDomainRow | undefined;
  }

  /** Clear error when transitioning out of error state (verify retry,
   * cert ready). updateStatus's COALESCE on lastError won't clear it, so
   * a dedicated method keeps the API explicit. */
  clearError(id: number): void {
    this.db.prepare(
      `UPDATE custom_domains SET last_error = NULL,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`
    ).run(id);
  }

  delete(id: number): void {
    this.db.prepare(`DELETE FROM custom_domains WHERE id = ?`).run(id);
  }
}
