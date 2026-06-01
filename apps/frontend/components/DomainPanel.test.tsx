import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockedFunction,
} from 'vitest';

import type {
  DomainInfo,
  ReasonedError,
  registerDomain as registerDomainFn,
  useDomain as useDomainFn,
  verifyDomain as verifyDomainFn,
  deleteDomain as deleteDomainFn,
} from '@/lib/domain';

// Mock only the network/SWR surface — keep panelErrorText / buildZoneFile /
// zoneFileName / types untouched so the component renders real copy.
vi.mock('@/lib/domain', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/domain')>();
  return {
    ...orig,
    useDomain: vi.fn(),
    registerDomain: vi.fn(),
    verifyDomain: vi.fn(),
    deleteDomain: vi.fn(),
  };
});

import { DomainPanel } from './DomainPanel';
import * as domainLib from '@/lib/domain';

const mockUseDomain = domainLib.useDomain as MockedFunction<typeof useDomainFn>;
const mockRegisterDomain = domainLib.registerDomain as MockedFunction<typeof registerDomainFn>;
const mockVerifyDomain = domainLib.verifyDomain as MockedFunction<typeof verifyDomainFn>;
const mockDeleteDomain = domainLib.deleteDomain as MockedFunction<typeof deleteDomainFn>;

function setDomain(
  info: DomainInfo | undefined,
  errorOverride?: ReasonedError
): void {
  const refresh = vi.fn(async () => info);
  mockUseDomain.mockReturnValue({
    domain: info,
    isLoading: false,
    error: errorOverride,
    refresh,
  });
}

function emptyInfo(): DomainInfo {
  return {
    domain: null,
    status: null,
    scheme: null,
    verificationToken: null,
    dnsRecords: null,
    verifiedAt: null,
    lastError: null,
    lastErrorReason: null,
    registrableDomain: null,
    suggestedSubdomain: null,
    certificateReady: false,
    certificateError: null,
    url: null,
  };
}

function pendingCnameToken(): DomainInfo {
  return {
    ...emptyInfo(),
    domain: 'portfolio.zieun.dev',
    status: 'pending',
    scheme: 'cname_token',
    verificationToken: 'sk-tok123',
    dnsRecords: {
      txt: null,
      cname: {
        host: 'portfolio.zieun.dev',
        target: 'cd-sk-tok123.domains.swkoo.kr',
      },
    },
    registrableDomain: 'zieun.dev',
  };
}

function pendingTxtCnameLegacy(): DomainInfo {
  return {
    ...emptyInfo(),
    domain: 'www.zieun.dev',
    status: 'pending',
    scheme: 'txt_cname',
    verificationToken: 'sk-legacy',
    dnsRecords: {
      txt: {
        host: '_swkoo-challenge.www.zieun.dev',
        value: 'swkoo-domain-verification=sk-legacy',
      },
      cname: {
        host: 'www.zieun.dev',
        target: 'zieun-ai-portfolio.apps.swkoo.kr',
      },
    },
    registrableDomain: 'zieun.dev',
  };
}

function reasonedError(overrides: Partial<ReasonedError>): ReasonedError {
  const err = new Error(overrides.message ?? 'err') as ReasonedError;
  err.reason = overrides.reason;
  err.status = overrides.status;
  err.registrableDomain = overrides.registrableDomain;
  err.suggestedSubdomain = overrides.suggestedSubdomain;
  return err;
}

const panelProps = {
  login: 'alice',
  repo: 'nextjs-sample',
  fallbackLiveUrl: 'https://alice-nextjs-sample.apps.swkoo.kr',
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // Reset useDomain to a safe default so a forgotten setDomain in a test
  // doesn't bleed into the next.
  mockUseDomain.mockReset();
});

// ---------------- empty ----------------

describe('DomainPanel — empty state (cname_token framing)', () => {
  it('renders CNAME-한-줄 headline + placeholder + 도메인 추가 button', () => {
    setDomain(emptyInfo());
    render(<DomainPanel {...panelProps} />);

    expect(screen.getByText(/도메인 앞에 붙일 이름을 정하세요/)).toBeInTheDocument();
    expect(screen.getByText(/CNAME 한 줄만 추가하면 됩니다/)).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/www\.your-domain\.com 또는 portfolio\.your-domain\.com/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '도메인 추가' })).toBeInTheDocument();
  });
});

// ---------------- pending cname_token (1 record) ----------------

describe('DomainPanel — cname_token pending (single CNAME)', () => {
  it('shows CNAME row only, NO TXT row, with tokenized target', () => {
    setDomain(pendingCnameToken());
    render(<DomainPanel {...panelProps} />);

    // Single-record framing line is visible.
    expect(
      screen.getByText('CNAME 한 줄만 추가하면 됩니다.')
    ).toBeInTheDocument();

    // Tokenized target appears in the rendered Target field.
    expect(
      screen.getByText('cd-sk-tok123.domains.swkoo.kr')
    ).toBeInTheDocument();
    // The domain shows in multiple legitimate places (StatusLine + CNAME
    // Host field + provider-hints) — assert ≥1 occurrence.
    expect(
      screen.getAllByText('portfolio.zieun.dev').length
    ).toBeGreaterThanOrEqual(1);

    // TXT verification token must NOT be shown anywhere (token leaks would
    // confuse users on the cname_token scheme — only the CNAME target
    // carries it).
    expect(
      screen.queryByText(/swkoo-domain-verification=/)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/_swkoo-challenge\./)
    ).not.toBeInTheDocument();
    expect(screen.queryByText('1️⃣ TXT 레코드')).not.toBeInTheDocument();
  });
});

// ---------------- pending txt_cname (legacy 2 records) ----------------

describe('DomainPanel — txt_cname legacy (TXT + CNAME)', () => {
  it('shows BOTH TXT and CNAME rows with grandfather labels', () => {
    setDomain(pendingTxtCnameLegacy());
    render(<DomainPanel {...panelProps} />);

    expect(screen.getByText('1️⃣ TXT 레코드')).toBeInTheDocument();
    expect(screen.getByText('2️⃣ CNAME 레코드')).toBeInTheDocument();
    expect(
      screen.getByText('_swkoo-challenge.www.zieun.dev')
    ).toBeInTheDocument();
    expect(
      screen.getByText('swkoo-domain-verification=sk-legacy')
    ).toBeInTheDocument();
    expect(screen.getByText('zieun-ai-portfolio.apps.swkoo.kr')).toBeInTheDocument();
    // Single-record copy must NOT appear when both records are required.
    expect(
      screen.queryByText('CNAME 한 줄만 추가하면 됩니다.')
    ).not.toBeInTheDocument();
  });
});

// ---------------- APEX → www CTA ----------------

describe('DomainPanel — apex input triggers www suggestion CTA', () => {
  it('renders www.<domain> 사용하기 + 다른 이름 직접 입력 after a 400 APEX_NOT_SUPPORTED', async () => {
    const user = userEvent.setup();
    setDomain(emptyInfo());
    mockRegisterDomain.mockRejectedValueOnce(
      reasonedError({
        reason: 'APEX_NOT_SUPPORTED',
        message: '루트 도메인은 지원하지 않습니다.',
        registrableDomain: 'zieun.dev',
        suggestedSubdomain: 'www.zieun.dev',
      })
    );

    render(<DomainPanel {...panelProps} />);
    await user.type(
      screen.getByPlaceholderText(/your-domain\.com/),
      'zieun.dev'
    );
    await user.click(screen.getByRole('button', { name: '도메인 추가' }));

    // The suggestion CTA carries the host text + "사용하기"
    const cta = await screen.findByRole('button', {
      name: /www\.zieun\.dev 사용하기/,
    });
    expect(cta).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '다른 이름 직접 입력' })
    ).toBeInTheDocument();
    // The apex helper paragraph mentions the registrable domain. The
    // string `zieun.dev` appears many places (CTA, helper, link copy);
    // ≥1 occurrence is sufficient — narrower assertions are below in
    // the click-flow test.
    expect(screen.getAllByText(/zieun\.dev/).length).toBeGreaterThanOrEqual(1);
  });

  it('clicking the CTA submits the suggested www subdomain', async () => {
    const user = userEvent.setup();
    setDomain(emptyInfo());
    mockRegisterDomain
      .mockRejectedValueOnce(
        reasonedError({
          reason: 'APEX_NOT_SUPPORTED',
          message: '루트',
          registrableDomain: 'zieun.dev',
          suggestedSubdomain: 'www.zieun.dev',
        })
      )
      .mockResolvedValueOnce(pendingCnameToken());

    render(<DomainPanel {...panelProps} />);
    await user.type(
      screen.getByPlaceholderText(/your-domain\.com/),
      'zieun.dev'
    );
    await user.click(screen.getByRole('button', { name: '도메인 추가' }));
    const cta = await screen.findByRole('button', {
      name: /www\.zieun\.dev 사용하기/,
    });
    await user.click(cta);

    expect(mockRegisterDomain).toHaveBeenLastCalledWith(
      'alice',
      'nextjs-sample',
      'www.zieun.dev'
    );
  });
});

// ---------------- DNS_CNAME_CONFLICTS_WITH_A ----------------

describe('DomainPanel — conflict suggestion + prefix picker', () => {
  function conflictInfo(): DomainInfo {
    return {
      ...emptyInfo(),
      domain: 'www.zieun.dev',
      status: 'error',
      scheme: 'cname_token',
      verificationToken: 'sk-tok456',
      dnsRecords: {
        txt: null,
        cname: {
          host: 'www.zieun.dev',
          target: 'cd-sk-tok456.domains.swkoo.kr',
        },
      },
      lastError: 'www.zieun.dev은 다른 서비스로 연결된 A 레코드가 …',
      lastErrorReason: 'DNS_CNAME_CONFLICTS_WITH_A',
      registrableDomain: 'zieun.dev',
      suggestedSubdomain: 'portfolio.zieun.dev',
    };
  }

  it('renders suggestion CTA + free-form prefix picker side-by-side', () => {
    setDomain(conflictInfo());
    render(<DomainPanel {...panelProps} />);

    expect(
      screen.getByRole('button', { name: /portfolio\.zieun\.dev 사용하기/ })
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('app')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '이 주소로 시도' })
    ).toBeInTheDocument();
    // Conflict copy still surfaces the backend message.
    expect(
      screen.getByText(/다른 서비스로 연결된 A 레코드가/)
    ).toBeInTheDocument();
  });

  it('prefix submit = delete current + register <prefix>.<registrable>', async () => {
    const user = userEvent.setup();
    setDomain(conflictInfo());
    mockDeleteDomain.mockResolvedValueOnce(undefined);
    mockRegisterDomain.mockResolvedValueOnce(pendingCnameToken());

    render(<DomainPanel {...panelProps} />);
    await user.type(screen.getByPlaceholderText('app'), 'demo');
    await user.click(screen.getByRole('button', { name: '이 주소로 시도' }));

    expect(mockDeleteDomain).toHaveBeenCalledWith('alice', 'nextjs-sample');
    expect(mockRegisterDomain).toHaveBeenCalledWith(
      'alice',
      'nextjs-sample',
      'demo.zieun.dev'
    );
  });
});

// ---------------- verified (needs explicit /verify retry) ----------------

describe('DomainPanel — verified state retries via POST /verify (not refresh)', () => {
  function verifiedInfo(): DomainInfo {
    return {
      ...emptyInfo(),
      domain: 'portfolio.zieun.dev',
      status: 'verified',
      scheme: 'cname_token',
      verificationToken: 'sk-verif',
      dnsRecords: null,
      verifiedAt: '2026-06-01T00:00:00.000Z',
      registrableDomain: 'zieun.dev',
    };
  }

  it('shows "적용 재시도" button that calls verifyDomain', async () => {
    const user = userEvent.setup();
    setDomain(verifiedInfo());
    mockVerifyDomain.mockResolvedValueOnce({
      ...verifiedInfo(),
      status: 'applying',
    });
    render(<DomainPanel {...panelProps} />);

    const retryBtn = screen.getByRole('button', { name: '적용 재시도' });
    expect(retryBtn).toBeInTheDocument();
    expect(
      screen.getByText(/DNS 확인 완료 · 적용 재시도 필요/)
    ).toBeInTheDocument();

    await user.click(retryBtn);
    expect(mockVerifyDomain).toHaveBeenCalledWith('alice', 'nextjs-sample');
    expect(mockVerifyDomain).toHaveBeenCalledTimes(1);
  });
});

// ---------------- guard rejections — panel hidden ----------------

describe('DomainPanel — guard errors hide the panel entirely', () => {
  it.each([
    { reason: 'NO_DEPLOYMENT', status: 404, label: 'pre-deploy' },
    { reason: 'REPO_NOT_CURRENT', status: 409, label: 'wrong-repo' },
  ])('hides panel for $reason ($label)', ({ reason, status }) => {
    setDomain(undefined, reasonedError({ reason, status }));
    const { container } = render(<DomainPanel {...panelProps} />);
    // The panel returns null → nothing rendered. Headline must be absent.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('커스텀 도메인')).not.toBeInTheDocument();
  });
});

// ---------------- permission errors — message only, no form ----------------

describe('DomainPanel — permission errors render message only (no input form)', () => {
  it.each([
    { reason: 'NOT_OWNER', status: 403, expectMatch: /본인 앱의 도메인/ },
    { reason: 'NOT_ALLOWED', status: 403, expectMatch: /도메인 관리 권한이 없습니다/ },
    // 401 has no machine reason — status-only branch
    { reason: undefined, status: 401, expectMatch: /로그인이 필요합니다/ },
  ])('$reason / $status → message rendered, no input/도메인 추가 button', ({
    reason,
    status,
    expectMatch,
  }) => {
    setDomain(undefined, reasonedError({ reason, status }));
    render(<DomainPanel {...panelProps} />);

    // Panel header still present (this is panel-internal error, not guard hide).
    expect(screen.getByText('커스텀 도메인')).toBeInTheDocument();
    // Error copy appears.
    expect(screen.getByText(expectMatch)).toBeInTheDocument();
    // Critically: no input + no submit button (the EmptyState form must
    // not render when loadError is set).
    expect(
      screen.queryByPlaceholderText(/your-domain\.com/)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '도메인 추가' })
    ).not.toBeInTheDocument();
  });
});
