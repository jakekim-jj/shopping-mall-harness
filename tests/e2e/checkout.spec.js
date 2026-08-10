'use strict';

/**
 * 결제 화면 — tests/test-cases.ko.md
 *   "4차 사이클 — 모의 결제" 중 "결제 화면 — 주문 요약/입력/결제 요청/성공/실패 갈래/상태와 검증 규칙"
 *   (PRD 16.1~16.20, 18.7, 18.5 일부 — UI 레벨 최소 확인)
 *
 * 규칙 (skills/shopping-mall-qa/SKILL.md)
 *   - data-testid 선택자만 쓴다. 예외: `#checkout-ready`(상태 컨테이너)와
 *     `#checkout-form`(novalidate 확인), `#checkout-error-message`/`#checkout-error-action`
 *     (checkout.html에 data-testid가 없는 지점) — product-detail.spec.js의 "목록으로 돌아가는
 *     링크" 예외와 같은 이유다.
 *   - 화면에 보이는 금액은 테스트가 계산하지 않고 GET /api/cart 응답과 문자열로 비교한다 (PRD 7.6).
 *   - "요청이 나갔는가"는 화면 모양이 아니라 실제 요청 개수로 확인한다 (16.9/16.18).
 *   - checkout-error는 두 축으로 쓰인다: ① 초기 GET /api/cart 실패 시 단독 표시("화면 전체
 *     에러"), ② 결제 요청 실패 시 #checkout-ready 위에 겹쳐서 표시. 이 둘을 구분해서 단언한다
 *     (test-cases.ko.md의 "자동화 시 주의할 점" 참고).
 *   - spec 파일 하나당 브라우저 컨텍스트(창)는 하나다. 아래 beforeAll에서 한 번만 만든다.
 */
const { test, expect } = require('@playwright/test');

// ── 파일 전체가 창 하나를 공유한다 (SKILL.md "자동화 테스트 작성 규칙") ──────────────
test.describe.configure({ mode: 'default' });

/** 이 파일의 모든 테스트가 재사용하는 컨텍스트/페이지. beforeAll에서 딱 한 번만 만든다. */
let context;
let page;

test.beforeAll(async ({ browser, baseURL, viewport }) => {
  context = await browser.newContext({ baseURL, viewport });
  page = await context.newPage();
  console.log('[checkout.spec] 공유 브라우저 컨텍스트 1개 생성 (테스트마다 새로 열지 않는다)');
});

test.afterAll(async () => {
  await context.close();
});

/** 창을 공유하는 대신, 매 테스트를 빈 장바구니에서 시작시킨다 (격리의 대체 수단). */
test.beforeEach(async () => {
  const res = await context.request.delete('/api/cart');
  expect(res.status()).toBe(200);
});

// route·listener도 컨텍스트와 함께 살아남는다. 매 테스트 뒤에 원상복구한다.
test.afterEach(async () => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  page.removeAllListeners('request');
  page.removeAllListeners('dialog');
});

function formatPrice(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원';
}

/** 화면을 열기 전에 서버 장바구니를 채운다. page와 같은 컨텍스트 = 같은 cartId 쿠키. */
async function seed(page, productId, quantity) {
  const res = await page.context().request.post('/api/cart/items', {
    data: { productId, quantity },
  });
  expect(res.status()).toBe(200);
  return (await res.json()).cart;
}

async function serverCart(page) {
  const res = await page.context().request.get('/api/cart');
  expect(res.status()).toBe(200);
  return (await res.json()).cart;
}

/**
 * 결제 화면의 4개 최상위 상태(로딩/빈/정상/화면-전체-에러) 중 정확히 하나만 보이는지 단언한다
 * (PRD 16.17). `checkout-ready`에는 data-testid가 없어 id로 잡는다 — 이 파일 상단 규칙 참고.
 * ⚠ 결제 "요청" 실패로 뜨는 checkout-error(= #checkout-ready 위에 겹쳐 보이는 경우)는 이 헬퍼로
 *   확인하지 않는다 — 그 경우는 정상적으로 ready와 error가 동시에 보여야 하기 때문이다.
 */
async function expectOnlyState(page, expected) {
  const states = {
    loading: page.getByTestId('checkout-loading'),
    empty: page.getByTestId('checkout-empty'),
    ready: page.locator('#checkout-ready'),
    'load-error': page.getByTestId('checkout-error'),
  };
  for (const [name, locator] of Object.entries(states)) {
    if (name === expected) {
      await expect(locator).toBeVisible();
    } else {
      await expect(locator).toBeHidden();
    }
  }
}

async function fillOrderer(page, name, phone) {
  await page.getByTestId('orderer-name').fill(name);
  await page.getByTestId('orderer-phone').fill(phone);
}

test.describe('결제 화면 — 주문 요약 (PRD 16.1~16.5, 16.19, 19.18)', () => {
  test('담긴 상품이 요약되어 보이고, 장바구니 정보는 딱 한 번만 조회된다 (16.1)', async () => {
    await seed(page, 'p1', 2);
    await seed(page, 'p7', 3);

    const cartGets = [];
    page.on('request', (req) => {
      if (req.method() === 'GET' && req.url().endsWith('/api/cart')) cartGets.push(req.url());
    });

    await page.goto('/checkout.html');
    await expect(page.locator('#checkout-ready')).toBeVisible();

    const cart = await serverCart(page);
    // 표시할 내용이 있는 만큼만 줄이 만들어진다 (PRD 19.18 — 할인 표시 요소와 같은 방식)
    await expect(page.getByTestId('checkout-item')).toHaveCount(cart.items.length);
    for (const item of cart.items) {
      const line = page.locator(`[data-testid="checkout-item"][data-product-id="${item.productId}"]`);
      await expect(line.getByTestId('checkout-item-name')).toHaveText(item.name);
      await expect(line.getByTestId('checkout-item-quantity')).toHaveText(String(item.quantity));
      await expect(line.getByTestId('checkout-item-total')).toHaveText(formatPrice(item.lineTotal));
    }
    await expect(page.getByTestId('checkout-total-quantity')).toHaveText(String(cart.totalQuantity));
    await expect(page.getByTestId('checkout-total-price')).toHaveText(formatPrice(cart.totalPrice));

    // 화면 요약과 상단 배지를 채우는 데 쓰인 GET /api/cart는 딱 1건이어야 한다 (bug-history M4 회피)
    await page.waitForTimeout(300);
    expect(cartGets).toHaveLength(1);
  });

  test('상단 장바구니 수량 배지는 서버가 알려준 총 수량과 같다 (16.19)', async () => {
    await seed(page, 'p1', 4);
    const cart = await serverCart(page);

    await page.goto('/checkout.html');
    await expect(page.getByTestId('cart-count')).toHaveText(String(cart.totalQuantity));
  });

  test('주문 요약은 읽기 전용이다 — 수량 증감·삭제·비우기 버튼이 없다 (16.2)', async () => {
    await seed(page, 'p1', 2);
    await page.goto('/checkout.html');

    await expect(page.locator('#checkout-summary button')).toHaveCount(0);
    await expect(
      page.locator('[data-testid*="increase"], [data-testid*="decrease"], [data-testid*="remove"]')
    ).toHaveCount(0);
    await expect(page.getByTestId('cart-clear')).toHaveCount(0);
  });

  test('장바구니로 돌아가는 링크가 있다 (16.3)', async () => {
    await seed(page, 'p1', 1);
    await page.goto('/checkout.html');

    const backlink = page.locator('main a[href="/cart.html"]');
    expect(await backlink.count()).toBeGreaterThan(0);
    await expect(backlink.first()).toBeVisible();
  });

  test('할인이 걸린 줄이 있어도 장바구니 화면과 결제 화면의 총 금액이 정확히 같다 (16.4)', async () => {
    await seed(page, 'p1', 10); // 10개 = 할인 경계
    const cart = await serverCart(page);
    expect(cart.items[0].discountApplied).toBe(true);

    await page.goto('/cart.html');
    await expect(page.getByTestId('cart-total-price')).toHaveText(formatPrice(cart.totalPrice));

    await page.goto('/checkout.html');
    await expect(page.getByTestId('checkout-total-price')).toHaveText(formatPrice(cart.totalPrice));
  });

  test('결제 화면에는 할인 표시(취소선·할인가·안내 문구)가 나타나지 않는다 (16.5)', async () => {
    await seed(page, 'p1', 10);
    await page.goto('/checkout.html');

    await expect(page.getByTestId('checkout-item')).toHaveCount(1);
    await expect(page.locator('[data-testid*="discount"]')).toHaveCount(0);
  });
});

test.describe('결제 화면 — 입력 (PRD 16.6~16.7)', () => {
  test('입력란은 주문자 이름과 연락처뿐이다 — 배송·이메일·카드 정보 입력란이 없다 (16.6)', async () => {
    await seed(page, 'p1', 1);
    await page.goto('/checkout.html');

    // 폼 안의 input은 이름 1 + 연락처 1 + 결제수단 라디오 2 = 4개가 전부
    await expect(page.locator('#checkout-form input')).toHaveCount(4);
    await expect(page.getByTestId('orderer-name')).toBeVisible();
    await expect(page.getByTestId('orderer-phone')).toBeVisible();
    await expect(
      page.locator(
        'input[type="email"], input[name*="address"], input[name*="zip"], input[name*="card"], ' +
          'input[name*="cvc"], input[name*="expiry"]'
      )
    ).toHaveCount(0);
  });

  test('결제 수단은 모의 결제 두 가지뿐이고, 승인 성공이 기본 선택이며, 이름에 "모의"·"실패 테스트용"이 드러난다 (16.7)', async () => {
    await seed(page, 'p1', 1);
    await page.goto('/checkout.html');

    await expect(page.locator('input[name="payment-method"]')).toHaveCount(2);
    await expect(page.getByTestId('payment-method-success')).toBeChecked();
    await expect(page.getByTestId('payment-method-failure')).not.toBeChecked();

    const fieldsetText = await page.locator('.payment-method').textContent();
    expect(fieldsetText).toContain('모의');
    expect(fieldsetText).toContain('실패 테스트용');
  });
});

test.describe('결제 화면 — 결제 요청 (PRD 16.8~16.10)', () => {
  test('결제 요청 시 서버에는 이름·연락처·결제수단 3개만 전달된다 (16.8)', async () => {
    await seed(page, 'p1', 3);
    const posts = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/api/checkout')) posts.push(req.postDataJSON());
    });

    await page.goto('/checkout.html');
    await fillOrderer(page, '홍길동', '010-1234-5678');
    await page.getByTestId('checkout-submit').click(); // 기본 선택 = 승인 성공
    await page.waitForURL(/\/order\.html\?orderId=/);

    expect(posts).toHaveLength(1);
    expect(Object.keys(posts[0]).sort()).toEqual(['ordererName', 'ordererPhone', 'paymentMethod']);
    expect(posts[0]).toEqual({
      ordererName: '홍길동',
      ordererPhone: '010-1234-5678',
      paymentMethod: 'MOCK_SUCCESS',
    });
  });

  test('승인 거절을 골라도 미리 판정하지 않고, 실제로 서버에 요청을 보낸 뒤에야 실패가 표시된다 (16.9)', async () => {
    await seed(page, 'p1', 1);
    const posts = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/api/checkout')) posts.push(req.postDataJSON());
    });

    await page.goto('/checkout.html');
    await fillOrderer(page, '홍길동', '010-1234-5678');
    await page.getByTestId('payment-method-failure').check();
    await page.getByTestId('checkout-submit').click();

    await expect(page.getByTestId('checkout-error')).toBeVisible();
    expect(posts).toHaveLength(1);
    expect(posts[0].paymentMethod).toBe('MOCK_FAILURE');
  });

  test('결제 버튼을 빠르게 두 번 눌러도 요청은 한 번만 나가고, 실패 후 버튼은 다시 눌릴 수 있다 (16.10)', async () => {
    await seed(page, 'p1', 1);
    await page.route('**/api/checkout', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue();
    });
    const posts = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/api/checkout')) posts.push(req.postDataJSON());
    });

    await page.goto('/checkout.html');
    await fillOrderer(page, '홍길동', '010-1234-5678');
    await page.getByTestId('payment-method-failure').check();

    const submit = page.getByTestId('checkout-submit');
    await submit.click();
    await expect(submit).toBeDisabled();
    await submit.click({ force: true }); // 응답이 오기 전(disabled 상태)에 한 번 더 누른다

    await expect(page.getByTestId('checkout-error')).toBeVisible();
    expect(posts).toHaveLength(1); // 두 번 눌러도 요청은 1건

    // 실패 후 버튼이 다시 눌릴 수 있는 상태가 된다 — 재시도로 실제 증명한다
    await expect(submit).toBeEnabled();
    await page.unroute('**/api/checkout');
    await page.getByTestId('payment-method-success').check();
    await submit.click();
    await page.waitForURL(/\/order\.html\?orderId=/);
  });
});

test.describe('결제 화면 — 성공 (PRD 16.11, 18.7)', () => {
  test('승인 성공으로 결제하면 결제 화면에 머무르지 않고 곧바로 주문 확인 화면으로 이동한다 (16.11)', async () => {
    await seed(page, 'p1', 2);
    await page.goto('/checkout.html');
    await fillOrderer(page, '홍길동', '010-1234-5678');
    await page.getByTestId('checkout-submit').click();

    await page.waitForURL(/\/order\.html\?orderId=ORD-\d{8}-[A-Z0-9]{6}$/);
  });

  test('결제 성공 후 장바구니가 비워지고 결제하기 링크도 숨겨지지만, 주문 상품 내용은 그대로 남는다 (18.7)', async () => {
    await seed(page, 'p1', 2);
    await seed(page, 'p7', 1);

    await page.goto('/checkout.html');
    await fillOrderer(page, '홍길동', '010-1234-5678');
    await page.getByTestId('checkout-submit').click();
    await page.waitForURL(/\/order\.html\?orderId=/);
    const orderId = new URL(page.url()).searchParams.get('orderId');

    // 장바구니는 비워졌다
    await page.goto('/cart.html');
    await expect(page.getByTestId('cart-empty')).toBeVisible();
    await expect(page.getByTestId('checkout-link')).toBeHidden();

    // 그래도 이미 만들어진 주문의 상품 내용은 그대로 남아 있다 (참조 공유 금지)
    const orderRes = await page.context().request.get('/api/orders/' + orderId);
    expect(orderRes.status()).toBe(200);
    const order = (await orderRes.json()).order;
    expect(order.items).toHaveLength(2);
    expect(order.items.map((i) => i.productId).sort()).toEqual(['p1', 'p7']);
  });
});

test.describe('결제 화면 — 실패 갈래 (PRD 16.12~16.16, 16.20)', () => {
  test('승인 거절 시 결제 화면에 머무르며 입력값·요약이 그대로 남고, 성공으로 바꿔 다시 누르면 성공한다 (16.12)', async () => {
    await seed(page, 'p1', 2);
    await page.goto('/checkout.html');
    const totalBefore = await page.getByTestId('checkout-total-price').textContent();

    await fillOrderer(page, '김철수', '010-9876-5432');
    await page.getByTestId('payment-method-failure').check();
    await page.getByTestId('checkout-submit').click();

    await expect(page).toHaveURL(/\/checkout\.html$/); // 이동하지 않는다
    await expect(page.getByTestId('checkout-error')).toBeVisible();
    await expect(page.locator('#checkout-error-message')).toHaveText(
      '결제가 승인되지 않았습니다. 다른 결제 수단으로 다시 시도해 주세요.'
    );

    // 입력값이 지워지지 않았다
    await expect(page.getByTestId('orderer-name')).toHaveValue('김철수');
    await expect(page.getByTestId('orderer-phone')).toHaveValue('010-9876-5432');

    // 요약도 에러에 가려지지 않고 그대로 보인다
    await expect(page.locator('#checkout-ready')).toBeVisible();
    await expect(page.getByTestId('checkout-total-price')).toHaveText(totalBefore);

    // 결제수단을 성공으로 바꿔 다시 누르면 이번엔 성공한다
    await page.getByTestId('payment-method-success').check();
    await page.getByTestId('checkout-submit').click();
    await page.waitForURL(/\/order\.html\?orderId=/);
  });

  test('주문자 이름을 비워두고 결제하면 화면이 이동하지 않고 이름 길이 안내가 표시된다 (16.13)', async () => {
    await seed(page, 'p1', 1);
    await page.goto('/checkout.html');
    await fillOrderer(page, '', '010-1234-5678');
    await page.getByTestId('checkout-submit').click();

    await expect(page).toHaveURL(/\/checkout\.html$/);
    await expect(page.getByTestId('checkout-error')).toBeVisible();
    await expect(page.locator('#checkout-error-message')).toHaveText(
      '주문자 이름을 1자 이상 30자 이하로 입력해 주세요.'
    );
  });

  test('결제 화면에 머무는 동안 장바구니가 비어버리면, 빈 장바구니 안내와 상품 목록 링크가 함께 표시된다 (16.14)', async () => {
    await seed(page, 'p1', 1);
    await page.goto('/checkout.html');
    await expect(page.locator('#checkout-ready')).toBeVisible();

    // 다른 탭에서 비운 것처럼, 화면은 그대로 둔 채 서버 장바구니만 비운다
    await page.context().request.delete('/api/cart');

    await fillOrderer(page, '홍길동', '010-1234-5678');
    await page.getByTestId('checkout-submit').click();

    await expect(page).toHaveURL(/\/checkout\.html$/);
    await expect(page.getByTestId('checkout-error')).toBeVisible();
    await expect(page.locator('#checkout-error-message')).toHaveText('장바구니가 비어 있어 결제할 수 없습니다.');
    await expect(page.locator('#checkout-error-action')).toBeVisible();
    await expect(page.locator('#checkout-error-action a[href="/"]')).toHaveCount(1);
  });

  test('네트워크 오류로 결제 요청이 실패하면 에러 안내가 표시되고 화면이 비거나 깨지지 않는다 (16.20)', async () => {
    await seed(page, 'p1', 1);
    await page.route('**/api/checkout', (route) => route.abort());

    await page.goto('/checkout.html');
    await fillOrderer(page, '홍길동', '010-1234-5678');
    await page.getByTestId('checkout-submit').click();

    await expect(page.getByTestId('checkout-error')).toBeVisible();
    await expect(page.locator('#checkout-error-message')).not.toBeEmpty();
    await expect(page.locator('#checkout-ready')).toBeVisible(); // 백지가 아니다 — 요약도 계속 보인다
    await expect(page).toHaveURL(/\/checkout\.html$/);
  });

  test('결제가 성공하지 않은 모든 경우(입력 오류·승인 거절·네트워크 오류)에 장바구니는 절대 비워지지 않는다 (16.15)', async () => {
    await seed(page, 'p1', 2);
    await seed(page, 'p7', 3);
    const before = await serverCart(page);

    await page.goto('/checkout.html');

    // ① 입력 오류
    await fillOrderer(page, '', '010-1234-5678');
    await page.getByTestId('checkout-submit').click();
    await expect(page.getByTestId('checkout-error')).toBeVisible();
    expect(await serverCart(page)).toEqual(before);

    // ② 승인 거절
    await fillOrderer(page, '홍길동', '010-1234-5678');
    await page.getByTestId('payment-method-failure').check();
    await page.getByTestId('checkout-submit').click();
    await expect(page.locator('#checkout-error-message')).toHaveText(
      '결제가 승인되지 않았습니다. 다른 결제 수단으로 다시 시도해 주세요.'
    );
    expect(await serverCart(page)).toEqual(before);

    // ③ 네트워크 오류
    await page.route('**/api/checkout', (route) => route.abort());
    await page.getByTestId('payment-method-success').check();
    await page.getByTestId('checkout-submit').click();
    await expect(page.locator('#checkout-error-message')).not.toBeEmpty();
    expect(await serverCart(page)).toEqual(before);

    // 상단 배지도 낙관적으로 미리 줄지 않았다
    await page.unroute('**/api/checkout');
    await page.reload();
    await expect(page.getByTestId('cart-count')).toHaveText(String(before.totalQuantity));
  });

  test('장바구니가 빈 상태로 결제 화면에 바로 접속하면 빈 안내와 상품 목록 링크만 보이고, 입력란·결제수단·버튼은 보이지 않는다 (16.16)', async () => {
    await page.goto('/checkout.html'); // beforeEach가 이미 장바구니를 비웠다
    await expectOnlyState(page, 'empty');
    await expect(page.locator('[data-testid="checkout-empty"] a[href="/"]')).toHaveCount(1);

    await expect(page.getByTestId('orderer-name')).toBeHidden();
    await expect(page.getByTestId('orderer-phone')).toBeHidden();
    await expect(page.getByTestId('payment-method-success')).toBeHidden();
    await expect(page.getByTestId('payment-method-failure')).toBeHidden();
    await expect(page.getByTestId('checkout-submit')).toBeHidden();
  });
});

test.describe('결제 화면 — 상태와 검증 규칙 (PRD 16.17~16.18)', () => {
  test('장바구니 정보를 아예 불러오지 못하면 요약·입력 폼은 숨겨지고 에러 안내만 보인다 (16.17)', async () => {
    await seed(page, 'p1', 1);
    await page.route('**/api/cart', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '장바구니 요청을 처리하지 못했습니다.' } }),
      })
    );

    await page.goto('/checkout.html');
    await expectOnlyState(page, 'load-error');
    await expect(page.locator('#checkout-error-message')).not.toBeEmpty();
  });

  test('로딩·정상·빈 장바구니 중 하나만 보이되, 결제 요청 실패 안내는 요약 위에 함께 표시된다 (16.17)', async () => {
    await seed(page, 'p1', 1);

    // 로딩
    await page.route('**/api/cart', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.continue();
    });
    await page.goto('/checkout.html', { waitUntil: 'commit' });
    await expectOnlyState(page, 'loading');
    await page.unroute('**/api/cart');

    // 정상
    await page.goto('/checkout.html');
    await expectOnlyState(page, 'ready');

    // 빈 장바구니
    await page.context().request.delete('/api/cart');
    await page.goto('/checkout.html');
    await expectOnlyState(page, 'empty');

    // 결제 요청 실패 안내는 예외 — 요약이 보이는 상태 위에 함께 표시된다
    await seed(page, 'p1', 1);
    await page.goto('/checkout.html');
    await expect(page.locator('#checkout-ready')).toBeVisible();
    await fillOrderer(page, '홍길동', '010-1234-5678');
    await page.getByTestId('payment-method-failure').check();
    await page.getByTestId('checkout-submit').click();
    await expect(page.getByTestId('checkout-error')).toBeVisible();
    await expect(page.locator('#checkout-ready')).toBeVisible(); // 겹쳐서 함께 보인다 — 가려지지 않는다
  });

  test('입력값을 미리 검사하지 않는다 — 완전히 비운 채 제출해도 요청이 나가고, 브라우저 자체 검증 속성도 없다 (16.18)', async () => {
    await seed(page, 'p1', 1);
    const posts = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/api/checkout')) posts.push(req.postDataJSON());
    });

    await page.goto('/checkout.html');
    await expect(page.locator('#checkout-ready')).toBeVisible();

    // 브라우저가 자체적으로 막는 입력 검사 속성이 없다
    await expect(page.locator('#checkout-form')).toHaveAttribute('novalidate', '');
    for (const testid of ['orderer-name', 'orderer-phone']) {
      const input = page.getByTestId(testid);
      expect(await input.evaluate((el) => el.hasAttribute('required'))).toBe(false);
      expect(await input.evaluate((el) => el.hasAttribute('pattern'))).toBe(false);
      expect(await input.evaluate((el) => el.hasAttribute('minlength'))).toBe(false);
      expect(await input.evaluate((el) => el.hasAttribute('maxlength'))).toBe(false);
    }

    // 이름·연락처를 완전히 비운 채 제출
    await page.getByTestId('checkout-submit').click();

    await expect(page.getByTestId('checkout-error')).toBeVisible();
    await expect(page.locator('#checkout-error-message')).not.toBeEmpty();
    await expect(page).toHaveURL(/\/checkout\.html$/);

    // 화면이 막지 않고 실제로 서버까지 요청이 나갔다
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({ ordererName: '', ordererPhone: '', paymentMethod: 'MOCK_SUCCESS' });
  });
});

test.describe('결제 화면 — 연락처 형식 검증 (PRD 18.5, UI 레벨 최소 확인 1~2개)', () => {
  // 18.5 자체는 API 단위 규칙이라 형식 조합을 전부 UI로 만들지 않는다 (과설계 금지).
  // 화면 입력란에 실제로 입력해 제출했을 때 서버 안내가 뜨는지만 대표로 1~2개 확인한다.
  for (const phone of ['010-12345678', 'abc']) {
    test(`연락처에 "${phone}"을 입력하고 제출하면 형식 오류 안내가 뜨고 화면은 이동하지 않는다 (18.5)`, async () => {
      await seed(page, 'p1', 1);
      await page.goto('/checkout.html');
      await fillOrderer(page, '홍길동', phone);
      await page.getByTestId('checkout-submit').click();

      await expect(page).toHaveURL(/\/checkout\.html$/);
      await expect(page.getByTestId('checkout-error')).toBeVisible();
      await expect(page.locator('#checkout-error-message')).toHaveText(
        '연락처를 올바른 휴대폰 번호 형식으로 입력해 주세요.'
      );
    });
  }
});
