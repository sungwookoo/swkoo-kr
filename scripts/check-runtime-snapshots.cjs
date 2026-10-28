// Classify real isolated fixture snapshots using the built backend service.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { DeployStatusService } = require('../apps/backend/dist/deploy/deploy-status.service.js');
const snapshots = JSON.parse(fs.readFileSync(process.argv[2] ?? 0, 'utf8'));
(async () => {
  for (const [name, reason] of Object.entries({ oom: 'MEMORY_LIMIT_EXCEEDED', capacity: 'CLUSTER_CAPACITY_PENDING', database: 'POD_NOT_READY' })) {
    const fixture = snapshots[name];
    assert.equal(fixture.deployment.metadata.namespace, 'user-swkoo-failure-validation');
    const image = fixture.deployment.spec.template.spec.containers[0].image;
    const digest = image.split('@')[1];
    const service = new DeployStatusService({}, {}, {}, {
      apps: { readNamespacedDeployment: async () => fixture.deployment },
      core: { listNamespacedPod: async () => fixture.pods },
    }, {});
    const result = await service.checkRuntime('sungwookoo', 'sprintflow', digest);
    assert.equal(result.reason, reason);
    assert.equal(result.status, name === 'capacity' ? 'running' : 'failed');
    assert.ok(result.userAction?.label);
    console.log(`${name}: ${result.reason} (${result.status})`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
