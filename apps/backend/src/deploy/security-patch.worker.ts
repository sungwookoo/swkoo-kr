import type { V1Job } from '@kubernetes/client-node';
import { gzipSync } from 'node:zlib';

// Only trusted code executes. User lifecycle scripts, .npmrc, source code and
// credentials are never copied into this worker. No shell interpolation.
export const PATCH_WORKER_SCRIPT = `
const fs=require('fs'), zlib=require('zlib'), cp=require('child_process');
const input=JSON.parse(zlib.gunzipSync(Buffer.from(process.env.PATCH_INPUT,'base64')));
process.chdir('/tmp');
const options={encoding:'utf8',timeout:90000,maxBuffer:4000000,env:{PATH:process.env.PATH,HOME:'/tmp',npm_config_cache:'/tmp/cache',npm_config_ignore_scripts:'true',npm_config_registry:'https://registry.npmjs.org/'}};
try {
 const setup=cp.spawnSync('npm',['install','--prefix','/tmp/tool','npm@11.19.1','--ignore-scripts','--no-audit','--no-fund'],options);
 if(setup.status!==0) throw Error('npm 준비 실패');
 fs.mkdirSync('/tmp/work'); process.chdir('/tmp/work');
 fs.writeFileSync('package.json',input.manifest);fs.writeFileSync('package-lock.json',input.lockfile);
 const run=(args)=>{const r=cp.spawnSync('node',['/tmp/tool/node_modules/npm/bin/npm-cli.js',...args,'--json','--ignore-scripts','--registry=https://registry.npmjs.org/','--no-fund'],options);if(r.error||r.signal||![0,1].includes(r.status))throw Error('npm 검사 실패');const data=JSON.parse(r.stdout);if(data.error)throw Error('npm 검사 실패');return data;};
 const before=run(['audit','--package-lock-only']).metadata.vulnerabilities.total;
 run(['audit','fix','--package-lock-only']);
 const after=run(['audit','--package-lock-only']).metadata.vulnerabilities.total;
 if(fs.readFileSync('package.json','utf8')!==input.manifest)throw Error('package.json 변경 감지');
 console.log(JSON.stringify({lockfile:fs.readFileSync('package-lock.json','utf8'),before,after}));
} catch(e){console.log(JSON.stringify({error:e.message}));process.exitCode=1;}
`;

export function patchJob(id: string, manifest: string, lockfile: string): V1Job {
  const input = gzipSync(JSON.stringify({ manifest, lockfile })).toString('base64');
  if (input.length > 90_000) throw new Error('압축된 입력이 너무 큽니다. 수동 PR을 사용하세요.');
  return {
    apiVersion: 'batch/v1', kind: 'Job',
    metadata: { name: `security-patch-${id}`, namespace: 'swkoo' },
    spec: {
      backoffLimit: 0, activeDeadlineSeconds: 360, ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels: { 'swkoo.kr/security-patch': 'true' } },
        spec: {
          restartPolicy: 'Never', automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [{
            name: 'patch', image: 'node:24.18.1-alpine', command: ['node', '-e', PATCH_WORKER_SCRIPT],
            env: [{ name: 'PATCH_INPUT', value: input }, { name: 'NODE_OPTIONS', value: '--max-old-space-size=320' }],
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
            resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '500m', memory: '512Mi', 'ephemeral-storage': '1Gi' } },
            volumeMounts: [{ name: 'work', mountPath: '/tmp' }],
          }],
          volumes: [{ name: 'work', emptyDir: { sizeLimit: '1Gi' } }],
        },
      },
    },
  };
}
