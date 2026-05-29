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

/** Verification scheme. `txt_cname` is the v0 flow (TXT challenge +
 * CNAME routing); `cname_token` is the v0.2 flow (single CNAME whose
 * tokenized target — cd-sk-<token>.domains.swkoo.kr — is itself the
 * ownership proof). Existing rows default to txt_cname (grandfathered);
 * new registrations are cname_token. */
export type VerificationScheme = 'txt_cname' | 'cname_token';

export interface CustomDomainRow {
  id: number;
  userId: number;
  login: string;
  appName: string;
  domain: string;
  status: CustomDomainStatus;
  scheme: VerificationScheme;
  verificationToken: string;
  expectedCname: string;
  /** Set when the manifest commit lands in the deploy repo. NULL while the
   * row is still pending DNS verification — preservation guard relies on
   * this being non-null OR status in (applying|active) to re-emit the
   * custom ingress on user redeploy. */
  appliedCommit: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  /** Machine reason of the last failure (e.g. DNS_CNAME_CONFLICTS_WITH_A),
   * so the panel can render reason-specific recovery UX without re-parsing
   * the human message. NULL when no failure or after clearError. */
  lastErrorReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCustomDomainInput {
  userId: number;
  login: string;
  appName: string;
  domain: string;
  scheme: VerificationScheme;
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
    // v0.2 idempotent column adds. Existing rows default to the v0
    // verification scheme (txt_cname) — grandfathered, never force-migrated.
    this.addColumnIfMissing(
      'verification_scheme',
      `TEXT NOT NULL DEFAULT 'txt_cname'`
    );
    this.addColumnIfMissing('last_error_reason', 'TEXT');
    this.logger.log('custom_domains table ready');
  }

  private addColumnIfMissing(column: string, type: string): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(custom_domains)`)
      .all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE custom_domains ADD COLUMN ${column} ${type}`);
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
    verification_scheme AS scheme,
    verification_token AS verificationToken,
    expected_cname     AS expectedCname,
    applied_commit     AS appliedCommit,
    verified_at        AS verifiedAt,
    last_error         AS lastError,
    last_error_reason  AS lastErrorReason,
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
        (user_id, login, app_name, domain, status, verification_scheme,
         verification_token, expected_cname)
      VALUES
        (@userId, @login, @appName, @domain, 'pending', @scheme,
         @verificationToken, @expectedCname)
      RETURNING ${this.cols}
    `);
    return stmt.get(input) as CustomDomainRow;
  }

  updateStatus(
    id: number,
    status: CustomDomainStatus,
    opts: {
      lastError?: string | null;
      lastErrorReason?: string | null;
      verifiedAt?: string | null;
    } = {}
  ): CustomDomainRow | undefined {
    const stmt = this.db.prepare(`
      UPDATE custom_domains SET
        status            = @status,
        last_error        = COALESCE(@lastError, last_error),
        last_error_reason = COALESCE(@lastErrorReason, last_error_reason),
        verified_at       = COALESCE(@verifiedAt, verified_at),
        updated_at        = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = @id
      RETURNING ${this.cols}
    `);
    return stmt.get({
      id,
      status,
      lastError: opts.lastError ?? null,
      lastErrorReason: opts.lastErrorReason ?? null,
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
      `UPDATE custom_domains SET last_error = NULL, last_error_reason = NULL,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`
    ).run(id);
  }

  delete(id: number): void {
    this.db.prepare(`DELETE FROM custom_domains WHERE id = ?`).run(id);
  }

  /** Orphan cleanup helpers called from DeployService.deleteDeployment.
   * v0 is 1-user-1-app, so we can safely operate on every row for a
   * login when the user tears down their app. */
  findByLogin(login: string): CustomDomainRow[] {
    const stmt = this.db.prepare(
      `SELECT ${this.cols} FROM custom_domains WHERE login = ?`
    );
    return stmt.all(login) as CustomDomainRow[];
  }

  deleteByLogin(login: string): number {
    const info = this.db
      .prepare(`DELETE FROM custom_domains WHERE login = ?`)
      .run(login);
    return info.changes;
  }
}
