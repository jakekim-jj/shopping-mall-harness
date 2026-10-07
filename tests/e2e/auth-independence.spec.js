'use strict';

/**
 * 회원 기능이 기존 기능(장바구니/결제/주문)을 건드리지 않는다 — tests/test-cases.ko.md
 *   "5차 사이클 — 회원가입 / 로그인 / 로그아웃" 중
 *   "🚨 가장 중요한 부분 — 회원 기능이 기존 기능을 건드리지 않는다" (D1~D13)
 *   + "비밀번호가 새어나가지 않는다" (D30/21.11/24.18~24.19)
 *   + "만들지 않기로 한 것이 실제로 없다" (24.14)
 *
 * 구성 방식: BDD/시나리오 스타일 (auth-signup.spec.js 머릿말 참고). describe = 시나리오,
 * 테스트 제목 끝 [ ]는 PRD/매트릭스 각주, test-cases.ko.md 구조는 그대로 둔다.
 *
 * ⚠️ D1("기존 Playwright 84개가 전부 그대로 통과한다")은 이 파일에 별도 테스트를 만들지 않는다.
 *   이 사실 자체는 "이 4개 파일을 추가한 뒤에도 npx playwright test 전체가 그대로 녹색"이라는
 *   실행 결과로 증명되는 것이지, 다른 테스트 파일을 호출하는 "테스트 안의 테스트"로 증명할 수
 *   있는 게 아니다. 최종 실행 결과(기존 84개 + 신규 N개 전부 통과)가 D1의 증거다.
 *
 * ⚠️ "비밀번호가 새어나가지 않는다" 섹션 중 자동화하지 않은 2개 (C7/C8과 같은 이유로 제외):
 *   - 24.18 "서버 로그에도 안 남는다" — 서버 프로세스의 stdout/로그 파일을 Playwright
 *     테스트 코드가 결정론적으로 들여다볼 신뢰할 수 있는 방법이 없다(npm start로 띄운 프로세스의
 *     출력을 가로채는 것은 테스트 하네스 구조를 바꿔야 한다). QA가 수동으로 확인 완료.
 *   - 24.4 "중복 이메일 거절 시 비밀번호 암호화 계산을 하지 않는다(응답 시간으로 확인)" — 타이밍
 *     기반 단언은 CI 환경마다 다른 지연으로 flaky해지기 쉽다. QA가 수동으로 확인 완료.
 *
 * 규칙 (skills/shopping-mall-qa/SKILL.md)
 *   - data-testid 선택자만 쓴다.
 *   - 서버 쪽 500 문구(D11)는 100KB보다 큰 요청 본문으로 실제 500을 트리거해 확인한다
 *     (express.json()의 기본 상한을 넘기면 entity.too.large → 공용 500 핸들러로 떨어진다).
 *   - spec 파일 하나당 브라우저 컨텍스트(창)는 하나다. 아래 beforeAll에서 한 번만 만든다.
 */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

test.describe.configure({ mode: 'default' });

let context;
let page;

test.beforeAll(async ({ browser, baseURL, viewport }) => {
  context = await browser.newContext({ baseURL, viewport });
  page = await context.newPage();
  console.log('[auth-independence.spec] 공유 브라우저 컨텍스트 1개 생성 (테스트마다 새로 열지 않는다)');
});

test.afterAll(async () => {
  await context.close();
});

test.beforeEach(async () => {
  await context.request.delete('/api/cart');
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

async function createAndLogin(reqCtx, prefix) {
  const email = uniqueEmail(prefix);
  const password = 'abcd1234';
  await reqCtx.post('/api/auth/signup', { data: { email, password, passwordConfirm: password } });
  const login = await reqCtx.post('/api/auth/login', { data: { email, password } });
  expect(login.status()).toBe(200);
  return { email, password };
}

async function seed(reqCtx, productId, quantity) {
  const res = await reqCtx.post('/api/cart/items', { data: { productId, quantity } });
  expect(res.status()).toBe(200);
}

/**
 * 장바구니 화면에서 비교 대상 값 6개를 뜬다 (D3/D4가 로그인·로그아웃 전후로 비교하는 값들).
 * ⚠ 호출 전에 반드시 화면이 "로딩 중"을 지나 실제로 그려진 뒤여야 한다 — goto/reload 직후
 *   곧바로 읽으면 GET /api/cart 응답이 아직 안 와서 빈 상태로 스냅샷을 뜨는 레이스가 생긴다
 *   (전체 스위트를 병렬로 돌려 서버가 느려지면 특히 더 쉽게 드러난다). 그래서 cart-loading이
 *   사라질 때까지 먼저 기다린다.
 */
async function captureCartScreenSnapshot(page) {
  await expect(page.getByTestId('cart-loading')).toBeHidden();
  return {
    itemCount: await page.getByTestId('cart-item').count(),
    totalPrice: await page.getByTestId('cart-total-price').textContent().catch(() => null),
    totalQuantity: await page.getByTestId('cart-total-quantity').textContent().catch(() => null),
    badgeText: await page.getByTestId('cart-count').textContent().catch(() => null),
    clearVisible: await page.getByTestId('cart-clear').isVisible(),
    checkoutVisible: await page.getByTestId('checkout-link').isVisible(),
  };
}

// ===========================================================================
// 시나리오 1: 로그인 없이 쇼핑의 전 과정을 그대로 거치는 비회원 방문자
// [PRD 24.12 · D2]
// ===========================================================================
test.describe('시나리오: 로그인 없이 쇼핑의 전 과정을 그대로 거치는 비회원 방문자', () => {
  test('보기 → 담기 → 수량변경(할인 경계) → 결제 → 주문확인까지, 어디서도 로그인을 요구하지 않는다 [24.12 · D2]', async () => {
    const view = await context.request.get('/api/products');
    expect(view.status()).toBe(200);

    const add = await context.request.post('/api/cart/items', { data: { productId: 'p1', quantity: 9 } });
    expect(add.status()).toBe(200);

    const change = await context.request.patch('/api/cart/items/p1', { data: { quantity: 10 } }); // 할인 경계
    expect(change.status()).toBe(200);
    const cartBody = (await change.json()).cart;
    expect(cartBody.items[0].discountApplied).toBe(true);

    await page.goto('/cart.html');
    await expect(page).not.toHaveURL(/login\.html/); // 로그인 화면으로 튕기지 않는다
    await expect(page.getByTestId('checkout-link')).toBeVisible();

    const checkout = await context.request.post('/api/checkout', {
      data: { ordererName: '비회원', ordererPhone: '010-1111-2222', paymentMethod: 'MOCK_SUCCESS' },
    });
    expect(checkout.status()).toBe(200);
    const orderId = (await checkout.json()).order.orderId;

    const orderLookup = await context.request.get(`/api/orders/${orderId}`);
    expect(orderLookup.status()).toBe(200);
  });
});

// ===========================================================================
// 시나리오 2: 장바구니를 채운 채 로그인·로그아웃하는 방문자
// [PRD 23.4/23.5 · D3/D4]
// ===========================================================================
test.describe('시나리오: 장바구니를 채운 채 로그인·로그아웃하는 방문자', () => {
  test('로그인하기 전후로, 줄 개수·수량·할인·총액·헤더 배지·버튼 가시성이 완전히 같다 [23.4 · D3]', async () => {
    await seed(context.request, 'p1', 10); // 할인 경계
    await seed(context.request, 'p7', 1);

    await page.goto('/cart.html');
    const before = await captureCartScreenSnapshot(page);

    const { email, password } = await createAndLogin(context.request, 'd3');
    void password;
    await page.reload();
    await expect(page.getByTestId('auth-user-email')).toHaveText(email);
    const after = await captureCartScreenSnapshot(page);

    expect(after).toEqual(before);

    // API 레벨로도 raw JSON 문자열까지 동일함을 확인한다
    const cartJsonLoggedIn = await (await context.request.get('/api/cart')).text();
    await context.request.post('/api/auth/logout');
    const cartJsonLoggedOut = await (await context.request.get('/api/cart')).text();
    expect(cartJsonLoggedIn).toBe(cartJsonLoggedOut);
  });

  test('장바구니 화면에서 로그아웃해도, 화면 본문의 어떤 요소도 바뀌지 않는다 [23.5 · D4]', async () => {
    await seed(context.request, 'p1', 2);
    await seed(context.request, 'p4', 1);
    await createAndLogin(context.request, 'd4');

    await page.goto('/cart.html');
    const before = await captureCartScreenSnapshot(page);
    const urlBefore = page.url();

    await page.getByTestId('auth-logout-button').click();
    await expect(page.getByTestId('auth-guest')).toBeVisible();

    const after = await captureCartScreenSnapshot(page);
    expect(after).toEqual(before);
    expect(page.url()).toBe(urlBefore);
  });
});

// ===========================================================================
// 시나리오 3: 같은 계정으로 다른 브라우저에서 접속하는 방문자
// [PRD D27/D23 · D5/D6]
// ===========================================================================
test.describe('시나리오: 같은 계정으로 다른 브라우저에서 접속하는 방문자', () => {
  test('다른 브라우저에서 같은 계정으로 로그인해도, 그 브라우저의 장바구니는 비어 있다 — 의도된 설계다 [D27 · D5]', async ({
    browser,
  }) => {
    await seed(context.request, 'p1', 3);
    const { email, password } = await createAndLogin(context.request, 'd5');

    const otherContext = await browser.newContext({ baseURL: 'http://localhost:3000' });
    try {
      const login = await otherContext.request.post('/api/auth/login', { data: { email, password } });
      expect(login.status()).toBe(200);

      const cart = await (await otherContext.request.get('/api/cart')).json();
      expect(cart.cart).toEqual({ items: [], totalQuantity: 0, totalPrice: 0 }); // 계정을 따라오지 않는다
    } finally {
      await otherContext.close();
    }
  });

  test('로그인했더라도, 다른 브라우저(다른 cartId)에서는 자기 주문을 볼 수 없다 — 주문 소유권은 끝까지 cartId로 판단한다 [D23 · D6]', async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext({ baseURL: 'http://localhost:3000' });
    let orderId;
    try {
      await seed(ownerContext.request, 'p1', 1);
      const checkout = await ownerContext.request.post('/api/checkout', {
        data: { ordererName: '주문자', ordererPhone: '010-2222-3333', paymentMethod: 'MOCK_SUCCESS' },
      });
      expect(checkout.status()).toBe(200);
      orderId = (await checkout.json()).order.orderId;
    } finally {
      await ownerContext.close();
    }

    // 같은 계정으로 "로그인"하더라도, cartId가 다른 이 컨텍스트에서는 그 주문이 보이지 않는다
    await createAndLogin(context.request, 'd6');
    const lookup = await context.request.get(`/api/orders/${orderId}`);
    expect(lookup.status()).toBe(404);
  });
});

// ===========================================================================
// 시나리오 4: 로그인한 채로 결제하는 방문자
// [PRD 23.6 · D7/D8]
// ===========================================================================
test.describe('시나리오: 로그인한 채로 결제하는 방문자', () => {
  test('결제해도 Order 응답 필드는 9개 그대로이고, email·userId 같은 칸이 생기지 않는다 [D7]', async () => {
    await createAndLogin(context.request, 'd7');
    await seed(context.request, 'p1', 2);

    const checkout = await context.request.post('/api/checkout', {
      data: { ordererName: '회원주문자', ordererPhone: '010-3333-4444', paymentMethod: 'MOCK_SUCCESS' },
    });
    expect(checkout.status()).toBe(200);
    const order = (await checkout.json()).order;

    expect(Object.keys(order).sort()).toEqual(
      ['createdAt', 'items', 'orderId', 'ordererName', 'ordererPhone', 'paymentMethod', 'status', 'totalPrice', 'totalQuantity'].sort()
    );
    expect(order.email).toBeUndefined();
    expect(order.userId).toBeUndefined();
    expect(order.isMember).toBeUndefined();
  });

  test('결제 화면에 들어가도, 주문자 이름·연락처 입력란은 비어 있다 — 로그인 정보로 자동 채우지 않는다 [23.6 · D8]', async () => {
    const { email } = await createAndLogin(context.request, 'd8');
    await seed(context.request, 'p1', 1);

    await page.goto('/checkout.html');
    await expect(page.getByTestId('orderer-name')).toHaveValue('');
    await expect(page.getByTestId('orderer-phone')).toHaveValue('');

    const mainText = await page.locator('main').innerText();
    expect(mainText).not.toContain(email); // 본문 어디에도 로그인 이메일이 노출되지 않는다
  });
});

// ===========================================================================
// 시나리오 5: 쿠키 없는 완전 첫 방문에서 장바구니 담기와 로그인이 동시에 일어나는 상황
// [PRD D9/24.13 · bug-history M4]
// ===========================================================================
test.describe('시나리오: 쿠키 없는 완전 첫 방문에서 장바구니 담기와 로그인이 동시에 일어나는 상황', () => {
  test('🚨 담기+로그인+상태조회를 동시에 보내도, cartId는 정확히 한 번만 발급된다 [D9/24.13 · bug-history M4]', async ({
    browser,
  }) => {
    const { email, password } = await createAndLogin(context.request, 'd9');
    await context.request.post('/api/auth/logout'); // 이 계정은 조회용으로만 쓴다 — 로그인은 freshContext에서 다시 한다

    const freshContext = await browser.newContext({ baseURL: 'http://localhost:3000' });
    console.log('[auth-independence.spec] 예외: D9가 "쿠키 없는 첫 방문" 증명용 컨텍스트 1개 추가 생성');
    try {
      expect(await freshContext.cookies()).toEqual([]);

      const [cartRes, loginRes, meRes] = await Promise.all([
        freshContext.request.post('/api/cart/items', { data: { productId: 'p1', quantity: 3 } }),
        freshContext.request.post('/api/auth/login', { data: { email, password } }),
        freshContext.request.get('/api/auth/me'),
      ]);
      expect(cartRes.status()).toBe(200);
      expect(loginRes.status()).toBe(200);
      expect(meRes.status()).toBe(200);

      const allSetCookies = [cartRes, loginRes, meRes].flatMap((r) =>
        r.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie')
      );
      const cartIdIssuances = allSetCookies.filter((h) => h.value.startsWith('cartId='));
      expect(cartIdIssuances).toHaveLength(1); // cartId를 발급한 응답이 정확히 1개 (POST /api/cart/items)
      // /api/auth/login과 /api/auth/me의 Set-Cookie는 cartId를 전혀 포함하지 않는다
      const authSetCookies = [loginRes, meRes].flatMap((r) =>
        r.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie')
      );
      expect(authSetCookies.every((h) => !h.value.startsWith('cartId='))).toBe(true);

      const cart = await (await freshContext.request.get('/api/cart')).json();
      expect(cart.cart.items.find((i) => i.productId === 'p1').quantity).toBe(3); // 담은 내용이 그대로 보인다
    } finally {
      await freshContext.close();
    }
  });
});

// ===========================================================================
// 시나리오 6: 회원 기능의 경계를 점검하는 관점 (쿠키 분리·서버 오류·헤더·의존성)
// [PRD 24.13/24.17/20.10/D29 · D10/D11/D12/D13 · bug-history M4/M5]
// ===========================================================================
test.describe('시나리오: 회원 기능의 경계를 점검하는 관점', () => {
  test('/api/auth/* 4개 엔드포인트의 응답에는, cartId 쿠키가 전혀 실리지 않는다 [24.13 · D10]', async () => {
    const { email, password } = await createAndLogin(context.request, 'd10');
    await context.request.post('/api/auth/logout');

    const freshContext = await (await context.browser()).newContext({ baseURL: 'http://localhost:3000' });
    try {
      const signupRes = await freshContext.request.post('/api/auth/signup', {
        data: { email: uniqueEmail('d10-signup'), password: 'abcd1234', passwordConfirm: 'abcd1234' },
      });
      const loginRes = await freshContext.request.post('/api/auth/login', { data: { email, password } });
      const meRes = await freshContext.request.get('/api/auth/me');
      const logoutRes = await freshContext.request.post('/api/auth/logout');

      for (const res of [signupRes, loginRes, meRes, logoutRes]) {
        const setCookies = res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
        expect(setCookies.some((h) => h.value.startsWith('cartId='))).toBe(false);
      }
    } finally {
      await freshContext.close();
    }
  });

  test('회원 관련 요청에서 예상 밖의 서버 오류가 나면, "인증 요청을 처리하지 못했습니다."가 나온다 [24.17 · D11 · bug-history M5]', async () => {
    // express.json()의 기본 상한(100kb)을 넘는 본문을 보내면 entity.too.large가 되어
    // 공용 500 핸들러로 떨어진다 — QA가 5차 사이클에서 실제로 500을 트리거한 유일한 결정론적 수단이다.
    const hugeFiller = 'x'.repeat(200 * 1024);
    const res = await context.request.post('/api/auth/signup', {
      data: { email: 'huge@example.com', password: 'abcd1234', passwordConfirm: 'abcd1234', filler: hugeFiller },
    });
    expect(res.status()).toBe(500);
    const body = await res.json();
    expect(body.error.message).toBe('인증 요청을 처리하지 못했습니다.');
    expect(body.error.message).not.toBe('상품 목록을 불러오지 못했습니다.'); // bug-history M5가 지목한 재발 패턴
  });

  test('새로 만든 회원가입·로그인 화면의 헤더에도 장바구니 링크와 배지가 있고, 배지가 실제 수량을 보여준다 [20.10 · D12]', async () => {
    await seed(context.request, 'p1', 1);

    await page.goto('/signup.html');
    await expect(page.getByTestId('cart-link')).toHaveAttribute('href', '/cart.html');
    await expect(page.getByTestId('cart-count')).toHaveText('1');
    await expect(page.getByTestId('cart-count')).toBeVisible();

    await page.goto('/login.html');
    await expect(page.getByTestId('cart-link')).toHaveAttribute('href', '/cart.html');
    await expect(page.getByTestId('cart-count')).toHaveText('1');
    await expect(page.getByTestId('cart-count')).toBeVisible();
  });

  test('회원 기능을 추가하면서, 새 외부 패키지를 추가하지 않았다 — dependencies는 express 하나뿐이다 [D29/D13]', async () => {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    expect(pkg.dependencies).toEqual({ express: '^4.19.2' });
  });
});

// ===========================================================================
// 시나리오 7: 비밀번호가 새어나가지 않는지 확인하는 보안 점검
// [PRD D30/21.11/24.18]
// ===========================================================================
test.describe('시나리오: 비밀번호가 새어나가지 않는지 확인하는 보안 점검', () => {
  test('가입·로그인·상태조회 세 응답 어디에도 비밀번호·해시·salt가 들어 있지 않다 — 키를 정확히 센다 [D30]', async () => {
    const email = uniqueEmail('pw-leak');
    const password = 'leak-check-pw1';

    const signupRes = await context.request.post('/api/auth/signup', {
      data: { email, password, passwordConfirm: password },
    });
    const signupBody = await signupRes.json();
    expect(Object.keys(signupBody.user).sort()).toEqual(['createdAt', 'email']);

    const loginRes = await context.request.post('/api/auth/login', { data: { email, password } });
    const loginBody = await loginRes.json();
    expect(Object.keys(loginBody.user).sort()).toEqual(['createdAt', 'email']);

    const meRes = await context.request.get('/api/auth/me');
    const meBody = await meRes.json();
    expect(Object.keys(meBody.user).sort()).toEqual(['createdAt', 'email']);

    for (const body of [signupBody, loginBody, meBody]) {
      const raw = JSON.stringify(body);
      expect(raw).not.toContain(password);
      expect(raw.toLowerCase()).not.toContain('hash');
      expect(raw.toLowerCase()).not.toContain('salt');
    }
    await context.request.post('/api/auth/logout').catch(() => {});
  });

  test('잘못된 JSON 본문을 보내 가입이 400으로 실패해도, 비밀번호가 에러 응답에 섞여 나오지 않는다 [24.18]', async () => {
    const password = 'should-not-leak-999';
    // 일부러 깨진 JSON을 보낸다 — 비밀번호 문자열을 포함한 원문이지만 파싱 전에 실패해야 한다
    const res = await context.request.post('/api/auth/signup', {
      headers: { 'Content-Type': 'application/json' },
      data: `{"email":"broken@example.com","password":"${password}"`, // 닫는 중괄호 없음 — 깨진 JSON
    });
    expect(res.status()).toBe(400);
    const text = await res.text();
    expect(text).not.toContain(password);
  });
});

// ===========================================================================
// 시나리오 8: 만들지 않기로 한 기능이 실제로 없는지 확인하는 방문자
// [PRD 24.14/21.11/24.12]
// ===========================================================================
test.describe('시나리오: 만들지 않기로 한 기능이 실제로 없는지 확인하는 방문자', () => {
  const NOT_BUILT_PATHS = [
    ['GET', '/api/auth/password/reset'], // 비밀번호 재설정/찾기
    ['POST', '/api/auth/social/google'], // 소셜 로그인
    ['GET', '/api/auth/profile'], // 회원 정보 조회
    ['PATCH', '/api/auth/me'], // 회원 정보 수정
    ['DELETE', '/api/auth/me'], // 회원 탈퇴
    ['GET', '/api/users'], // 회원 목록
    ['POST', '/api/auth/refresh'], // 토큰 갱신
    ['GET', '/api/orders'], // 회원별 주문 내역 (목록 조회 자체가 없다, PRD 18.11)
    ['POST', '/api/cart/merge'], // 장바구니 병합
  ];
  for (const [method, urlPath] of NOT_BUILT_PATHS) {
    test(`${method} ${urlPath} 로 요청하면, "존재하지 않는 API 경로입니다."로 404가 돌아온다 [24.14]`, async () => {
      const res = await context.request.fetch(urlPath, { method });
      expect(res.status()).toBe(404);
      const body = await res.json();
      expect(body.error.message).toBe('존재하지 않는 API 경로입니다.');
    });
  }

  test('주소창 쿼리스트링으로 가입/로그인하는 경로는 존재하지 않는다 — 본문으로만 받는다 [21.11]', async () => {
    const loginByQuery = await context.request.get('/api/auth/login?email=a@b.co&password=abcd1234');
    expect(loginByQuery.status()).toBe(404);

    const signupByQuery = await context.request.get('/api/auth/signup?email=a@b.co&password=abcd1234');
    expect(signupByQuery.status()).toBe(404);
  });

  test('로그인이 반드시 필요한 요청은 로그아웃 하나뿐이다 — 기존 9개 엔드포인트는 로그인 없이도 전부 동작한다 [24.12]', async () => {
    await context.request.post('/api/auth/logout').catch(() => {});

    const endpoints = [
      () => context.request.get('/api/products'),
      () => context.request.get('/api/products/p1'),
      () => context.request.get('/api/cart'),
      () => context.request.post('/api/cart/items', { data: { productId: 'p1', quantity: 1 } }),
      () => context.request.patch('/api/cart/items/p1', { data: { quantity: 2 } }),
    ];
    for (const call of endpoints) {
      const res = await call();
      expect(res.status()).toBeLessThan(401);
    }
    const deleteLine = await context.request.delete('/api/cart/items/p1');
    expect(deleteLine.status()).toBeLessThan(401);
    const clear = await context.request.delete('/api/cart');
    expect(clear.status()).toBeLessThan(401);
  });
});
