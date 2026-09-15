// Run after `npm --prefix apps/backend run build`.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const backendRequire = createRequire(path.resolve(__dirname, '../apps/backend/package.json'));
const yaml = backendRequire('js-yaml');
const { renderDeployRepoFiles } = require('../apps/backend/dist/deploy/templates');
const result = {};
for (const suffix of ['a', 'b']) {
  const login = `swkoo-validation-${suffix}`;
  const files = renderDeployRepoFiles({
    login, appName: 'probe', imageRepo: 'ghcr.io/sungwookoo/sprintflow',
    subdomain: login, port: 3000, uid: 1000, deployRepoFullName: 'unused',
    sourceRepo: 'unused', appsDomain: 'apps.swkoo.kr',
    storageProfile: { type: 'prisma-sqlite', size: '1Gi', mountPath: '/data',
      databaseUrl: 'file:/data/app.db', initMode: 'migrate-deploy' },
  });
  result[suffix] = Object.fromEntries(Object.entries(files)
    .filter(([name]) => name.endsWith('.yaml')).map(([name, text]) => [name, yaml.load(text)]));
}
fs.writeFileSync(process.argv[2], JSON.stringify(result));
