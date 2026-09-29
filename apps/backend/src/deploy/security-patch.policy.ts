// Deliberately narrower than npm audit fix: lockfile-only, public registry,
// no workspace/link/git dependencies, no major or pre-1.0 minor upgrades.
import { satisfies, valid, validRange } from 'semver';

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
  if (pkg.workspaces) throw new Error('workspaces가 설정된 프로젝트는 아직 지원하지 않습니다.');
  if (pkg.bundledDependencies || pkg.bundleDependencies) throw new Error('번들 의존성이 설정된 프로젝트는 아직 지원하지 않습니다.');
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages?.['']) throw new Error('npm lockfile v2/v3 형식이 필요합니다.');
  const overrides = overrideRanges(pkg);
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
        typeof entry.version !== 'string' || valid(entry.version) !== entry.version ||
        typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.npmjs.org/') ||
        !/^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(entry.integrity ?? '')) {
      throw new Error(`패키지 ${path}: 공개 npm의 유효한 버전·무결성 정보가 필요합니다.`);
    }
    const name = path.split('node_modules/').at(-1)!;
    const range = overrides.get(name);
    if (range && !satisfies(entry.version, range)) {
      throw new Error(`overrides[${name}]의 버전 범위와 lockfile이 일치하지 않습니다. 기존 override를 유지한 상태로 lockfile을 갱신하세요.`);
    }
  }
}

// Keep the manifest intact; support only global version overrides whose result
// can be checked independently for every occurrence in the lockfile.
function overrideRanges(pkg: any): Map<string, string> {
  const ranges = new Map<string, string>();
  if (pkg.overrides === undefined) return ranges;
  if (!pkg.overrides || typeof pkg.overrides !== 'object' || Array.isArray(pkg.overrides)) {
    throw new Error('overrides는 패키지 이름과 버전 범위로 구성된 객체여야 합니다.');
  }
  const direct = { ...pkg.devDependencies, ...pkg.dependencies, ...pkg.optionalDependencies };
  for (const [name, value] of Object.entries(pkg.overrides)) {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(name) || typeof value !== 'string') {
      throw new Error(`overrides[${name}]은 아직 지원하지 않는 조건부·중첩 설정입니다. 단순 버전 범위와 $직접의존성 참조만 지원합니다.`);
    }
    const range = value.startsWith('$') && Object.prototype.hasOwnProperty.call(direct, value.slice(1))
      ? direct[value.slice(1)] : value;
    if (typeof range !== 'string' || !/^[0-9v~^<>=*|. xX+-]+$/.test(range) || !validRange(range)) {
      throw new Error(`overrides[${name}]의 버전 또는 참조를 지원하지 않습니다. 공개 npm 버전 범위와 유효한 $직접의존성 참조가 필요합니다.`);
    }
    ranges.set(name, range);
  }
  return ranges;
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
    if ([from, to].some(version => version && !/^\d+\.\d+\.\d+$/.test(version))) {
      throw new Error(`패키지 ${path}: prerelease·빌드 접미사 버전의 변경은 수동 검토가 필요합니다. 기존 버전을 유지하는 경우만 지원합니다.`);
    }
    if (to) {
      const candidates = from ? [from] : oldVersions.get(packageName(path)) ?? [];
      for (const previous of candidates) {
        if (!/^\d+\.\d+\.\d+$/.test(previous)) throw new Error(`패키지 ${path}: prerelease·빌드 접미사 버전의 변경은 수동 검토가 필요합니다.`);
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
