import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import Database, { Database as Db } from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

import { webhooksConfig } from '../config/webhooks.config';

export type ProvenanceMethod =
  | 'gh_package_tag_digest'
  | 'time_window'
  | 'self_repo_commit'
  | 'none';

export type ProvenanceConfidence = 'verified' | 'estimated' | 'unknown';

export interface ProvenanceRow {
  /** GHCR package owner — derived from the deployed image string, not from
   * the `swkoo.kr/source-repo` annotation. Real-world drift (rename,
   * stale yaml) means the annotation isn't always trustworthy. */
  imageOwner: string;
  imageName: string;
  digest: string;
  sourceSha: string | null;
  sourceRunUrl: string | null;
  method: ProvenanceMethod;
  evidence: string;
  confidence: ProvenanceConfidence;
  resolvedAt: number;
  attempts: number;
}

export interface ProvenanceUpsert {
  imageOwner: string;
  imageName: string;
  digest: string;
  sourceSha: string | null;
  sourceRunUrl: string | null;
  method: ProvenanceMethod;
  evidence: string;
  confidence: ProvenanceConfidence;
}

@Injectable()
export class ProvenanceRepository implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProvenanceRepository.name);
  private db!: Db;

  constructor(
    @Inject(webhooksConfig.KEY)
    private readonly config: ConfigType<typeof webhooksConfig>
  ) {}

  onModuleInit(): void {
    mkdirSync(dirname(this.config.dbPath), { recursive: true });
    this.db = new Database(this.config.dbPath);
    this.db.pragma('journal_mode = WAL');
    // Composite PK (source_owner, source_repo, digest): the same digest can
    // theoretically appear in distinct user packages (forks, re-pushes).
    // Keying on source repo prevents one user's resolution from poisoning
    // another's lookup.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS image_provenance (
        image_owner     TEXT    NOT NULL,
        image_name      TEXT    NOT NULL,
        digest          TEXT    NOT NULL,
        source_sha      TEXT,
        source_run_url  TEXT,
        method          TEXT    NOT NULL,
        evidence        TEXT    NOT NULL,
        confidence      TEXT    NOT NULL,
        resolved_at     INTEGER NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (image_owner, image_name, digest)
      );
      CREATE INDEX IF NOT EXISTS idx_image_provenance_resolved
        ON image_provenance (resolved_at DESC);
    `);
    this.logger.log('image_provenance table ready');
  }

  onModuleDestroy(): void {
    this.db?.close();
  }

  private readonly cols = `
    image_owner    AS imageOwner,
    image_name     AS imageName,
    digest,
    source_sha     AS sourceSha,
    source_run_url AS sourceRunUrl,
    method,
    evidence,
    confidence,
    resolved_at    AS resolvedAt,
    attempts
  `;

  find(imageOwner: string, imageName: string, digest: string): ProvenanceRow | undefined {
    const stmt = this.db.prepare(
      `SELECT ${this.cols} FROM image_provenance
       WHERE image_owner = ? AND image_name = ? AND digest = ?`
    );
    return stmt.get(imageOwner, imageName, digest) as ProvenanceRow | undefined;
  }

  /** Insert-or-update. Attempts increments on every upsert so we can spot
   * pathological repeated resolution attempts in the audit trail. */
  upsert(row: ProvenanceUpsert): ProvenanceRow {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO image_provenance
        (image_owner, image_name, digest, source_sha, source_run_url,
         method, evidence, confidence, resolved_at, attempts)
      VALUES
        (@imageOwner, @imageName, @digest, @sourceSha, @sourceRunUrl,
         @method, @evidence, @confidence, ${now}, 1)
      ON CONFLICT(image_owner, image_name, digest) DO UPDATE SET
        source_sha     = excluded.source_sha,
        source_run_url = excluded.source_run_url,
        method         = excluded.method,
        evidence       = excluded.evidence,
        confidence     = excluded.confidence,
        resolved_at    = ${now},
        attempts       = attempts + 1
      RETURNING ${this.cols}
    `);
    return stmt.get(row) as ProvenanceRow;
  }

  /** TTL eligibility for re-resolution. verified rows never re-resolve;
   * estimated/unknown can be retried once enough time has passed for new
   * data (workflow_runs / package versions) to appear. */
  isStale(row: ProvenanceRow, now = Date.now()): boolean {
    if (row.confidence === 'verified') return false;
    const ageMs = now - row.resolvedAt;
    if (row.confidence === 'estimated') return ageMs > 12 * 60 * 60 * 1000;
    return ageMs > 1 * 60 * 60 * 1000; // unknown: retry hourly
  }
}
