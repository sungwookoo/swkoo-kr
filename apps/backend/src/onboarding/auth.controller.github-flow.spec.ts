import type { ConfigType } from '@nestjs/config';
import type { Request, Response } from 'express';

import type { onboardingConfig } from '../config/onboarding.config';
import { AuthController } from './auth.controller';
import { AuthService, OAUTH_STATE_COOKIE, SESSION_COOKIE } from './auth.service';
import type { UsersRepository, UserRow } from './users.repository';

/** Captures res.redirect / res.cookie / res.clearCookie calls. */
function makeRes() {
  const cookies: Array<{ name: string; value: string }> = [];
  const cleared: string[] = [];
  let redirectedTo: string | null = null;
  const res = {
    cookie: (name: string, value: string) => {
      cookies.push({ name, value });
      return res;
    },
    clearCookie: (name: string) => {
      cleared.push(name);
      return res;
    },
    redirect: (url: string) => {
      redirectedTo = url;
    },
    send: () => res,
  } as unknown as Response;
  return {
    res,
    cookies,
    cleared,
    get redirectedTo() {
      return redirectedTo;
    },
  };
}

function makeReq(query: Record<string, string>, cookies: Record<string, string> = {}): Request {
  return { query, cookies } as unknown as Request;
}

const config = {
  githubAppClientId: 'Iv1.abc123',
  githubAppSlug: 'swkoo-deploy',
  githubAppClientSecret: 'secret',
  appBaseUrl: 'https://swkoo.kr',
  adminLogins: [],
  brandName: 'swkoo.kr',
} as unknown as ConfigType<typeof onboardingConfig>;

describe('AuthController — GitHub App install vs login flow', () => {
  function makeController(authOverrides: Partial<AuthService> = {}) {
    // AuthService(config, users) — config first per the constructor.
    const realAuth = new AuthService(
      config,
      { findByLogin: jest.fn() } as unknown as UsersRepository
    );
    const auth = Object.assign(realAuth, authOverrides);
    const users = {} as UsersRepository;
    const controller = new AuthController(auth, users, config);
    return { controller, auth };
  }

  it('GET /github/login redirects to the OAuth authorize URL', () => {
    const { controller } = makeController();
    const cap = makeRes();
    controller.startOauth(cap.res);

    expect(cap.redirectedTo).toMatch(
      /^https:\/\/github\.com\/login\/oauth\/authorize\?/
    );
    expect(cap.redirectedTo).toContain('client_id=Iv1.abc123');
    expect(cap.redirectedTo).toContain('state=');
    // sets the state cookie for CSRF protection on callback
    expect(cap.cookies.some((c) => c.name === OAUTH_STATE_COOKIE)).toBe(true);
  });

  it('GET /github/install redirects to the App installations/new URL', () => {
    const { controller } = makeController();
    const cap = makeRes();
    controller.startInstall(cap.res);

    expect(cap.redirectedTo).toMatch(
      /^https:\/\/github\.com\/apps\/swkoo-deploy\/installations\/new\?/
    );
    expect(cap.redirectedTo).toContain('state=');
    // NOT the OAuth authorize URL
    expect(cap.redirectedTo).not.toContain('/login/oauth/authorize');
    // state cookie set so an OAuth-during-install callback validates
    expect(cap.cookies.some((c) => c.name === OAUTH_STATE_COOKIE)).toBe(true);
  });

  it('login and install set distinct state values (independent CSRF tokens)', () => {
    const { controller } = makeController();
    const loginCap = makeRes();
    const installCap = makeRes();
    controller.startOauth(loginCap.res);
    controller.startInstall(installCap.res);
    const loginState = loginCap.cookies.find((c) => c.name === OAUTH_STATE_COOKIE)?.value;
    const installState = installCap.cookies.find((c) => c.name === OAUTH_STATE_COOKIE)?.value;
    expect(loginState).toBeTruthy();
    expect(installState).toBeTruthy();
    expect(loginState).not.toBe(installState);
  });

  describe('callback', () => {
    it('setup_action only (no code) → clears state cookie + bounces to /deploy', async () => {
      const { controller } = makeController();
      const cap = makeRes();
      const req = makeReq({ setup_action: 'install', installation_id: '12345' });
      await controller.handleCallback(req, cap.res);

      expect(cap.redirectedTo).toBe('https://swkoo.kr/deploy');
      expect(cap.cleared).toContain(OAUTH_STATE_COOKIE);
    });

    it('code + matching state → creates session cookie + redirects to /deploy', async () => {
      const fakeUser = { id: 1, githubLogin: 'alice' } as UserRow;
      const { controller } = makeController({
        exchangeCodeForUser: jest.fn(async () => fakeUser),
        signSessionToken: jest.fn(() => 'signed-jwt'),
      });
      const cap = makeRes();
      const req = makeReq({ code: 'oauth-code', state: 'st-123' }, { [OAUTH_STATE_COOKIE]: 'st-123' });
      await controller.handleCallback(req, cap.res);

      expect(cap.cookies.some((c) => c.name === SESSION_COOKIE && c.value === 'signed-jwt')).toBe(true);
      expect(cap.redirectedTo).toBe('https://swkoo.kr/deploy');
    });

    it('code + installation_id + setup_action together (OAuth-during-install) → session created', async () => {
      // The install flow with "Request user authorization during installation"
      // returns ALL of code/state/installation_id/setup_action. Must still
      // create the session (code path wins over the setup_action-only bounce).
      const fakeUser = { id: 7, githubLogin: 'newbie' } as UserRow;
      const exchange = jest.fn(async () => fakeUser);
      const { controller } = makeController({
        exchangeCodeForUser: exchange,
        signSessionToken: jest.fn(() => 'jwt-newbie'),
      });
      const cap = makeRes();
      const req = makeReq(
        {
          code: 'oauth-code',
          state: 'st-xyz',
          installation_id: '98765',
          setup_action: 'install',
        },
        { [OAUTH_STATE_COOKIE]: 'st-xyz' }
      );
      await controller.handleCallback(req, cap.res);

      expect(exchange).toHaveBeenCalledWith('oauth-code');
      expect(cap.cookies.some((c) => c.name === SESSION_COOKIE)).toBe(true);
      expect(cap.redirectedTo).toBe('https://swkoo.kr/deploy');
    });

    it('code with mismatched state → rejected (CSRF guard)', async () => {
      const { controller } = makeController();
      const cap = makeRes();
      const req = makeReq({ code: 'c', state: 'attacker' }, { [OAUTH_STATE_COOKIE]: 'real' });
      await expect(controller.handleCallback(req, cap.res)).rejects.toThrow(/invalid oauth state/);
    });
  });
});
