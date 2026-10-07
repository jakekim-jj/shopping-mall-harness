'use strict';

/**
 * 로그인 화면 + API — tests/test-cases.ko.md
 *   "5차 사이클 — 회원가입 / 로그인 / 로그아웃" 중 로그인 관련 4개 섹션
 *   (PRD 20~26장, 매트릭스 B1~B18 + C12/D37/24.9 "다중 로그인")
 *
 * 구성 방식: BDD/시나리오 스타일 (auth-signup.spec.js 머릿말 참고). describe = 시나리오,
 * 테스트 제목 끝 [ ]는 PRD/매트릭스 각주, test-cases.ko.md 구조는 그대로 둔다.
 *
 * 규칙 (skills/shopping-mall-qa/SKILL.md)
 *   - data-testid 선택자만 쓴다.
 *   - D34(존재하지 않는 이메일과 틀린 비밀번호를 구별할 수 없어야 한다)는 "통과한다"로 끝내지 않고
 *     두 응답을 직접 비교해서 단언한다 (B4).
 *   - spec 파일 하나당 브라우저 컨텍스트(창)는 하나다. 아래 beforeAll에서 한 번만 만든다.
 *   - C12(다른 브라우저에서 동시 로그인)는 cart.spec.js의 8.5와 같은 이유로 창 하나 공유 규칙의
 *     명시적 예외다 — 그 테스트 안에서만 별도 컨텍스트를 추가로 연다.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'default' });

let context;
let page;

test.beforeAll(async ({ browser, baseURL, viewport }) => {
  context = await browser.newContext({ baseURL, viewport });
  page = await context.newPage();
  console.log('[auth-login.spec] 공유 브라우저 컨텍스트 1개 생성 (테스트마다 새로 열지 않는다)');
});

test.afterAll(async () => {
  await context.close();
});

test.beforeEach(async () => {
  await context.request.post('/api/auth/logout').catch(() => {});
});

test.afterEach(async () => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  page.removeAllListeners('request');
  page.removeAllListeners('dialog');
});

let emailSeq = 0;
function uniqueEmail(prefix) {
  emailSeq += 1;
  // 공백·한글 등 이메일에 쓸 수 없는 문자가 라벨에 섞여 들어와도(예: "빈 문자열") 유효한 이메일이
  // 되도록 영문/숫자/.- 만 남긴다 — 안 그러면 EMAIL_FORMAT_ERROR가 먼저 터져 테스트 의도가 깨진다.
  const safePrefix = String(prefix).replace(/[^a-zA-Z0-9.-]/g, '') || 'x';
  return `${safePrefix}.${Date.now()}.${emailSeq}.${Math.random().toString(36).slice(2, 8)}@example.com`;
}

function errMsg(body) {
  return body && body.error && typeof body.error.message === 'string' ? body.error.message : '';
}

async function apiSignup(reqCtx, payload) {
  const res = await reqCtx.post('/api/auth/signup', { data: payload });
  const body = await res.json().catch(() => null);
  return { status: res.status(), body, res };
}

async function apiLogin(reqCtx, email, password, extra) {
  const res = await reqCtx.post('/api/auth/login', { data: { email, password, ...extra } });
  const body = await res.json().catch(() => null);
  return { status: res.status(), body, res };
}

/** 가입 + 가입된 계정 정보를 돌려주는 헬퍼 — 로그인 전용 테스트들이 공통으로 쓴다. */
async function createAccount(prefix, password) {
  const email = uniqueEmail(prefix);
  const { status } = await apiSignup(context.request, { email, password, passwordConfirm: password });
  expect(status).toBe(201);
  return { email, password };
}

const LOGIN_CREDENTIALS_ERROR = '이메일 또는 비밀번호가 올바르지 않습니다.';
const EMAIL_FORMAT_ERROR = '이메일 형식이 올바르지 않습니다.';
const PASSWORD_LENGTH_ERROR = '비밀번호는 4자 이상 20자 이하로 입력해 주세요.';
const PASSWORD_MISMATCH_ERROR = '비밀번호가 일치하지 않습니다.';

// ===========================================================================
// 시나리오 1: 올바른 계정으로 로그인하는 방문자
// [PRD 22.3/24.6/24.16/D33/D38 · B1/B5/B7/B11/B13/B15]
// ===========================================================================
test.describe('시나리오: 올바른 계정으로 로그인하는 방문자', () => {
  test('가입한 계정으로 로그인하면 성공하고, 서버가 쿠키 4개 속성을 갖춘 로그인 쿠키를 발급한다 [24.6/24.16 · B1]', async () => {
    const { email, password } = await createAccount('b1', 'abcd1234');

    const login = await apiLogin(context.request, email, password);
    expect(login.status).toBe(200);

    const cookies = await context.cookies();
    const sessionCookie = cookies.find((c) => c.name === 'sessionId');
    expect(sessionCookie).toBeTruthy();
    expect(sessionCookie.path).toBe('/');
    expect(sessionCookie.httpOnly).toBe(true);
    expect(sessionCookie.sameSite).toBe('Lax');
    expect(sessionCookie.secure).toBe(false); // 로컬 http용 — Secure를 붙이면 쿠키가 저장되지 않는다

    const remainingSeconds = sessionCookie.expires - Date.now() / 1000;
    expect(Math.abs(remainingSeconds - 7 * 24 * 60 * 60)).toBeLessThan(60);
  });

  test('로그인 응답도 가입 응답과 똑같이 이메일·가입일 두 가지만 담고, 비밀번호 해시는 없다 [D30 · B11]', async () => {
    const { email, password } = await createAccount('b11', 'abcd1234');
    const login = await apiLogin(context.request, email, password);

    expect(login.status).toBe(200);
    expect(Object.keys(login.body)).toEqual(['user']);
    expect(Object.keys(login.body.user).sort()).toEqual(['createdAt', 'email']);
    expect(JSON.stringify(login.body).toLowerCase()).not.toContain('hash');
    expect(JSON.stringify(login.body).toLowerCase()).not.toContain('salt');
  });

  test('가입할 때와 다른 대소문자로 이메일을 입력해도 로그인된다 [D33 · B5]', async () => {
    const base = `b5.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
    const signupEmail = `HONG.${base}@Ex.com`;
    const loginEmail = `hong.${base}@ex.com`;
    await apiSignup(context.request, { email: signupEmail, password: 'abcd1234', passwordConfirm: 'abcd1234' });

    const login = await apiLogin(context.request, loginEmail, 'abcd1234');
    expect(login.status).toBe(200);
  });

  test('이메일 앞뒤에 공백을 넣어도 로그인된다 [D33 · B7]', async () => {
    const { email, password } = await createAccount('b7', 'abcd1234');
    const login = await apiLogin(context.request, `  ${email}  `, password);
    expect(login.status).toBe(200);
  });

  test('화면에서 로그인에 성공하면, 상품 목록(/)으로 이동하고 헤더에 내 이메일 전체와 로그아웃 버튼이 보인다 [22.3 · B13]', async () => {
    const { email, password } = await createAccount('b13', 'abcd1234');

    await test.step('Given/When: 로그인 화면에서 올바른 정보로 로그인한다', async () => {
      await page.goto('/login.html');
      await page.getByTestId('login-email').fill(email);
      await page.getByTestId('login-password').fill(password);
      await page.getByTestId('login-submit').click();
      await page.waitForURL(/\/$/);
    });

    await test.step('Then: 상품 목록으로 이동하고, 헤더가 로그인 상태로 바뀐다', async () => {
      await expect(page.getByTestId('auth-user')).toBeVisible();
      await expect(page.getByTestId('auth-guest')).toBeHidden();
      await expect(page.getByTestId('auth-user-email')).toHaveText(email); // 마스킹 없이 전체 표시
      await expect(page.getByTestId('auth-logout-button')).toBeVisible();
    });
  });

  test('로그인 화면 주소에 ?returnTo=/cart.html을 붙여도, 로그인하면 항상 상품 목록(/)으로 이동한다 [D38 · B15]', async () => {
    const { email, password } = await createAccount('b15', 'abcd1234');

    await page.goto('/login.html?returnTo=/cart.html');
    await page.getByTestId('login-email').fill(email);
    await page.getByTestId('login-password').fill(password);
    await page.getByTestId('login-submit').click();

    await page.waitForURL(/\/$/);
    await expect(page).toHaveURL('http://localhost:3000/');
  });
});

// ===========================================================================
// 시나리오 2: 잘못된 정보로 로그인을 시도하는 방문자
// [PRD D34/24.7~24.8 · B2~B4/B6/B8~B10/B14]
// ===========================================================================
test.describe('시나리오: 잘못된 정보로 로그인을 시도하는 방문자', () => {
  test('가입하지 않은 이메일로 로그인하면 거절되고, 가입한 계정에 비밀번호를 틀려도 똑같은 메시지로 거절된다 [24.7 · B2/B3]', async () => {
    const neverRegistered = uniqueEmail('b2-never');
    const noSuchEmail = await apiLogin(context.request, neverRegistered, 'anypassword'); // 4자 이상
    expect(noSuchEmail.status).toBe(401);
    expect(errMsg(noSuchEmail.body)).toBe(LOGIN_CREDENTIALS_ERROR);

    const { email } = await createAccount('b3', 'correctpw1');
    const wrongPassword = await apiLogin(context.request, email, 'incorrectpw');
    expect(wrongPassword.status).toBe(401);
    expect(errMsg(wrongPassword.body)).toBe(LOGIN_CREDENTIALS_ERROR);
  });

  test('🚨 없는 이메일과 틀린 비밀번호의 응답이 완전히 같다 — 상태 코드·문구·쿠키 유무가 구별되지 않는다 [D34 · B4]', async () => {
    const { email } = await createAccount('b4', 'correctpw1');

    const neverRegistered = await context.request.post('/api/auth/login', {
      data: { email: uniqueEmail('b4-never'), password: 'anypassword' },
    });
    const wrongPassword = await context.request.post('/api/auth/login', {
      data: { email, password: 'incorrectpw' },
    });

    expect(neverRegistered.status()).toBe(wrongPassword.status());
    expect(await neverRegistered.text()).toBe(await wrongPassword.text()); // 문자열 완전 동일

    const cookiesA = neverRegistered.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
    const cookiesB = wrongPassword.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
    expect(cookiesA.filter((c) => c.value.includes('sessionId'))).toEqual([]);
    expect(cookiesB.filter((c) => c.value.includes('sessionId'))).toEqual([]);
  });

  test('비밀번호의 대소문자를 바꾸거나 앞뒤에 공백을 넣어 로그인을 시도하면 거절된다 [D35 · B6/B8]', async () => {
    const { email, password } = await createAccount('b6b8', 'Secret1234');

    const caseChanged = await apiLogin(context.request, email, 'secret1234'); // 대소문자 변경
    expect(caseChanged.status).toBe(401);

    const spaced = await apiLogin(context.request, email, ` ${password} `);
    expect(spaced.status).toBe(401);

    const exact = await apiLogin(context.request, email, password);
    expect(exact.status).toBe(200);
    await context.request.post('/api/auth/logout').catch(() => {});
  });

  test('이메일 형식부터 틀리면, "없는 계정" 안내가 아니라 이메일 형식 오류가 먼저 나온다 — 형식 검사가 자격 검사보다 먼저다 [24.8 · B9]', async () => {
    const login = await apiLogin(context.request, 'not-an-email', 'short'); // 비밀번호도 길이 충분
    expect(login.status).toBe(400);
    expect(errMsg(login.body)).toBe(EMAIL_FORMAT_ERROR);
  });

  test('없는 이메일에 3자짜리 짧은 비밀번호를 넣으면, 길이 검사에서 먼저 걸려 길이 오류가 나온다 [24.8 · B10]', async () => {
    const login = await apiLogin(context.request, uniqueEmail('b10-never'), 'ab'); // 3자 미만도 포함해 짧게
    expect(login.status).toBe(400);
    expect(errMsg(login.body)).toBe(PASSWORD_LENGTH_ERROR);
  });

  test('화면에서 로그인에 실패하면, 서버 안내가 표시되고 이메일은 남지만 비밀번호만 비워지며 폼은 그대로 다시 쓸 수 있다 [22.4 · B14]', async () => {
    const { email } = await createAccount('b14', 'correctpw1');

    await page.goto('/login.html');
    await page.getByTestId('login-email').fill(email);
    await page.getByTestId('login-password').fill('wrongpassword');
    await page.getByTestId('login-submit').click();

    await expect(page.getByTestId('login-error')).toBeVisible();
    await expect(page.locator('#login-error-message')).toHaveText(LOGIN_CREDENTIALS_ERROR);
    await expect(page).toHaveURL(/\/login\.html$/);
    await expect(page.getByTestId('login-email')).toHaveValue(email); // 이메일은 유지
    await expect(page.getByTestId('login-password')).toHaveValue(''); // 비밀번호는 비워짐
    await expect(page.getByTestId('auth-guest')).toBeVisible();
    await expect(page.getByTestId('login-form')).toBeVisible();
    await expect(page.getByTestId('login-submit')).toBeEnabled();
  });
});

// ===========================================================================
// 시나리오 3: 로그인 화면의 입력란을 살펴보는 방문자
// [PRD 22.1/22.2/22.8/22.9/22.10/22.12/24.5 · B16~B18]
// ===========================================================================
test.describe('시나리오: 로그인 화면의 입력란을 살펴보는 방문자', () => {
  test('로그인 화면의 입력란은 이메일과 비밀번호 두 개뿐이다 — 확인란도 길이 안내 문구도 없다 [22.1 · B17]', async () => {
    await page.goto('/login.html');
    await expect(page.locator('#login-form input')).toHaveCount(2);
    await expect(page.getByTestId('login-password-confirm')).toHaveCount(0);
    await expect(page.getByTestId('signup-password-hint')).toHaveCount(0);
  });

  test('이메일 입력란에는 가입 화면과 같은 예시 글자가 있고, 비밀번호 입력란에는 없으며, 검증 속성도 없다 [22.12 · B16]', async () => {
    await page.goto('/login.html');
    const emailInput = page.getByTestId('login-email');
    await expect(emailInput).toHaveAttribute('placeholder', 'example@email.com');
    await expect(emailInput).toHaveValue('');
    await expect(emailInput).toHaveAttribute('type', 'text');
    expect(await emailInput.evaluate((el) => el.hasAttribute('required'))).toBe(false);
    await expect(page.getByTestId('login-password')).not.toHaveAttribute('placeholder', /.+/);
  });

  test('로그인 요청에는 이메일·비밀번호 두 가지만 실린다 [22.2 · B18]', async () => {
    const { email, password } = await createAccount('b18-basic', 'abcd1234');
    const posts = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/api/auth/login')) posts.push(req.postDataJSON());
    });

    await page.goto('/login.html');
    await page.getByTestId('login-email').fill(email);
    await page.getByTestId('login-password').fill(password);
    await page.getByTestId('login-submit').click();
    await page.waitForURL(/\/$/);

    expect(posts).toHaveLength(1);
    expect(Object.keys(posts[0]).sort()).toEqual(['email', 'password']);
    await context.request.post('/api/auth/logout').catch(() => {});
  });

  test('passwordConfirm 값을 억지로 실어 보내도, 서버는 완전히 무시한다 — 일치/불일치 모두 결과가 같다 [24.5 · B18]', async () => {
    const { email, password } = await createAccount('b18-confirm', 'abcd1234');

    const matching = await apiLogin(context.request, email, password, { passwordConfirm: password });
    expect(matching.status).toBe(200);
    expect(errMsg(matching.body)).not.toBe(PASSWORD_MISMATCH_ERROR);
    await context.request.post('/api/auth/logout').catch(() => {});

    const mismatching = await apiLogin(context.request, email, password, { passwordConfirm: 'totally-different' });
    expect(mismatching.status).toBe(200); // 불일치여도 결과가 같다 — 로그인은 confirm을 보지 않는다
    expect(errMsg(mismatching.body)).not.toBe(PASSWORD_MISMATCH_ERROR);
    await context.request.post('/api/auth/logout').catch(() => {});
  });

  test('로그인 화면에는 회원가입 링크가 있고, "비밀번호를 잊으셨나요?" 링크는 없다 [22.8]', async () => {
    await page.goto('/login.html');
    await expect(page.getByTestId('login-signup-link')).toHaveAttribute('href', '/signup.html');
    await expect(page.getByText(/비밀번호.*잊/)).toHaveCount(0);
  });

  test('이미 로그인한 상태로 로그인 화면에 들어가도 막지 않고, 거기서 다시 로그인하면 이전 세션은 폐기되고 새 세션으로 바뀐다 [22.9]', async () => {
    const { email, password } = await createAccount('b22-9', 'abcd1234');
    const firstLogin = await apiLogin(context.request, email, password);
    expect(firstLogin.status).toBe(200);
    const firstCookie = (await context.cookies()).find((c) => c.name === 'sessionId').value;

    await page.goto('/login.html');
    await expect(page.getByTestId('login-form')).toBeVisible(); // 막지 않는다

    await page.getByTestId('login-email').fill(email);
    await page.getByTestId('login-password').fill(password);
    await page.getByTestId('login-submit').click();
    await page.waitForURL(/\/$/);
    // 전체 스위트를 병렬로 돌릴 때(서버 응답이 느려질 때) waitForURL 직후 곧바로 쿠키를 읽으면
    // 아직 쿠키 저장이 완전히 반영되지 않은 시점을 잡을 수 있다 — 새 페이지의 헤더가 실제로
    // 새 이메일로 "로그인 확정" 상태가 될 때까지 기다려 쿠키 반영을 보장한다.
    await expect(page.getByTestId('auth-user-email')).toHaveText(email);

    const secondCookie = (await context.cookies()).find((c) => c.name === 'sessionId').value;
    expect(secondCookie).not.toBe(firstCookie); // 새 세션으로 바뀜

    // 이전 세션 값은 더 이상 쓸 수 없다 (로그아웃 시도하면 거절)
    const logoutWithOld = await context.request.post('/api/auth/logout', {
      headers: { Cookie: `sessionId=${firstCookie}` },
    });
    expect(logoutWithOld.status()).toBe(401);
    await context.request.post('/api/auth/logout').catch(() => {});
  });
});

// ===========================================================================
// 시나리오 4: 같은 계정으로 여러 번 / 여러 브라우저에서 로그인하는 방문자
// [PRD D37/24.9 · B12/C12]
// ===========================================================================
test.describe('시나리오: 같은 계정으로 여러 번 / 여러 브라우저에서 로그인하는 방문자', () => {
  test('같은 브라우저에서 연달아 두 번 로그인하면, 두 번째에 새 쿠키가 발급되고 첫 번째 값은 더 이상 쓸 수 없다 [24.9 · B12]', async ({
    browser,
  }) => {
    const { email, password } = await createAccount('b12', 'abcd1234');

    const first = await apiLogin(context.request, email, password);
    expect(first.status).toBe(200);
    const firstCookie = (await context.cookies()).find((c) => c.name === 'sessionId').value;

    const second = await apiLogin(context.request, email, password);
    expect(second.status).toBe(200);
    const secondCookie = (await context.cookies()).find((c) => c.name === 'sessionId').value;

    expect(secondCookie).not.toBe(firstCookie);

    // ⚠ 공유 컨텍스트의 Cookie 헤더를 억지로 덮어써서 "옛 쿠키"를 보내면, 로그아웃 401 응답이
    //   함께 보내는 Set-Cookie(Max-Age=0)가 공유 컨텍스트의 "진짜 현재 세션 쿠키"까지 지워버린다
    //   (요청에는 안 썼어도 응답 처리 시 덮어쓴다). 그래서 옛 쿠키 검사만을 위한 별도 컨텍스트를 쓴다.
    const probeContext = await browser.newContext({ baseURL: 'http://localhost:3000' });
    try {
      await probeContext.addCookies([{ name: 'sessionId', value: firstCookie, domain: 'localhost', path: '/' }]);
      const logoutWithOld = await probeContext.request.post('/api/auth/logout');
      expect(logoutWithOld.status()).toBe(401); // 쓸 수 없는 세션이 쌓이지 않는다
    } finally {
      await probeContext.close();
    }

    // 공유 컨텍스트가 들고 있는 "현재(두 번째)" 쿠키는 위 검사와 무관하게 여전히 유효하다
    const meWithNew = await context.request.get('/api/auth/me');
    expect((await meWithNew.json()).user.email).toBe(email);

    await context.request.post('/api/auth/logout').catch(() => {});
  });

  // ⚠ 공유 컨텍스트 규칙의 명시적 예외 (SKILL.md, cart.spec.js의 8.5와 같은 이유) — "서로 다른
  //   브라우저에서 동시 로그인이 독립적인가"를 증명하려면 창이 2개 이상 필요하다.
  test('다른 브라우저(시크릿 창)에서 같은 계정으로 동시에 로그인할 수 있고, 두 세션은 서로 독립이다 [D37 · C12]', async ({
    browser,
  }) => {
    const { email, password } = await createAccount('c12', 'abcd1234');

    const contextA = await browser.newContext({ baseURL: 'http://localhost:3000' });
    const contextB = await browser.newContext({ baseURL: 'http://localhost:3000' });
    console.log('[auth-login.spec] 예외: C12가 독립 로그인 증명용 컨텍스트 2개 추가 생성');

    try {
      const loginA = await apiLogin(contextA.request, email, password);
      const loginB = await apiLogin(contextB.request, email, password);
      expect(loginA.status).toBe(200);
      expect(loginB.status).toBe(200);

      const cookieA = (await contextA.cookies()).find((c) => c.name === 'sessionId').value;
      const cookieB = (await contextB.cookies()).find((c) => c.name === 'sessionId').value;
      expect(cookieA).not.toBe(cookieB);

      // A만 로그아웃
      const logoutA = await contextA.request.post('/api/auth/logout');
      expect(logoutA.status()).toBe(200);

      const meA = await contextA.request.get('/api/auth/me');
      expect((await meA.json()).user).toBeNull();

      // B는 계속 로그인 상태다
      const meB = await contextB.request.get('/api/auth/me');
      expect((await meB.json()).user.email).toBe(email);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('로그인에 실패해도, 그 전부터 로그인되어 있던 세션은 건드리지 않는다 [24.9]', async () => {
    const { email, password } = await createAccount('b24-9', 'abcd1234');
    const login = await apiLogin(context.request, email, password);
    expect(login.status).toBe(200);
    const cookieBefore = (await context.cookies()).find((c) => c.name === 'sessionId').value;

    const failedAttempt = await apiLogin(context.request, email, 'wrong-password');
    expect(failedAttempt.status).toBe(401);

    const cookieAfter = (await context.cookies()).find((c) => c.name === 'sessionId');
    expect(cookieAfter.value).toBe(cookieBefore); // 그대로 유지

    const me = await context.request.get('/api/auth/me');
    expect((await me.json()).user.email).toBe(email);
    await context.request.post('/api/auth/logout').catch(() => {});
  });
});
