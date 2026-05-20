import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import type { V1Job } from '@kubernetes/client-node';
import axios from 'axios';

import { onboardingConfig } from '../config/onboarding.config';
import { KubeClient } from '../kube/kube.client';
import { UsersRepository, ScanResultRow } from '../onboarding/users.repository';
import { DeployService } from './deploy.service';

const TRIVY_IMAGE = 'aquasec/trivy:0.50.0';
const TRIVY_VERSION = '0.50.0';
const BACKEND_NS = 'swkoo';
const SCAN_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 5_000;

interface TrivyVulnerability {
  Severity?: string;
  VulnerabilityID?: string;
  PkgName?: string;
  InstalledVersion?: string;
  FixedVersion?: string;
  Title?: string;
  PrimaryURL?: string;
}
interface TrivyTarget {
  Vulnerabilities?: TrivyVulnerability[];
}
interface TrivyReport {
  Results?: TrivyTarget[];
}

export interface ScanFinding {
  id: string;          // CVE-2024-...
  pkg: string;         // libssl3
  installed: string;   // 3.0.13-1
  fixed: string | null; // 3.0.14-1 or null when no fix yet
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  title: string;
  url: string;
}

interface ScanResult {
  critical: number;
  high: number;
  medium: number;
  findings: ScanFinding[];
}

// Cap stored findings — the UI only renders top ~20 anyway and large
// scan blobs balloon SQLite. CRITICAL kept entirely, then HIGH up to
// the cap. MEDIUM is summarized in the counts only.
const MAX_STORED_FINDINGS = 50;

/**
 * Dispatches Trivy image scans as Kubernetes Jobs in the backend's own
 * namespace. The backend pod never runs the scanner itself — Jobs are
 * ephemeral, isolated, and share a small PVC for Trivy's vulnerability DB
 * so subsequent scans don't redownload the ~50MB DB.
 *
 * Results live only in SQLite (scan_results table). The metadata.yaml
 * scanResult placeholder stays as-is to avoid daily git commits — the
 * authoritative scan state is the latest DB row per user.
 */
@Injectable()
export class ScanService {
  private readonly logger = new Logger(ScanService.name);

  constructor(
    private readonly kube: KubeClient,
    private readonly users: UsersRepository,
    private readonly deploy: DeployService,
    @Inject(onboardingConfig.KEY)
    private readonly config: ConfigType<typeof onboardingConfig>
  ) {}

  /** Scan every active user. Best-effort: a single user's failure doesn't
   * block the rest. */
  async scanAllActiveUsers(): Promise<void> {
    if (!this.kube.available()) {
      this.logger.warn('scan skipped: kube client unavailable');
      return;
    }
    const allUsers = this.users.listAllUsers().filter((u) => u.isAllowed);
    let scanned = 0;
    for (const u of allUsers) {
      try {
        const deployment = await this.deploy.getCurrentDeployment(u.githubLogin);
        if (!deployment || deployment.state !== 'active') continue;
        const image = `ghcr.io/${u.githubLogin.toLowerCase()}/${deployment.repo.toLowerCase()}:latest`;
        const result = await this.runScan(u.githubLogin, image);
        if (!result) continue;
        const previous = this.users.latestScanResultForUser(u.id);
        this.users.insertScanResult({
          userId: u.id,
          image,
          critical: result.critical,
          high: result.high,
          medium: result.medium,
          trivyVersion: TRIVY_VERSION,
          findingsJson: JSON.stringify(result.findings),
        });
        scanned += 1;
        this.logger.log(
          `scan complete for ${u.githubLogin}: critical=${result.critical} high=${result.high} medium=${result.medium}`
        );
        this.maybeNotifyScanFindings(u.githubLogin, image, result, previous);
      } catch (err) {
        this.logger.warn(`scan failed for ${u.githubLogin}: ${(err as Error).message}`);
      }
    }
    if (scanned > 0) {
      this.users.audit({
        actor: 'system',
        action: 'SCAN_DAILY',
        target: null,
        reason: null,
        metaJson: JSON.stringify({ count: scanned }),
      });
    }
  }

  /** Runs a single scan and returns severity counts, or null on failure. */
  async runScan(login: string, image: string): Promise<ScanResult | null> {
    const jobName = `scan-${login.toLowerCase()}-${Date.now()}`;
    const body = this.buildJobSpec(jobName, login, image);
    try {
      await this.kube.batch!.createNamespacedJob({ namespace: BACKEND_NS, body });
    } catch (err) {
      this.logger.error(`createJob ${jobName}: ${(err as Error).message}`);
      return null;
    }
    let job: V1Job | null;
    try {
      job = await this.waitForJob(jobName);
    } finally {
      void this.deleteJob(jobName);
    }
    if (!job || !job.status?.succeeded) {
      this.logger.warn(`scan job ${jobName} did not succeed`);
      return null;
    }
    const logs = await this.readJobLogs(jobName);
    if (!logs) return null;
    return this.parseTrivyOutput(logs);
  }

  private buildJobSpec(jobName: string, login: string, image: string): V1Job {
    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        namespace: BACKEND_NS,
        labels: {
          'swkoo.kr/scan': login.toLowerCase(),
          'app.kubernetes.io/component': 'image-scanner',
        },
      },
      spec: {
        ttlSecondsAfterFinished: 600,
        backoffLimit: 0,
        template: {
          metadata: {
            labels: { 'swkoo.kr/scan': login.toLowerCase() },
          },
          spec: {
            restartPolicy: 'Never',
            containers: [
              {
                name: 'trivy',
                image: TRIVY_IMAGE,
                args: [
                  'image',
                  '--quiet',
                  '--format=json',
                  '--severity=CRITICAL,HIGH,MEDIUM',
                  '--cache-dir=/cache',
                  '--scanners=vuln',
                  // OCI A1 nodes are arm64; friend images are arm64-only.
                  // Without this, Trivy defaults to linux/amd64 and 404s on
                  // the multi-arch index lookup.
                  '--platform=linux/arm64',
                  image,
                ],
                volumeMounts: [{ name: 'cache', mountPath: '/cache' }],
                resources: {
                  requests: { cpu: '100m', memory: '256Mi' },
                  limits: { cpu: '500m', memory: '512Mi' },
                },
              },
            ],
            volumes: [
              {
                name: 'cache',
                persistentVolumeClaim: { claimName: 'trivy-db-cache' },
              },
            ],
          },
        },
      },
    };
  }

  private async waitForJob(jobName: string): Promise<V1Job | null> {
    const deadline = Date.now() + SCAN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      try {
        const job = await this.kube.batch!.readNamespacedJob({
          name: jobName,
          namespace: BACKEND_NS,
        });
        if (job.status?.succeeded) return job;
        if (job.status?.failed) return job;
      } catch (err) {
        this.logger.warn(`readJob ${jobName}: ${(err as Error).message}`);
      }
    }
    this.logger.warn(`scan job ${jobName} timed out after ${SCAN_TIMEOUT_MS}ms`);
    return null;
  }

  private async readJobLogs(jobName: string): Promise<string | null> {
    try {
      const pods = await this.kube.core!.listNamespacedPod({
        namespace: BACKEND_NS,
        labelSelector: `job-name=${jobName}`,
      });
      const podName = pods.items[0]?.metadata?.name;
      if (!podName) {
        this.logger.warn(`no pod found for job ${jobName}`);
        return null;
      }
      const log = await this.kube.core!.readNamespacedPodLog({
        name: podName,
        namespace: BACKEND_NS,
        container: 'trivy',
      });
      return typeof log === 'string' ? log : null;
    } catch (err) {
      this.logger.warn(`readJobLogs ${jobName}: ${(err as Error).message}`);
      return null;
    }
  }

  private async deleteJob(jobName: string): Promise<void> {
    try {
      await this.kube.batch!.deleteNamespacedJob({
        name: jobName,
        namespace: BACKEND_NS,
        propagationPolicy: 'Background',
      });
    } catch (err) {
      // Best-effort cleanup; ttlSecondsAfterFinished will eventually GC.
      this.logger.warn(`deleteJob ${jobName}: ${(err as Error).message}`);
    }
  }

  /** Fires an operator Discord alert when today's scan introduces critical
   * or high vulns the previous scan didn't already cover. Skips when the
   * counts didn't increase (avoids daily re-pings for unfixed findings). */
  private maybeNotifyScanFindings(
    login: string,
    image: string,
    current: ScanResult,
    previous: ScanResultRow | null
  ): void {
    const url = this.config.discordScanWebhookUrl;
    if (!url) return;
    if (current.critical === 0 && current.high === 0) return;
    if (
      previous &&
      current.critical <= previous.critical &&
      current.high <= previous.high
    ) {
      return;
    }
    const lines = [
      '🟠 이미지 스캔 경보',
      `**${login}** — \`${image}\``,
      `Critical: ${current.critical} · High: ${current.high} · Medium: ${current.medium}`,
    ];
    if (previous) {
      lines.push(
        `(이전: Critical ${previous.critical} · High ${previous.high})`
      );
    } else {
      lines.push('(첫 스캔)');
    }
    void axios
      .post(url, { content: lines.join('\n') }, { timeout: 5000 })
      .catch((err) => {
        this.logger.error(`Scan Discord webhook failed: ${(err as Error).message}`);
      });
  }

  private parseTrivyOutput(raw: string): ScanResult | null {
    // Trivy prefixes some lines with non-JSON log noise depending on version;
    // pluck the first balanced JSON object out of the stream.
    const start = raw.indexOf('{');
    if (start < 0) return null;
    let parsed: TrivyReport;
    try {
      parsed = JSON.parse(raw.slice(start)) as TrivyReport;
    } catch (err) {
      this.logger.warn(`trivy json parse failed: ${(err as Error).message}`);
      return null;
    }
    const counts = { critical: 0, high: 0, medium: 0 };
    const criticals: ScanFinding[] = [];
    const highs: ScanFinding[] = [];
    for (const result of parsed.Results ?? []) {
      for (const v of result.Vulnerabilities ?? []) {
        if (v.Severity === 'CRITICAL') {
          counts.critical += 1;
          criticals.push(this.toFinding(v, 'CRITICAL'));
        } else if (v.Severity === 'HIGH') {
          counts.high += 1;
          highs.push(this.toFinding(v, 'HIGH'));
        } else if (v.Severity === 'MEDIUM') {
          counts.medium += 1;
        }
      }
    }
    // CRITICAL kept entirely (they're rare and operator wants them).
    // HIGH filled up to the cap. MEDIUM is counts-only by design.
    const findings: ScanFinding[] = [...criticals];
    const highBudget = Math.max(0, MAX_STORED_FINDINGS - findings.length);
    findings.push(...highs.slice(0, highBudget));
    return { ...counts, findings };
  }

  private toFinding(v: TrivyVulnerability, severity: ScanFinding['severity']): ScanFinding {
    return {
      id: v.VulnerabilityID ?? '?',
      pkg: v.PkgName ?? '?',
      installed: v.InstalledVersion ?? '?',
      fixed: v.FixedVersion ?? null,
      severity,
      title: v.Title ?? '',
      url: v.PrimaryURL ?? '',
    };
  }
}
