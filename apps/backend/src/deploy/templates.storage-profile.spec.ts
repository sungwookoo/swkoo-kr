import {
  parseStorageProfileBlock,
  renderDeployRepoFiles,
  renderUserRegistration,
  renderUserRepoFiles,
} from './templates';
import type { RenderParams } from './templates';

/** Renders for both stateless and Prisma-SQLite profiles. We assert
 *  on the YAML SHAPE — keys, indentation cues, image refs — not on
 *  byte-for-byte content. That way harmless formatting tweaks don't
 *  break the suite, but a missing volume mount or skipped strategy
 *  WILL. */
const BASE_PARAMS: RenderParams = {
  login: 'alice',
  appName: 'sample',
  imageRepo: 'ghcr.io/alice/sample',
  subdomain: 'alice-sample',
  port: 3000,
  uid: 1000,
  deployRepoFullName: 'swkoo-deploy/alice',
  sourceRepo: 'alice/sample',
  appsDomain: 'apps.swkoo.kr',
};

const PRISMA_PROFILE: NonNullable<RenderParams['storageProfile']> = {
  type: 'prisma-sqlite',
  size: '1Gi',
  mountPath: '/data',
  databaseUrl: 'file:/data/app.db',
  initMode: 'migrate-deploy',
};

describe('Persistent Storage Profile v0 — render outputs', () => {
  describe('stateless (no storageProfile)', () => {
    const files = renderDeployRepoFiles(BASE_PARAMS);

    it('does NOT emit <appName>/pvc.yaml', () => {
      expect(files['sample/pvc.yaml']).toBeUndefined();
    });

    it('kustomization.yaml has no pvc resource line', () => {
      expect(files['kustomization.yaml']).not.toMatch(/pvc\.yaml/);
    });

    it('deployment.yaml has no Recreate strategy, no fsGroup, no init container, no volumes', () => {
      const dep = files['sample/deployment.yaml'];
      expect(dep).not.toMatch(/strategy:/);
      expect(dep).not.toMatch(/fsGroup/);
      expect(dep).not.toMatch(/initContainers/);
      expect(dep).not.toMatch(/persistentVolumeClaim/);
      expect(dep).not.toMatch(/DATABASE_URL/);
    });

    it('metadata.yaml has no storage block', () => {
      const meta = renderUserRegistration(BASE_PARAMS);
      expect(meta).not.toMatch(/^storage:/m);
    });
  });

  describe('Prisma SQLite profile', () => {
    const params = { ...BASE_PARAMS, storageProfile: PRISMA_PROFILE };
    const files = renderDeployRepoFiles(params);

    it('emits <appName>/pvc.yaml with 1Gi / RWO / local-path / Prune=false', () => {
      const pvc = files['sample/pvc.yaml'];
      expect(pvc).toBeDefined();
      expect(pvc).toMatch(/kind: PersistentVolumeClaim/);
      expect(pvc).toMatch(/name: sample-data/);
      expect(pvc).toMatch(/namespace: user-alice/);
      expect(pvc).toMatch(/storage: 1Gi/);
      expect(pvc).toMatch(/ReadWriteOnce/);
      expect(pvc).toMatch(/storageClassName: local-path/);
      // ArgoCD must not prune the PVC if it disappears from desired state.
      expect(pvc).toMatch(/Prune=false/);
    });

    it('kustomization.yaml includes the pvc.yaml resource line', () => {
      expect(files['kustomization.yaml']).toMatch(/- sample\/pvc\.yaml/);
    });

    it('deployment.yaml uses strategy: Recreate', () => {
      expect(files['sample/deployment.yaml']).toMatch(/strategy:\s*\n\s*type:\s*Recreate/);
    });

    it('deployment.yaml has pod-level fsGroup matching the runAsUser uid + OnRootMismatch', () => {
      const dep = files['sample/deployment.yaml'];
      expect(dep).toMatch(/fsGroup:\s*1000/);
      expect(dep).toMatch(/fsGroupChangePolicy:\s*OnRootMismatch/);
    });

    it('deployment.yaml has a prisma-db-init initContainer mounted at /data', () => {
      const dep = files['sample/deployment.yaml'];
      expect(dep).toMatch(/initContainers:/);
      expect(dep).toMatch(/name:\s*prisma-db-init/);
      // Runtime probe + both branches:
      expect(dep).toMatch(/prisma migrate deploy/);
      expect(dep).toMatch(/prisma db push/);
      // Mount + env on the init container.
      expect(dep).toMatch(/mountPath:\s*\/data/);
      expect(dep).toMatch(/value:\s*file:\/data\/app\.db/);
    });

    it('app container has DATABASE_URL set explicitly (wins over envFrom) and mounts /data', () => {
      const dep = files['sample/deployment.yaml'];
      // explicit env block on the app container with the platform value.
      expect(dep.match(/value:\s*file:\/data\/app\.db/g)?.length).toBeGreaterThanOrEqual(2);
      // envFrom Secret reference is preserved alongside.
      expect(dep).toMatch(/secretRef:\s*\n\s*name:\s*sample-env/);
      // volumeMount on the app container — second mountPath /data in
      // the file (first is the init container).
      expect(dep.match(/mountPath:\s*\/data/g)?.length).toBeGreaterThanOrEqual(2);
    });

    it('deployment.yaml has top-level volumes with the per-app PVC claim', () => {
      const dep = files['sample/deployment.yaml'];
      expect(dep).toMatch(/volumes:/);
      expect(dep).toMatch(/persistentVolumeClaim:/);
      expect(dep).toMatch(/claimName:\s*sample-data/);
    });

    it('metadata.yaml emits the storage block (preservation guard reads this back)', () => {
      const meta = renderUserRegistration(params);
      expect(meta).toMatch(/^storage:/m);
      expect(meta).toMatch(/profile:\s*prisma-sqlite/);
      expect(meta).toMatch(/size:\s*1Gi/);
      expect(meta).toMatch(/mountPath:\s*\/data/);
      expect(meta).toMatch(/databaseUrl:\s*file:\/data\/app\.db/);
      expect(meta).toMatch(/initMode:\s*migrate-deploy/);
    });
  });

  describe('Dockerfile (single template, Prisma-aware at build time)', () => {
    const files = renderUserRepoFiles(BASE_PARAMS);
    const dockerfile = files['Dockerfile'];

    it('build stage runs prisma generate when schema present (guarded by -f)', () => {
      expect(dockerfile).toMatch(/if \[ -f prisma\/schema\.prisma \]; then npx --no-install prisma generate; fi/);
    });

    it('builder mkdirs prisma/ before COPY to keep stateless builds working', () => {
      expect(dockerfile).toMatch(/mkdir -p public prisma/);
    });

    it('runner stage installs openssl + tini + copies prisma/', () => {
      expect(dockerfile).toMatch(/apk add --no-cache tini openssl/);
      expect(dockerfile).toMatch(/COPY --from=builder --chown=node:node \/app\/prisma \.\/prisma/);
    });

    it('does NOT run db push / migrate deploy at build (those need runtime PVC)', () => {
      expect(dockerfile).not.toMatch(/prisma migrate deploy/);
      expect(dockerfile).not.toMatch(/prisma db push/);
    });
  });
});

describe('parseStorageProfileBlock — preservation guard', () => {
  it('parses the block emitted by renderUserRegistration round-trip', () => {
    const meta = renderUserRegistration({
      ...BASE_PARAMS,
      storageProfile: PRISMA_PROFILE,
    });
    expect(parseStorageProfileBlock(meta)).toEqual(PRISMA_PROFILE);
  });

  it('returns null when the metadata has no storage block (stateless app)', () => {
    const meta = renderUserRegistration(BASE_PARAMS);
    expect(parseStorageProfileBlock(meta)).toBeNull();
  });

  it('returns null on unknown profile values (forward compat — refuse to guess)', () => {
    const meta = `login: alice
appName: sample
storage:
  profile: experimental-mysql
  size: 5Gi
  mountPath: /var/lib/mysql
  databaseUrl: mysql://...
  initMode: db-push
`;
    expect(parseStorageProfileBlock(meta)).toBeNull();
  });

  it('defaults missing initMode to db-push (safer than migrate-deploy)', () => {
    const meta = `login: alice
appName: sample
storage:
  profile: prisma-sqlite
  size: 1Gi
  mountPath: /data
  databaseUrl: file:/data/app.db
`;
    expect(parseStorageProfileBlock(meta)?.initMode).toBe('db-push');
  });
});
