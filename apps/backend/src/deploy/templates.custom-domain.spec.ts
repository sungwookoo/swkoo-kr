import {
  RenderParams,
  getCustomDomainIngressPath,
  renderDeployRepoFiles,
} from './templates';

const baseParams: RenderParams = {
  login: 'alice',
  appName: 'nextjs-sample',
  imageRepo: 'ghcr.io/alice/nextjs-sample',
  subdomain: 'alice-nextjs-sample',
  port: 3000,
  uid: 1000,
  deployRepoFullName: 'swkoo-deploy/alice',
  sourceRepo: 'alice/nextjs-sample',
  appsDomain: 'apps.swkoo.kr',
};

/** Regression test for the re-render preservation invariant: rendering
 *  without `customDomain` must NOT emit the custom-domain-ingress.yaml
 *  file and must NOT add an entry to kustomization.yaml — otherwise a
 *  user's redeploy would unintentionally wipe (when params is built
 *  without checking the DB) or fabricate (when params accidentally has
 *  the field set) the custom ingress. */
describe('renderDeployRepoFiles — base output (no custom domain)', () => {
  const files = renderDeployRepoFiles(baseParams);

  it('does not emit custom-domain-ingress.yaml', () => {
    expect(files[getCustomDomainIngressPath('nextjs-sample')]).toBeUndefined();
  });

  it('kustomization.yaml has no reference to custom-domain-ingress', () => {
    expect(files['kustomization.yaml']).not.toContain('custom-domain-ingress');
  });

  it('emits the expected 10 base files', () => {
    expect(Object.keys(files).sort()).toEqual(
      [
        'kustomization.yaml',
        'limit-range.yaml',
        'namespace.yaml',
        'network-policy.yaml',
        'nextjs-sample/deployment.yaml',
        'nextjs-sample/ingress.yaml',
        'nextjs-sample/service.yaml',
        'resource-quota.yaml',
        'role-binding.yaml',
        'role.yaml',
      ].sort()
    );
  });

  it('role.yaml grants cert-manager certificates get/list', () => {
    // Domain panel reads Certificate state live; without this RBAC the
    // panel always shows certificateReady=false.
    const role = files['role.yaml'];
    expect(role).toContain('cert-manager.io');
    expect(role).toContain('certificates');
    expect(role).toMatch(/verbs:\s*\["get",\s*"list"\]/);
  });
});

describe('renderDeployRepoFiles — with custom domain', () => {
  const params: RenderParams = {
    ...baseParams,
    customDomain: { domain: 'app.alice-example-host.com' },
  };
  const files = renderDeployRepoFiles(params);

  it('emits the custom-domain-ingress.yaml file', () => {
    const path = getCustomDomainIngressPath('nextjs-sample');
    expect(files[path]).toBeDefined();
    expect(files[path]).toContain('host: app.alice-example-host.com');
    expect(files[path]).toContain('secretName: nextjs-sample-custom-domain-tls');
    expect(files[path]).toContain('cert-manager.io/cluster-issuer: letsencrypt-prod');
    expect(files[path]).toContain('ingressClassName: traefik');
  });

  it('kustomization.yaml includes the custom ingress entry', () => {
    expect(files['kustomization.yaml']).toContain(
      'nextjs-sample/custom-domain-ingress.yaml'
    );
  });

  it('does not duplicate the base ingress resource entry', () => {
    // The base ingress entry must stay (default <slug>.apps.swkoo.kr URL),
    // and the custom one is additive. Catch a regex bug that might
    // replace instead of append.
    const k = files['kustomization.yaml'];
    expect(k).toContain('nextjs-sample/ingress.yaml');
    expect(k).toContain('nextjs-sample/custom-domain-ingress.yaml');
  });

  it('custom Ingress backend points at the same Service as the base Ingress', () => {
    // Both must terminate at port 80 of `<appName>` Service — same backend,
    // different hostnames. Mistake here would route the custom domain to
    // a non-existent Service.
    const customIngress = files[getCustomDomainIngressPath('nextjs-sample')];
    expect(customIngress).toContain('name: nextjs-sample');
    expect(customIngress).toContain('number: 80');
  });
});
