import { registerAs } from '@nestjs/config';

export interface OnboardingConfig {
  githubAppId: string | undefined;
  // URL-safe app slug, used to build the install URL
  // (https://github.com/apps/<slug>/installations/new). Distinct from the
  // numeric appId.
  githubAppSlug: string | undefined;
  githubAppClientId: string | undefined;
  githubAppClientSecret: string | undefined;
  githubAppPrivateKey: string | undefined;
  jwtSecret: string | undefined;
  appBaseUrl: string;
  brandName: string;
  // CSV of github logins seeded into users.is_allowed on boot (Phase 2.7+).
  // Empty list = no auto-seed; everyone signs in but nobody passes the deploy
  // gate until granted via /admin.
  deployAllowlist: string[];
  // CSV of github logins authorized for /admin/* routes. Always env-managed
  // (no DB or UI flow to elevate admin). Empty = nobody is admin.
  adminLogins: string[];
  // Discord webhook URL fired on first sign-in for a given github_id. Empty
  // disables notifications. Failures are logged but don't block sign-in.
  discordWebhookUrl: string | undefined;
  // Discord webhook URL fired when a user's deploy GHA workflow fails.
  // Separate channel from signup so operator can route them differently.
  discordBuildFailureWebhookUrl: string | undefined;
  // Discord webhook URL fired when the daily Trivy scan finds new
  // critical/high vulns in a user's image. Empty disables notifications.
  discordScanWebhookUrl: string | undefined;
  // Control repo where /api/deploy/register writes a small per-user
  // registration file (deploy/users/<login>.yaml) for ApplicationSet.
  manifestRepo: string; // "<owner>/<name>", e.g. "sungwookoo/swkoo-kr"
  manifestBranch: string;
  // GitHub org that owns one private deploy repo per user
  // (<deployOwner>/<login>). The org installation needs Administration:write
  // for repo creation and per-repo Administration:write for archive on
  // unregister.
  deployOwner: string;
  appsDomain: string; // for subdomain construction, e.g. "apps.swkoo.kr"
}

export const onboardingConfig = registerAs(
  'onboarding',
  (): OnboardingConfig => ({
    githubAppId: process.env.GITHUB_APP_ID,
    githubAppSlug: process.env.GITHUB_APP_SLUG,
    githubAppClientId: process.env.GITHUB_APP_CLIENT_ID,
    githubAppClientSecret: process.env.GITHUB_APP_CLIENT_SECRET,
    githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    jwtSecret: process.env.JWT_SECRET,
    appBaseUrl: process.env.APP_BASE_URL ?? 'https://swkoo.kr',
    brandName: process.env.BRAND_NAME ?? 'swkoo.kr',
    deployAllowlist: (process.env.DEPLOY_ALLOWLIST ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    adminLogins: (process.env.ADMIN_LOGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || undefined,
    discordBuildFailureWebhookUrl: process.env.DISCORD_BUILD_FAILURE_WEBHOOK_URL || undefined,
    discordScanWebhookUrl: process.env.DISCORD_SCAN_WEBHOOK_URL || undefined,
    manifestRepo: process.env.MANIFEST_REPO ?? 'sungwookoo/swkoo-kr',
    manifestBranch: process.env.MANIFEST_BRANCH ?? 'main',
    deployOwner: process.env.GITHUB_DEPLOY_OWNER ?? 'swkoo-deploy',
    appsDomain: process.env.APPS_DOMAIN ?? 'apps.swkoo.kr',
  })
);
