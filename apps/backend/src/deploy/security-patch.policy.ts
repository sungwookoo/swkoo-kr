// Deliberately narrower than npm audit fix: lockfile-only, public registry,
// no workspace/link/git dependencies, no major or pre-1.0 minor upgrades.
export const PATCH_POLICY = 'npm-lockfile-v1';
export interface PackageChange { path: string; from: string | null; to: string | null }
export interface PatchResult {
  lockfile: string;
  changes: PackageChange[];
  before: number;
  after: number;
}

export function validatePatchInput(manifest: string, lockfile: string): void {
  if (Buffer.byteLength(manifest) + Buffer.byteLength(lockfile) > 800_000) throw new Error('입력 파일은 합계 800KB까지 지원합니다.');
  const pkg = JSON.parse(manifest);
  const lock = JSON.parse(lockfile);
  if (pkg.workspaces || pkg.overrides || pkg.bundledDependencies || pkg.bundleDependencies ||
      ![2, 3].includes(lock.lockfileVersion) || !lock.packages?.['']) {
    throw new Error('npm lockfile v2/v3 단일 프로젝트만 지원합니다. workspace·override·번들 의존성은 수동 검토가 필요합니다.');
  }
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (JSON.stringify(pkg[section] ?? {}) !== JSON.stringify(lock.packages[''][section] ?? {})) {
      throw new Error('package.json과 lockfile이 일치하지 않습니다. 먼저 lockfile을 갱신하세요.');
    }
    for (const spec of Object.values(pkg[section] ?? {})) {
      if (typeof spec !== 'string' || !/^[0-9v~^<>=*|. xX+-]+$/.test(spec)) {
        throw new Error('공개 npm 레지스트리의 일반 버전 범위만 지원합니다.');
      }
    }
  }
  for (const [path, entry] of Object.entries(lock.packages) as [string, any][]) {
    if (!path) continue;
    if (!path.startsWith('node_modules/') || !/^[A-Za-z0-9_@./-]+$/.test(path) || path.includes('..') || entry.link ||
        typeof entry.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(entry.version) ||
        typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.npmjs.org/') ||
        !/^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(entry.integrity ?? '')) {
      throw new Error('공개 npm의 안정 버전·무결성 정보가 있는 패키지만 지원합니다.');
    }
  }
}

export function validatePatchResult(manifest: string, original: string, result: PatchResult): PackageChange[] {
  validatePatchInput(manifest, result.lockfile);
  const oldLock = JSON.parse(original);
  const newLock = JSON.parse(result.lockfile);
  if (JSON.stringify(oldLock.packages['']) !== JSON.stringify(newLock.packages[''])) throw new Error('루트 의존성 변경은 허용하지 않습니다.');
  if (!Number.isInteger(result.before) || !Number.isInteger(result.after) || result.after < 0 || result.after >= result.before) {
    throw new Error('취약점 감소가 확인되지 않아 PR을 만들지 않습니다.');
  }
  const changes: PackageChange[] = [];
  const oldVersions = new Map<string, string[]>();
  const packageName = (path: string) => path.split('node_modules/').at(-1)!;
  for (const [path, entry] of Object.entries(oldLock.packages) as [string, any][]) {
    if (path) oldVersions.set(packageName(path), [...(oldVersions.get(packageName(path)) ?? []), entry.version]);
  }
  for (const path of new Set([...Object.keys(oldLock.packages), ...Object.keys(newLock.packages)])) {
    if (!path) continue;
    const from = oldLock.packages[path]?.version ?? null;
    const to = newLock.packages[path]?.version ?? null;
    if (from === to) continue;
    if (to) {
      const candidates = from ? [from] : oldVersions.get(packageName(path)) ?? [];
      for (const previous of candidates) {
        const a = previous.split('.').map(Number), b = to.split('.').map(Number);
        if (a[0] !== b[0] || (a[0] === 0 && a[1] !== b[1]) ||
            b[1] < a[1] || (b[1] === a[1] && b[2] < a[2])) {
          throw new Error('메이저·0.x minor 변경 또는 다운그레이드가 포함되어 수동 검토가 필요합니다.');
        }
      }
    }
    changes.push({ path, from, to });
  }
  if (!changes.length || changes.length > 100) throw new Error('변경이 없거나 100개를 초과하여 수동 검토가 필요합니다.');
  return changes;
}
