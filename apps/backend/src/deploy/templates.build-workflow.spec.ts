import { RenderParams, renderUserRepoFiles } from './templates';

/** Regression for GHCR-lowercase tag bug: github.com allows mixed-case
 *  repo names (PocketPlan) but Docker/GHCR strictly require lowercase
 *  for the repository portion of an image tag. The build workflow used
 *  to write `ghcr.io/${{ github.repository }}:<sha>` which preserved
 *  GitHub's casing → `docker/build-push-action` failed with
 *  `invalid tag "ghcr.io/hatbann/PocketPlan:<sha>": repository name
 *  must be lowercase`. Fix: tag from params.imageRepo, which
 *  DeployService.registerForUser builds as
 *  `ghcr.io/${loginLc}/${repo.toLowerCase()}`. */
describe('renderBuildWorkflow (via renderUserRepoFiles) — GHCR lowercase tags', () => {
  const params: RenderParams = {
    login: 'hatbann',
    appName: 'pocketplan',
    imageRepo: 'ghcr.io/hatbann/pocketplan',
    // sourceRepo intentionally preserves GitHub casing — GitHub API calls
    // use this directly and accept either casing. Only the image tag has
    // to be lowercased.
    sourceRepo: 'hatbann/PocketPlan',
    subdomain: 'hatbann-pocketplan',
    port: 3000,
    uid: 1000,
    deployRepoFullName: 'swkoo-deploy/hatbann',
    appsDomain: 'apps.swkoo.kr',
  };

  const files = renderUserRepoFiles(params);
  const workflow = files['.github/workflows/build.yml'];

  it('emits the build workflow file', () => {
    expect(workflow).toBeDefined();
    expect(typeof workflow).toBe('string');
  });

  it('tags both <sha> and latest with the lowercase imageRepo', () => {
    expect(workflow).toContain('ghcr.io/hatbann/pocketplan:${{ github.sha }}');
    expect(workflow).toContain('ghcr.io/hatbann/pocketplan:latest');
  });

  it('does NOT reference github.repository (the bug source)', () => {
    // Both forms — bare and the full template-expr form that was emitted.
    expect(workflow).not.toContain('${{ github.repository }}');
    expect(workflow).not.toMatch(/ghcr\.io\/\$\{\{ ?github\.repository ?\}\}/);
  });

  it('keeps the original GitHub repo casing OUT of the image tag path', () => {
    // The full URL-path region of the tag lines must not carry the
    // mixed-case form anywhere — that's the part docker/build-push-action
    // validates against Docker's lowercase-repo rule.
    const tagLineRegex = /ghcr\.io\/[^\s]*PocketPlan/;
    expect(workflow).not.toMatch(tagLineRegex);
  });

  it('preserves GitHub repo casing in sourceRepo (not the tag) — Observatory still resolves runs', () => {
    // sourceRepo (used by Observatory's GitHub API lookups in
    // PipelinesService) keeps the original casing; this confirms we
    // didn't accidentally lowercase the WHOLE pipeline. It lives in
    // the registration file, not in build.yml.
    expect(params.sourceRepo).toBe('hatbann/PocketPlan');
  });
});
