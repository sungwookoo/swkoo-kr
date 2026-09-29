import { validatePatchInput, validatePatchResult } from './security-patch.policy';
import { patchJob } from './security-patch.worker';

export const manifest = JSON.stringify({ dependencies: { demo: '^1.0.0' } });
export const lock = (version = '1.0.0') => JSON.stringify({ lockfileVersion: 3, packages: {
  '': { dependencies: { demo: '^1.0.0' } },
  'node_modules/demo': { version, resolved: 'https://registry.npmjs.org/demo/-/demo.tgz', integrity: 'sha512-YWJj' },
} });
describe('security patch policy', () => {
  it('allows unchanged prerelease transitive dependencies, but rejects changing or removing them', () => {
    const original = JSON.parse(lock());
    original.packages['node_modules/gensync'] = { ...original.packages['node_modules/demo'], version: '1.0.0-beta.2' };
    const updated = JSON.parse(JSON.stringify(original));
    updated.packages['node_modules/demo'].version = '1.0.1';
    const result = () => validatePatchResult(manifest, JSON.stringify(original), { lockfile: JSON.stringify(updated), before: 2, after: 1, changes: [] });
    expect(result()).toHaveLength(1);
    updated.packages['node_modules/gensync'].version = '1.0.0';
    expect(result).toThrow('prerelease');
    delete updated.packages['node_modules/gensync'];
    expect(result).toThrow('prerelease');
  });
  it.each(['^1.0.0', '$demo'])('preserves supported override %s while allowing an update', override => {
    const input = JSON.stringify({ dependencies: { demo: '^1.0.0' }, overrides: { demo: override } });
    expect(validatePatchResult(input, lock(), { lockfile: lock('1.0.1'), before: 2, after: 1, changes: [] })).toHaveLength(1);
  });
  it('accepts exact security pins and rejects results that escape them, including nested copies', () => {
    const input = JSON.stringify({ dependencies: { demo: '^1.0.0' }, overrides: { demo: '1.0.0' } });
    expect(() => validatePatchInput(input, lock())).not.toThrow();
    expect(() => validatePatchResult(input, lock(), { lockfile: lock('1.0.1'), before: 2, after: 1, changes: [] })).toThrow('overrides[demo]');
    const nested = JSON.parse(lock());
    nested.packages['node_modules/parent/node_modules/demo'] = JSON.parse(lock('1.0.1')).packages['node_modules/demo'];
    expect(() => validatePatchInput(input, JSON.stringify(nested))).toThrow('overrides[demo]');
  });
  it('resolves dev dependency references used by SprintFlow', () => {
    const input = JSON.stringify({ devDependencies: { postcss: '^8.5.15' }, overrides: { postcss: '$postcss', 'deepmerge-ts': '8.0.0' } });
    const entry = JSON.parse(lock()).packages['node_modules/demo'];
    const fixture = JSON.stringify({ lockfileVersion: 3, packages: {
      '': { devDependencies: { postcss: '^8.5.15' } },
      'node_modules/postcss': { ...entry, version: '8.5.15' },
      'node_modules/deepmerge-ts': { ...entry, version: '8.0.0' },
    } });
    expect(() => validatePatchInput(input, fixture)).not.toThrow();
  });
  it.each([{ demo: { '.': '1.0.0' } }, { 'demo@1': '1.0.0' }, { demo: '$missing' },
    { demo: 'npm:other@1.0.0' }, { demo: 'file:../demo' }, { demo: 'https://example.com/demo.tgz' },
    { demo: 'git+ssh://example.com/demo' }, { demo: 'not-a-version' }])('explains unsupported overrides %j', overrides => {
    expect(() => validatePatchInput(JSON.stringify({ dependencies: { demo: '^1.0.0' }, overrides }), lock())).toThrow('overrides[');
  });
  it('permits same-major security updates without editing the manifest', () => {
    expect(validatePatchResult(manifest, lock(), { lockfile: lock('1.0.1'), before: 2, after: 1, changes: [] })).toEqual([
      { path: 'node_modules/demo', from: '1.0.0', to: '1.0.1' },
    ]);
  });
  it.each(['2.0.0', '0.9.0'])('rejects incompatible version %s', version => {
    expect(() => validatePatchResult(manifest, lock(), { lockfile: lock(version), before: 2, after: 0, changes: [] })).toThrow();
  });
  it('rejects pre-1.0 minor upgrades', () => {
    expect(() => validatePatchResult(manifest, lock('0.1.0'), { lockfile: lock('0.2.0'), before: 2, after: 0, changes: [] })).toThrow();
  });
  it('requires a measured reduction, not a successful command alone', () => {
    expect(() => validatePatchResult(manifest, lock(), { lockfile: lock('1.0.1'), before: 1, after: 1, changes: [] })).toThrow();
  });
  it.each(['https://registry.npmjs.org.evil.test/demo', 'http://169.254.169.254/foo', 'git+ssh://example.com/foo'])('rejects non-registry resolution %s', url => {
    expect(() => validatePatchInput(manifest, lock().replace('https://registry.npmjs.org/demo/-/demo.tgz', url))).toThrow();
  });
  it('rejects workspaces, git dependencies and missing integrity', () => {
    expect(() => validatePatchInput(JSON.stringify({ workspaces: ['packages/*'] }), lock())).toThrow();
    expect(() => validatePatchInput(manifest.replace('^1.0.0', 'github:owner/repo'), lock())).toThrow();
    expect(() => validatePatchInput(manifest, lock().replace('sha512-YWJj', ''))).toThrow();
  });
  it('isolates execution without repo or cluster credentials', () => {
    const pod = patchJob('test', manifest, lock()).spec!.template.spec!;
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext?.runAsNonRoot).toBe(true);
    expect(pod.containers[0].securityContext?.readOnlyRootFilesystem).toBe(true);
    expect(pod.containers[0].env?.map(v => v.name)).toEqual(['PATCH_INPUT', 'NODE_OPTIONS']);
    expect(pod.volumes).toEqual([{ name: 'work', emptyDir: { sizeLimit: '1Gi' } }]);
  });
});
