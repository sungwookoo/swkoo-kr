import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import type { Request, Response } from 'express';

import { onboardingConfig } from '../config/onboarding.config';
import { AuthService, OAUTH_STATE_COOKIE, SESSION_COOKIE } from './auth.service';
import { UsersRepository } from './users.repository';

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

/** Bump this when /privacy or /terms changes substantively — users with a
 * stored version != this constant are routed through /consent on next
 * gated-page visit. Keep in sync with the 시행일자 on both policy pages. */
export const CURRENT_POLICY_VERSION = '2026-05-14';

function readCookie(req: Request, name: string): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value : undefined;
}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersRepository,
    @Inject(onboardingConfig.KEY)
    private readonly config: ConfigType<typeof onboardingConfig>
  ) {}

  /** Pure OAuth login — for returning users who already installed the
   * App. Redirects to GitHub's OAuth authorize screen (Authorized GitHub
   * Apps). Does NOT grant repo access; new users should use /install. */
  @Get('github/login')
  startOauth(@Res() res: Response): void {
    const state = this.auth.generateOauthState();
    const url = this.auth.buildAuthorizeUrl(state);

    res.cookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: STATE_MAX_AGE_MS,
      path: '/',
    });

    res.redirect(url);
  }

  /** GitHub App installation — for new users. Redirects to the App's
   * installations/new screen (Installed GitHub Apps) so the user grants
   * repo access. The shared OAuth state cookie is set here too: if the
   * App has "Request user authorization during installation" enabled,
   * the callback receives `code` + `state` and creates the session in
   * the same flow; otherwise it gets `setup_action` only and bounces to
   * /deploy for a follow-up login. */
  @Get('github/install')
  startInstall(@Res() res: Response): void {
    const state = this.auth.generateOauthState();
    const url = this.auth.buildInstallUrl(state);

    res.cookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: STATE_MAX_AGE_MS,
      path: '/',
    });

    res.redirect(url);
  }

  @Get('github/callback')
  async handleCallback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const setupAction =
      typeof req.query.setup_action === 'string' ? req.query.setup_action : undefined;
    const expectedState = readCookie(req, OAUTH_STATE_COOKIE);

    // Setup callback fired without an OAuth code. Two cases:
    //  - User adjusted an installation's repo selection from GitHub directly
    //    while already signed in.
    //  - User went through /install but the App doesn't request OAuth during
    //    installation, so only setup_action came back.
    // Either way there's nothing to exchange; clear the state cookie we may
    // have set on /install and bounce to /deploy (they sign in there).
    if (!code && setupAction) {
      res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });
      res.redirect(`${this.config.appBaseUrl}/deploy`);
      return;
    }

    if (!code || !state) {
      throw new BadRequestException('missing code or state');
    }
    if (!expectedState || state !== expectedState) {
      throw new BadRequestException('invalid oauth state');
    }

    res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });

    try {
      const user = await this.auth.exchangeCodeForUser(code);
      const token = this.auth.signSessionToken(user);
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: SESSION_MAX_AGE_MS,
        path: '/',
      });
      res.redirect(`${this.config.appBaseUrl}/deploy`);
    } catch (err) {
      this.logger.error(`OAuth callback failed: ${(err as Error).message}`);
      res.redirect(`${this.config.appBaseUrl}/deploy?error=oauth_failed`);
    }
  }

  @Get('me')
  getMe(@Req() req: Request): unknown {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) {
      throw new UnauthorizedException();
    }
    const payload = this.auth.verifySessionToken(token);
    if (!payload) {
      throw new UnauthorizedException();
    }
    const user = this.users.findById(payload.uid);
    if (!user) {
      throw new UnauthorizedException();
    }
    // requiresReauth = user signed in before token storage existed, or refresh
    // chain broke. Frontend should prompt them to sign in again.
    const requiresReauth = this.users.getTokens(user.id) === null;
    const isAdmin = this.config.adminLogins
      .map((l) => l.toLowerCase())
      .includes(user.githubLogin.toLowerCase());
    return {
      id: user.id,
      githubLogin: user.githubLogin,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      isAllowed: user.isAllowed,
      isAdmin,
      requiresReauth,
      requiresConsent: user.policyVersion !== CURRENT_POLICY_VERSION,
      policyVersion: CURRENT_POLICY_VERSION,
      brandName: this.config.brandName,
    };
  }

  @Post('consent')
  @HttpCode(204)
  acceptConsent(
    @Req() req: Request,
    @Body() body: { version?: string },
    @Res() res: Response
  ): void {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) throw new UnauthorizedException();
    const payload = this.auth.verifySessionToken(token);
    if (!payload) throw new UnauthorizedException();
    const user = this.users.findById(payload.uid);
    if (!user) throw new UnauthorizedException();
    if (body?.version !== CURRENT_POLICY_VERSION) {
      throw new BadRequestException({
        reason: 'STALE_POLICY_VERSION',
        message: `expected version ${CURRENT_POLICY_VERSION}, got ${body?.version ?? 'null'}`,
        currentVersion: CURRENT_POLICY_VERSION,
      });
    }
    this.users.acceptPolicy(user.id, CURRENT_POLICY_VERSION);
    this.users.audit({
      actor: user.githubLogin,
      action: 'POLICY_ACCEPT',
      target: CURRENT_POLICY_VERSION,
      reason: null,
      metaJson: null,
    });
    res.send();
  }

  @Post('logout')
  @HttpCode(204)
  logout(@Res() res: Response): void {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.send();
  }
}
