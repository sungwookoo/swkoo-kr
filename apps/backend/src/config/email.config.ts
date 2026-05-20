import { registerAs } from '@nestjs/config';

export interface EmailConfig {
  // True when both API key and From are set. If either is missing the
  // email feature is silently disabled — backend stays bootable in dev
  // and during pre-launch operator setup.
  enabled: boolean;
  resendApiKey: string;
  // Display name + envelope, e.g., "swkoo.kr <noreply@swkoo.kr>". The
  // From domain must be verified in the Resend dashboard for delivery
  // to actually reach inboxes.
  from: string;
  // Where deploy-complete notifications link back to. Defaults to
  // production swkoo.kr; overridable for staging if we ever have one.
  appBaseUrl: string;
}

export const emailConfig = registerAs('email', (): EmailConfig => {
  const apiKey = process.env.RESEND_API_KEY ?? '';
  const from = process.env.EMAIL_FROM ?? '';
  return {
    resendApiKey: apiKey,
    from,
    appBaseUrl: process.env.APP_BASE_URL ?? 'https://swkoo.kr',
    enabled: Boolean(apiKey && from),
  };
});
