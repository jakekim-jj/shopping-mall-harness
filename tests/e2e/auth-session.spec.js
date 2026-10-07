'use strict';

/**
 * 로그아웃 · 상태 조회(me) · 헤더 3상태 — tests/test-cases.ko.md
 *   "5차 사이클 — 회원가입 / 로그인 / 로그아웃" 중 "로그아웃" + "로그인 상태 조회와 헤더의 세 가지 모습" 섹션
 *   (PRD 20.x/23.x/24.10~24.11, 매트릭스 C1~C18 — C7·C8 제외)
 *
 * 구성 방식: BDD/시나리오 스타일 (auth-signup.spec.js 머릿말 참고). describe = 시나리오,
 * 테스트 제목 끝 [ ]는 PRD/매트릭스 각주, test-cases.ko.md 구조는 그대로 둔다.
 *
 * ⚠️ C7(서버 재시작)·C8(AUTH_SESSION_TTL_SECONDS=2로 재기동 후 3초 대기)는 이 파일에 넣지 않았다.
 *   둘 다 "지금 떠 있는 서버를 재시작하거나 다른 설정으로 새로 띄워야" 만들 수 있는 상태라, 같은
 *   실행 안에서 돌아가는 다른 테스트의 장바구니·계정·세션을 전부 날려버린다(playwright.config.js의
 *   reuseExistingServer 전제와도 충돌한다). 대신 C3/C9("위조 쿠키 심기")가 서버 입장에서는 완전히
 *   같은 코드 경로("쿠키는 있지만 Map에 유효한 세션이 없음" → findSession()이 session=null을
 *   반환)를 타므로, 자동화 범위 안에서 이미 그 분기를 반복적으로 덮고 있다. C7/C8은
 *   QA가 5차 사이클에서 서버를 실제로 재시작/재기동해 수동으로 통과를 확인했다
 *   (_workspace/04_qa_report.md 5차 섹션 §1·§3 "C7/C8" 참고) — 자동화 누락이 아니라 의도적 제외다.
 *
 * 규칙 (skills/shopping-mall-qa/SKILL.md)
 *   - data-testid 선택자만 쓴다. "DOM에 있는지"와 "지금 보이는지"를 구분한다 (bug-history M2).
 *   - 500/네트워크 오류는 page.route()로 해당 API 응답을 가로채 만든다 (C15/C18).
 *   - spec 파일 하나당 브라우저 컨텍스트(창)는 하나다. 아래 beforeAll에서 한 번만 만든다.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'default' });

let context;
let page;

test.beforeAll(async ({ browser, baseURL, viewport }) => {
  context = await browser.newContext({ baseURL, viewport });
  page = await context.newPage();
  console.log('[auth-session.spec] 공유 브라우저 컨텍스트 1개 생성 (테스트마다 새로 열지 않는다)');
});

test.afterAll(async () => {
  await context.close();
});

// 매 테스트를 "로그인 안 된 상태"에서 시작시킨다 (장바구니의 DELETE /api/cart 패턴과 같은 이유).
test.beforeEach(async () => {
  await context.request.post('/api/auth/logout').catch(() => {});
  await context.clearCookies();
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

async function createAndLogin(prefix) {
  const email = uniqueEmail(prefix);
  const password = 'abcd1234';
  await context.request.post('/api/auth/signup', { data: { email, password, passwordConfirm: password } });
  const login = await context.request.post('/api/auth/login', { data: { email, password } });
  expect(login.status()).toBe(200);
  return { email, password };
}

function errMsg(body) {
  return body && body.error && typeof body.error.message === 'string' ? body.error.message : '';
}

const LOGIN_REQUIRED_ERROR = '로그인이 필요합니다.';

// ===========================================================================
// 시나리오 1: 로그아웃하는 로그인된 방문자
// [PRD 24.10/23.2/23.9 · C1/C5/C13/C16]
// ===========================================================================
test.describe('시나리오: 로그아웃하는 로그인된 방문자', () => {
  test('로그인 상태에서 로그아웃하면 성공하고, 쿠키가 즉시 폐기되며 이후 상태 조회는 "로그인 안 됨"이다 [C1]', async () => {
    await createAndLogin('c1');
    expect((await context.cookies()).find((c) => c.name === 'sessionId')).toBeTruthy();

    const logout = await context.request.post('/api/auth/logout');
    expect(logout.status()).toBe(200);
    expect(await logout.json()).toEqual({ user: null });

    // Max-Age=0 응답을 받은 브라우저 쿠키 저장소에서 즉시 사라진다
    expect((await context.cookies()).find((c) => c.name === 'sessionId')).toBeUndefined();

    const me = await context.request.get('/api/auth/me');
    expect((await me.json()).user).toBeNull();
  });

  test('로그인 → 로그아웃 → 로그아웃을 한 번 더 하면, 첫 번째는 성공하고 두 번째는 거절된다 — 멱등하지 않다 [C5]', async () => {
    await createAndLogin('c5');
    const first = await context.request.post('/api/auth/logout');
    expect(first.status()).toBe(200);
    const second = await context.request.post('/api/auth/logout');
    expect(second.status()).toBe(401);
  });

  test('화면에서 로그아웃 버튼을 누르면, 화면 이동/새로고침 없이 헤더만 게스트로 바뀌고 새로고침해도 유지된다 [23.2 · C13]', async () => {
    await createAndLogin('c13');

    await test.step('Given: 로그인한 채로 장바구니 화면에 들어가 있다', async () => {
      await page.goto('/cart.html');
      await expect(page.getByTestId('auth-user')).toBeVisible();
    });

    await test.step('When: 헤더의 로그아웃 버튼을 누른다', async () => {
      await page.getByTestId('auth-logout-button').click();
    });

    await test.step('Then: 화면은 그대로이고 헤더만 게스트로 바뀌며, 새로고침해도 유지된다', async () => {
      await expect(page).toHaveURL(/\/cart\.html$/);
      await expect(page.getByTestId('auth-guest')).toBeVisible();
      await expect(page.getByTestId('auth-user')).toBeHidden();

      await page.reload();
      await expect(page.getByTestId('auth-guest')).toBeVisible();
    });
  });

  test('화면에서 로그아웃에 네이티브 확인창("정말 로그아웃하시겠습니까?")이 뜨지 않는다 [23.9 · C16]', async () => {
    await createAndLogin('c16');
    await page.goto('/cart.html');

    let dialogFired = false;
    page.on('dialog', async (dialog) => {
      dialogFired = true;
      await dialog.dismiss();
    });

    await page.getByTestId('auth-logout-button').click();
    await expect(page.getByTestId('auth-guest')).toBeVisible();
    expect(dialogFired).toBe(false);
  });
});

// ===========================================================================
// 시나리오 2: 세션이 이미 없는 상태에서 로그아웃을 시도하는 방문자
// [PRD 24.10/23.3 · C2/C3/C4/C14]
// ===========================================================================
test.describe('시나리오: 세션이 이미 없는 상태에서 로그아웃을 시도하는 방문자', () => {
  test('로그인 쿠키가 아예 없는 상태로 로그아웃하면 "로그인이 필요합니다."로 거절된다 [C2]', async () => {
    const res = await context.request.post('/api/auth/logout');
    expect(res.status()).toBe(401);
    expect(errMsg(await res.json())).toBe(LOGIN_REQUIRED_ERROR);
  });

  test('존재하지 않는 가짜 쿠키 값을 심어두고 로그아웃하면 거절되고, 쓸 수 없는 쿠키는 폐기된다 [C3]', async () => {
    await context.addCookies([
      { name: 'sessionId', value: 'forged-session-value', domain: 'localhost', path: '/' },
    ]);
    const res = await context.request.post('/api/auth/logout');
    expect(res.status()).toBe(401);
    expect(errMsg(await res.json())).toBe(LOGIN_REQUIRED_ERROR);
    expect((await context.cookies()).find((c) => c.name === 'sessionId')).toBeUndefined();
  });

  test('같은 가짜 값으로 몇 번을 반복해도, 매번 똑같이 거절된다 — 상태가 쌓이지 않는다 [C4]', async () => {
    for (let i = 0; i < 3; i += 1) {
      await context.addCookies([
        { name: 'sessionId', value: 'forged-repeat-value', domain: 'localhost', path: '/' },
      ]);
      const res = await context.request.post('/api/auth/logout');
      expect(res.status()).toBe(401);
    }
  });

  test('화면에서 서버에 이미 세션이 없는데 로그아웃을 누르면(401), 헤더는 게스트로 바뀌고 에러는 표시되지 않는다 [23.3 · C14]', async () => {
    await createAndLogin('c14');

    await test.step('Given: 화면은 로그인 상태로 보고 있지만, 그 사이 서버 세션은 이미 지워졌다', async () => {
      await page.goto('/cart.html');
      await expect(page.getByTestId('auth-user')).toBeVisible();

      // 화면 모르게 서버 세션을 먼저 지운다 (쿠키도 함께 폐기된다) — "이미 로그아웃된 상태에서 버튼을 누르는" 상황 재현
      const preLogout = await context.request.post('/api/auth/logout');
      expect(preLogout.status()).toBe(200);
    });

    await test.step('When: 그 상태에서 로그아웃 버튼을 누른다', async () => {
      await page.getByTestId('auth-logout-button').click();
    });

    await test.step('Then: 이미 원하던 결과(로그아웃됨)이므로, 헤더만 게스트로 바뀌고 에러는 뜨지 않는다', async () => {
      await expect(page.getByTestId('auth-guest')).toBeVisible();
      await expect(page.getByTestId('auth-user')).toBeHidden();
      // 헤더 영역(auth-area) 안에 에러 표시 요소가 없다
      await expect(page.locator('[data-testid="auth-area"] [role="alert"]')).toHaveCount(0);
    });
  });
});

// ===========================================================================
// 시나리오 3: 로그아웃 요청이 서버/네트워크 오류로 실패하는 상황
// [PRD 23.3 · C15]
// ===========================================================================
test.describe('시나리오: 로그아웃 요청이 서버/네트워크 오류로 실패하는 상황', () => {
  test('화면에서 로그아웃이 5xx나 네트워크 오류로 실패하면, 헤더는 로그인 상태를 유지하고 버튼을 다시 누를 수 있다 [23.3 · C15]', async () => {
    const { email } = await createAndLogin('c15');
    await page.goto('/cart.html');
    await expect(page.getByTestId('auth-user-email')).toHaveText(email);
    const logoutBtn = page.getByTestId('auth-logout-button');

    await test.step('서버가 500을 반환하는 동안 로그아웃을 눌러도, 로그인 상태가 유지된다', async () => {
      await page.route('**/api/auth/logout', (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: '인증 요청을 처리하지 못했습니다.' } }),
        })
      );
      await logoutBtn.click();
      await expect(page.getByTestId('auth-user')).toBeVisible(); // 로그인 상태 유지
      await expect(page.getByTestId('auth-guest')).toBeHidden();
      await expect(logoutBtn).toBeEnabled();
    });

    await test.step('네트워크 오류로 실패해도 마찬가지다', async () => {
      await page.unroute('**/api/auth/logout');
      await page.route('**/api/auth/logout', (route) => route.abort());
      await logoutBtn.click();
      await expect(page.getByTestId('auth-user')).toBeVisible();
      await expect(logoutBtn).toBeEnabled();
    });

    await test.step('가로채기를 풀면, 실제로는 세션이 멀쩡히 남아 있었으므로 정상적으로 로그아웃된다', async () => {
      await page.unroute('**/api/auth/logout');
      await logoutBtn.click();
      await expect(page.getByTestId('auth-guest')).toBeVisible();
    });
  });
});

// ===========================================================================
// 시나리오 4: 로그인 상태를 조회(me)하는 방문자
// [PRD 24.11 · C6/C9/C10/C11]
// ===========================================================================
test.describe('시나리오: 로그인 상태를 조회(me)하는 방문자', () => {
  test('로그인 쿠키 없이 상태를 물어보면, 에러가 아니라 정상 응답으로 "로그인 안 됨"이라고 답하고 user 키는 항상 존재한다 [24.11 · C6]', async () => {
    const res = await context.request.get('/api/auth/me');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['user']);
    expect(body.user).toBeNull();
  });

  test('가짜 쿠키로 상태를 물어보면, "로그인 안 됨"이라고 답하면서 쓸 수 없는 쿠키를 폐기한다 [24.11 · C9]', async () => {
    await context.addCookies([{ name: 'sessionId', value: 'forged-me-value', domain: 'localhost', path: '/' }]);
    const res = await context.request.get('/api/auth/me');
    expect(res.status()).toBe(200);
    expect((await res.json()).user).toBeNull();
    expect((await context.cookies()).find((c) => c.name === 'sessionId')).toBeUndefined();
  });

  test('쿠키가 아예 없을 때는, me 응답에 Set-Cookie 헤더 자체가 없다 — 지울 게 없으므로 [24.11 · C10]', async () => {
    const res = await context.request.get('/api/auth/me');
    const setCookies = res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
    expect(setCookies).toEqual([]);
  });

  test('유효한 세션으로 me를 여러 번 호출해도, 세션이 재발급되지 않는다 — 매번 같은 쿠키 값, Set-Cookie 0건 [24.11 · C11]', async () => {
    // ⚠ 이 테스트는 "슬라이딩 만료가 없다"의 부분 확인이다. 만료 시점까지 실제로 기다려
    //   "진짜로 연장되지 않았다"를 증명하는 전체 검증은 전용 TTL로 띄운 별도 서버가 필요해서
    //   C7/C8과 같은 이유로 자동화 범위 밖에 둔다(QA가 수동으로 통과 확인). 여기서는 "응답이
    //   Set-Cookie를 다시 보내지 않는다 + 쿠키 값이 바뀌지 않는다"까지만 결정론적으로 확인한다.
    await createAndLogin('c11');
    const before = (await context.cookies()).find((c) => c.name === 'sessionId').value;

    for (let i = 0; i < 3; i += 1) {
      const res = await context.request.get('/api/auth/me');
      expect(res.status()).toBe(200);
      const setCookies = res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
      expect(setCookies).toEqual([]);
    }

    const after = (await context.cookies()).find((c) => c.name === 'sessionId').value;
    expect(after).toBe(before);
  });
});

// ===========================================================================
// 시나리오 5: 헤더가 로그인 상태를 어떻게 반영하는지 확인하는 방문자
// [PRD 20.x · C17/C18, 20.2/20.4/20.8]
// ===========================================================================
test.describe('시나리오: 헤더가 로그인 상태를 어떻게 반영하는지 확인하는 방문자', () => {
  test('me 응답이 오기 전에는, auth-guest·auth-user 둘 다 보이지 않는다 [20.5 · C17]', async () => {
    await page.route('**/api/auth/me', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.continue();
    });
    const meResponse = page.waitForResponse((res) => res.url().endsWith('/api/auth/me'));
    await page.goto('/', { waitUntil: 'commit' });

    await expect(page.getByTestId('auth-guest')).toHaveCount(1);
    await expect(page.getByTestId('auth-user')).toHaveCount(1);
    await expect(page.getByTestId('auth-guest')).toBeHidden();
    await expect(page.getByTestId('auth-user')).toBeHidden();

    // 가로챈 응답이 실제로 끝날 때까지 기다린 뒤에 unroute한다 — 지연된 route.continue()가
    // 다음 테스트로 넘어간 뒤 뒤늦게 실행되면서 "Route is already handled!"를 던지는 것을 막는다.
    await meResponse;
    await page.unroute('**/api/auth/me');
  });

  test('me 호출이 5xx로 실패하면, 인증 영역은 둘 다 숨겨진 채로 남고 화면 본문은 정상적으로 그려진다 [20.6 · C18]', async () => {
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '인증 요청을 처리하지 못했습니다.' } }),
      })
    );

    await page.goto('/');
    await expect(page.getByTestId('auth-guest')).toBeHidden();
    await expect(page.getByTestId('auth-user')).toBeHidden();
    await expect(page.getByTestId('product-list')).toBeVisible(); // 본문은 인증 조회와 무관하게 정상

    await page.goto('/cart.html');
    await expect(page.getByTestId('auth-guest')).toBeHidden();
    await expect(page.getByTestId('auth-user')).toBeHidden();
    // 장바구니 화면 본문은 4개 상태 중 하나로 정상 렌더된다 (인증 실패 때문에 에러 화면이 되지 않는다)
    const bodyStates = ['cart-loading', 'cart-list', 'cart-empty', 'cart-error'];
    let bodyVisibleCount = 0;
    for (const id of bodyStates) {
      if (await page.getByTestId(id).isVisible()) bodyVisibleCount += 1;
    }
    expect(bodyVisibleCount).toBe(1);

    await page.goto('/checkout.html');
    await expect(page.getByTestId('auth-guest')).toBeHidden();
    await expect(page.getByTestId('auth-user')).toBeHidden();
    await expect(page.locator('main')).toBeVisible();

    await page.unroute('**/api/auth/me');
  });

  test('화면마다 로그인 상태를 정확히 한 번만 물어본다 [20.2]', async () => {
    const screens = ['/', '/product.html?id=p1', '/cart.html', '/checkout.html', '/signup.html', '/login.html'];
    for (const path of screens) {
      const meCalls = [];
      const listener = (req) => {
        if (req.method() === 'GET' && req.url().endsWith('/api/auth/me')) meCalls.push(req.url());
      };
      page.on('request', listener);
      await page.goto(path);
      await page.waitForTimeout(300);
      page.off('request', listener);
      expect(meCalls, `경로 ${path}`).toHaveLength(1);
    }
  });

  test('헤더의 이메일은 클릭해도 아무 데도 가지 않는 글자다 [20.4/25.4]', async () => {
    const { email } = await createAndLogin('c-email-link');
    await page.goto('/');
    const emailEl = page.getByTestId('auth-user-email');
    expect(await emailEl.evaluate((el) => el.tagName)).toBe('SPAN');
    await emailEl.click();
    await expect(page).toHaveURL('http://localhost:3000/');
    await expect(emailEl).toHaveText(email);
  });

  test('로그인 상태의 헤더에는 이메일과 로그아웃 버튼 두 개뿐이다 — 마이페이지·주문 내역 링크가 없다 [20.8]', async () => {
    await createAndLogin('c-header-scope');
    await page.goto('/');
    await expect(page.getByTestId('auth-user')).toBeVisible();
    const userAreaChildren = page.locator('[data-testid="auth-user"] > *');
    await expect(userAreaChildren).toHaveCount(2); // auth-user-email + auth-logout-button
    await expect(page.locator('[data-testid="auth-user"] a')).toHaveCount(0); // 링크가 하나도 없다
  });
});
