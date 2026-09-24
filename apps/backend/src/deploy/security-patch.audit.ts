export const severityOrder = ['info', 'low', 'moderate', 'high', 'critical'] as const;
export interface AuditFinding {
  id: string; package: string; title: string; url: string;
  severity: typeof severityOrder[number]; range: string; versions: string[];
}
export interface AuditSnapshot { total: number; findings: AuditFinding[] }
export interface AuditEvidence { checkedAt: number; before: AuditSnapshot; after: AuditSnapshot }

// npm's total counts vulnerable packages (including meta-vulnerabilities),
// not unique advisories. Keep those two counts separate.
export function summarizeAudit(report: any, lockfile: string): AuditSnapshot {
  const invalid = () => { throw new Error('npm 취약점 근거를 확인할 수 없습니다. 수정안을 다시 준비하세요.'); };
  const total = report?.metadata?.vulnerabilities?.total;
  if (report?.auditReportVersion !== 2 || !Number.isInteger(total) || total < 0 ||
      !report.vulnerabilities || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)) return invalid();
  const entries = Object.entries(report.vulnerabilities) as [string, any][];
  if (entries.length !== total) return invalid();
  const packages = JSON.parse(lockfile).packages;
  const findings = new Map<string, AuditFinding>();
  for (const [name, entry] of entries) {
    if (entry.name !== name || !Array.isArray(entry.via) || !entry.via.length || !Array.isArray(entry.nodes) || !entry.nodes.length) return invalid();
    const versions = entry.nodes.map((path: string) => packages[path]?.version);
    if (versions.some((version: unknown) => typeof version !== 'string')) return invalid();
    for (const advisory of entry.via) {
      if (typeof advisory === 'string') {
        if (!Object.prototype.hasOwnProperty.call(report.vulnerabilities, advisory)) return invalid();
        continue; // The referenced package supplies the underlying advisory.
      }
      if (!advisory || !Number.isInteger(advisory.source) || advisory.source <= 0 || advisory.name !== name ||
          typeof advisory.title !== 'string' || !advisory.title || advisory.title.length > 1000 ||
          typeof advisory.range !== 'string' || advisory.range.length > 500 ||
          !severityOrder.includes(advisory.severity) || typeof advisory.url !== 'string' ||
          !/^https:\/\/(github\.com\/advisories\/GHSA-[a-z0-9-]+|www\.npmjs\.com\/advisories\/\d+)$/.test(advisory.url)) return invalid();
      const id = String(advisory.source);
      findings.set(`${name}:${id}`, { id, package: name, title: advisory.title, url: advisory.url,
        severity: advisory.severity, range: advisory.range, versions: [...new Set<string>(versions)].sort() });
    }
  }
  if (total > 0 && !findings.size) return invalid();
  return { total, findings: [...findings.values()].sort((a, b) => `${a.package}:${a.id}`.localeCompare(`${b.package}:${b.id}`)) };
}

const key = (finding: AuditFinding) => `${finding.package}:${finding.id}`;
export function resolvedFindings(evidence: AuditEvidence): AuditFinding[] {
  const remaining = new Set(evidence.after.findings.map(key));
  return evidence.before.findings.filter(finding => !remaining.has(key(finding)));
}

export function validateAuditEvidence(evidence?: AuditEvidence): void {
  if (!evidence) throw new Error('취약점별 근거가 없는 이전 수정안입니다. 수정안을 다시 준비하세요.');
  const before = new Map(evidence.before.findings.map(finding => [key(finding), finding]));
  if (evidence.after.findings.some(finding => !before.has(key(finding)) ||
      severityOrder.indexOf(finding.severity) > severityOrder.indexOf(before.get(key(finding))!.severity))) {
    throw new Error('새 취약점 또는 심각도 상승이 발견되어 PR 생성을 중단했습니다. 수동 검토가 필요합니다.');
  }
  if (!resolvedFindings(evidence).length) throw new Error('해결된 개별 취약점이 확인되지 않아 PR을 만들지 않습니다.');
}

// Registry strings are untrusted text, not Markdown or GitHub mentions.
const plain = (value: string) => value.replace(/</g, '＜').replace(/>/g, '＞').replace(/[^\p{L}\p{N} .,:/+=＜＞-]/gu, ' ');
export function auditMarkdown(evidence: AuditEvidence): string[] {
  const lines = (findings: AuditFinding[]) => findings.length ? findings.map(finding =>
    `- ${plain(finding.package)} · npm advisory ${finding.id} · ${finding.severity} · ${plain(finding.title)}\n  영향 범위: ${plain(finding.range)} · 검사된 버전: ${finding.versions.join(', ')} · [근거](${finding.url})`) : ['- 없음'];
  return [
    `검사 완료: ${new Date(evidence.checkedAt).toISOString()} · npm 공개 레지스트리 / npm audit 11.19.1`,
    '아래 해결 표시는 제안 lockfile의 재검사에서 사라진 항목입니다. 운영 앱에 적용된 결과가 아닙니다. 정기 재검사는 제공하지 않습니다.',
    '### 제안에서 해결된 취약점', ...lines(resolvedFindings(evidence)),
    '### 제안에 남은 취약점', ...lines(evidence.after.findings),
    '취약 패키지 집계에는 간접 영향이 포함되어 개별 취약점 목록의 수와 다를 수 있습니다. 알려지지 않은 취약점과 앱 코드·OS 취약점은 이 검사로 확인하지 못합니다.',
  ];
}
