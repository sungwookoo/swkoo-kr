import { auditMarkdown, AuditEvidence, summarizeAudit, validateAuditEvidence } from './security-patch.audit';

const advisory = { source: 123, name: 'demo', title: 'Known vulnerability', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', range: '<1.0.1' };
const lock = JSON.stringify({ packages: { 'node_modules/demo': { version: '1.0.0' }, 'node_modules/parent': { version: '2.0.0' } } });
const report = () => ({ auditReportVersion: 2, metadata: { vulnerabilities: { total: 2 } }, vulnerabilities: {
  demo: { name: 'demo', nodes: ['node_modules/demo'], via: [advisory] },
  parent: { name: 'parent', nodes: ['node_modules/parent'], via: ['demo'] },
} });
const empty = { auditReportVersion: 2, metadata: { vulnerabilities: { total: 0 } }, vulnerabilities: {} };
const evidence = (): AuditEvidence => ({ checkedAt: Date.now(), before: summarizeAudit(report(), lock), after: summarizeAudit(empty, lock) });

describe('npm audit evidence', () => {
  it('separates package totals from advisories and keeps evidence plus installed versions', () => {
    expect(summarizeAudit(report(), lock)).toEqual({ total: 2, findings: [expect.objectContaining({ id: '123', package: 'demo', versions: ['1.0.0'], url: advisory.url, severity: 'high' })] });
    expect(() => validateAuditEvidence(evidence())).not.toThrow();
  });
  it('rejects missing or incomplete reports instead of claiming no vulnerabilities', () => {
    for (const input of [undefined, {}, { ...empty, vulnerabilities: undefined }, { ...report(), vulnerabilities: {} }]) {
      expect(() => summarizeAudit(input, lock)).toThrow('근거');
    }
    const input = report(); input.vulnerabilities.demo.nodes = ['node_modules/missing'];
    expect(() => summarizeAudit(input, lock)).toThrow('근거');
  });
  it('rejects untrusted evidence links', () => {
    const input = report(); input.vulnerabilities.demo.via = [{ ...advisory, url: 'https://github.com.evil.test/advisories/GHSA-aaaa-bbbb-cccc' }];
    expect(() => summarizeAudit(input, lock)).toThrow('근거');
  });
  it('requires an advisory to disappear even when package totals decrease', () => {
    const e = evidence(); e.after = { total: 1, findings: e.before.findings };
    expect(() => validateAuditEvidence(e)).toThrow('개별 취약점');
  });
  it('blocks newly introduced advisories even when others disappear', () => {
    const e = evidence(); e.after = { total: 1, findings: [{ ...e.before.findings[0], id: '456', severity: 'low' }] };
    expect(() => validateAuditEvidence(e)).toThrow('새 취약점');
  });
  it('blocks severity regression among remaining advisories', () => {
    const e = evidence(); e.before.findings.push({ ...e.before.findings[0], id: '456' });
    e.after = { total: 1, findings: [{ ...e.before.findings[0], severity: 'critical' }] };
    expect(() => validateAuditEvidence(e)).toThrow('심각도 상승');
  });
  it('lists resolved and remaining evidence without interpreting registry text as Markdown or mentions', () => {
    const e = evidence(); e.before.findings[0].title = '[click](https://evil.test) @someone <img>';
    e.before.findings.push({ ...e.before.findings[0], id: '456', title: 'Remaining issue' });
    e.after = { total: 1, findings: [e.before.findings[1]] };
    const body = auditMarkdown(e).join('\n');
    expect(body).toContain('제안에서 해결된 취약점'); expect(body).toContain('제안에 남은 취약점');
    expect(body).toContain(`[근거](${advisory.url})`); expect(body).toContain('Remaining issue');
    expect(body).not.toContain('[click]'); expect(body).not.toContain('@someone');
  });
  it('requires re-preparation of legacy proposals', () => {
    expect(() => validateAuditEvidence()).toThrow('이전 수정안');
  });
});
