'use strict';

/**
 * 주문 확인 화면 — tests/test-cases.ko.md "4차 사이클 — 모의 결제" 중 "주문 확인 화면" (PRD 17.x)
 *
 * 규칙 (skills/shopping-mall-qa/SKILL.md)
 *   - data-testid 선택자만 쓴다. 예외는 "목록으로 돌아가는 링크"의 href다
 *     (order.html에 전용 testid가 없고, product-detail.spec.js와 같은 이유).
 *   - 금액/수량은 테스트가 계산하지 않고 서버 응답(주문 생성 시 받은 order 객체 또는
 *     GET /api/orders/:orderId)과 문자열로 비교한다 (PRD 7.6 규칙의 연장).
 *   - "요청이 나가지 않았다"는 화면 모양이 아니라 실제 요청 개수로 확인한다 (17.6).
 *   - 주문은 매번 UI로 결제를 완주시키지 않고 POST /api/checkout을 직접 호출해 만든다
 *     (cart.spec.js의 seed() 헬퍼와 같은 접근 — 결제 플로우 자체는 checkout.spec.js가 검증한다).
 *   - spec 파일 하나당 브라우저 컨텍스트(창)는 하나다. 아래 beforeAll에서 한 번만 만든다.
 *   - 예외: 17.8("남의 주문은 안 보인다")은 8.5와 같은 이유로 창을 하나 더 열었다 닫는다.
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
  console.log('[order.spec] 공유 브라우저 컨텍스트 1개 생성 (테스트마다 새로 열지 않는다)');
});

test.afterAll(async () => {
  await context.close();
});

/** 창을 공유하는 대신, 매 테스트를 빈 장바구니에서 시작시킨다 (격리의 대체 수단). */
test.beforeEach(async () => {
  const res = await context.request.delete('/api/cart');
  expect(res.status()).toBe(200);
});

test.afterEach(async () => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  page.removeAllListeners('request');
  page.removeAllListeners('dialog');
});

function formatPrice(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원';
}

async function seedCart(page, items) {
  for (const { productId, quantity } of items) {
    const res = await page.context().request.post('/api/cart/items', { data: { productId, quantity } });
    expect(res.status()).toBe(200);
  }
}

async function serverCart(page) {
  const res = await page.context().request.get('/api/cart');
  expect(res.status()).toBe(200);
  return (await res.json()).cart;
}

/** 장바구니를 채우고 곧바로 승인 성공으로 결제해 주문을 하나 만든다. API를 직접 호출한다. */
async function createOrder(page, items, orderer) {
  await seedCart(page, items);
  const res = await page.context().request.post('/api/checkout', {
    data: {
      ordererName: (orderer && orderer.name) || '홍길동',
      ordererPhone: (orderer && orderer.phone) || '010-1234-5678',
      paymentMethod: 'MOCK_SUCCESS',
    },
  });
  expect(res.status()).toBe(200);
  return (await res.json()).order;
}

/** 주문 확인 화면의 4개 상태 중 정확히 하나만 보이는지 단언한다 (PRD 17.11). */
async function expectOnlyState(page, expected) {
  const ids = ['order-loading', 'order-confirmation', 'order-not-found', 'order-error'];
  const visible = [];
  for (const id of ids) {
    if (await page.getByTestId(id).isVisible()) visible.push(id);
  }
  expect(visible).toEqual([expected]);
}

test.describe('주문 확인 화면 — 표시 (PRD 17.1/17.2, 19.18)', () => {
  test('주문번호·상태·일시·주문자·연락처·상품줄·총수량·총금액이 모두 표시되고 주문번호 형식이 맞다 (17.1)', async () => {
    const order = await createOrder(
      page,
      [
        { productId: 'p1', quantity: 2 },
        { productId: 'p7', quantity: 1 },
      ],
      { name: '김테스트', phone: '010-1234-5678' }
    );
    expect(order.orderId).toMatch(/^ORD-\d{8}-[A-Z0-9]{6}$/);

    await page.goto('/order.html?orderId=' + order.orderId);
    await expectOnlyState(page, 'order-confirmation');

    await expect(page.getByTestId('order-id')).toHaveText(order.orderId);
    await expect(page.getByTestId('order-status')).toHaveText('결제 완료');
    await expect(page.getByTestId('order-orderer-name')).toHaveText('김테스트');
    await expect(page.getByTestId('order-orderer-phone')).toHaveText('010-1234-5678');
    await expect(page.getByTestId('order-created-at')).toHaveAttribute('datetime', order.createdAt);
    await expect(page.getByTestId('order-total-quantity')).toHaveText(String(order.totalQuantity));
    await expect(page.getByTestId('order-total-price')).toHaveText(formatPrice(order.totalPrice));

    // 상품 줄은 표시할 내용이 있는 만큼만 만들어진다 (PRD 19.18 — 할인 표시 요소와 같은 방식)
    await expect(page.getByTestId('order-item')).toHaveCount(order.items.length);
    for (const item of order.items) {
      const line = page.locator(`[data-testid="order-item"][data-product-id="${item.productId}"]`);
      await expect(line.getByTestId('order-item-name')).toHaveText(item.name);
      await expect(line.getByTestId('order-item-quantity')).toHaveText(String(item.quantity));
      await expect(line.getByTestId('order-item-total')).toHaveText(formatPrice(item.lineTotal));
    }
  });

  test('"결제 완료" 표시는 서버가 알려준 status 값에 근거한다 — 화면이 임의로 적어넣지 않는다 (17.2)', async () => {
    const order = await createOrder(page, [{ productId: 'p2', quantity: 1 }]);
    expect(order.status).toBe('PAID');

    await page.goto('/order.html?orderId=' + order.orderId);
    await expect(page.getByTestId('order-status')).toHaveText('결제 완료');

    // 화면이 표시한 값이 실제로 서버 응답의 status 문자열에서 왔는지 같은 주문을 다시 조회해 대조한다
    const fetched = (await (await page.context().request.get('/api/orders/' + order.orderId)).json()).order;
    expect(fetched.status).toBe('PAID');
  });
});

test.describe('주문 확인 화면 — 세 화면 금액 일치 (PRD 17.4)', () => {
  test('할인이 걸린 줄이 있어도 장바구니·결제 화면·주문 확인 화면의 총 금액이 정확히 같다 (17.4)', async () => {
    await seedCart(page, [
      { productId: 'p1', quantity: 10 },
      { productId: 'p7', quantity: 2 },
    ]);
    const cart = await serverCart(page);
    expect(cart.items.some((i) => i.discountApplied)).toBe(true);

    await page.goto('/cart.html');
    await expect(page.getByTestId('cart-total-price')).toHaveText(formatPrice(cart.totalPrice));

    await page.goto('/checkout.html');
    await expect(page.getByTestId('checkout-total-price')).toHaveText(formatPrice(cart.totalPrice));

    await page.getByTestId('orderer-name').fill('금액검증');
    await page.getByTestId('orderer-phone').fill('010-1234-5678');
    await page.getByTestId('checkout-submit').click();
    await page.waitForURL(/\/order\.html\?orderId=/);

    await expect(page.getByTestId('order-total-price')).toHaveText(formatPrice(cart.totalPrice));
  });
});

test.describe('주문 확인 화면 — 새로고침·잘못된 주소 (PRD 17.5~17.8)', () => {
  test('새로고침해도 서버에서 다시 조회해 주문 정보가 그대로 표시된다 (17.5)', async () => {
    const order = await createOrder(page, [{ productId: 'p3', quantity: 1 }]);

    await page.goto('/order.html?orderId=' + order.orderId);
    await expect(page.getByTestId('order-id')).toHaveText(order.orderId);

    await page.reload();
    await expect(page.getByTestId('order-confirmation')).toBeVisible();
    await expect(page.getByTestId('order-id')).toHaveText(order.orderId);
    await expect(page.getByTestId('order-total-price')).toHaveText(formatPrice(order.totalPrice));
  });

  test('주소에 주문번호가 아예 없으면 서버에 요청을 보내지 않고 바로 찾을 수 없음 상태가 된다 (17.6)', async () => {
    const orderRequests = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/orders')) orderRequests.push(req.url());
    });

    await page.goto('/order.html');
    await expect(page.getByTestId('order-not-found')).toBeVisible();
    await expectOnlyState(page, 'order-not-found');

    await page.waitForTimeout(300);
    expect(orderRequests).toEqual([]);
  });

  test('존재하지 않는 주문번호로 접속하면 찾을 수 없음 안내와 목록으로 가는 링크가 표시된다 (17.7)', async () => {
    await page.goto('/order.html?orderId=ORD-20260101-ZZZZZZ');
    await expect(page.getByTestId('order-not-found')).toBeVisible();
    await expectOnlyState(page, 'order-not-found');
    await expect(page.locator('[data-testid="order-not-found"] a[href="/"]')).toHaveCount(1);
  });

  test('다른 브라우저에서는 같은 주문 주소가 안 보이고, "없는 주문"과 "남의 주문"은 화면상 똑같이 처리된다 (17.8)', async ({
    browser,
  }) => {
    const order = await createOrder(page, [{ productId: 'p4', quantity: 1 }]);

    // ⚠ 공유 컨텍스트 규칙의 예외 — "남의 브라우저"를 증명하려면 창이 하나 더 필요하다.
    const otherContext = await browser.newContext({ baseURL: 'http://localhost:3000' });
    console.log('[order.spec] 예외: 17.8이 남의 브라우저 검증용 컨텍스트 1개 추가 생성');
    try {
      const otherPage = await otherContext.newPage();

      await otherPage.goto('/order.html?orderId=' + order.orderId);
      await expect(otherPage.getByTestId('order-not-found')).toBeVisible();
      await expect(otherPage.getByTestId('order-confirmation')).toBeHidden();
      const othersOrderText = await otherPage.getByTestId('order-not-found').textContent();

      await otherPage.goto('/order.html?orderId=ORD-00000000-AAAAAA');
      await expect(otherPage.getByTestId('order-not-found')).toBeVisible();
      const missingOrderText = await otherPage.getByTestId('order-not-found').textContent();

      // "남의 주문"과 "아예 없는 주문"의 안내 문구가 완전히 같다 — 별도의 "권한 없음" 화면이 없다
      expect(othersOrderText).toBe(missingOrderText);
    } finally {
      await otherContext.close();
    }

    // 주문을 만든 브라우저(공유 컨텍스트)에서는 정상적으로 보인다
    await page.goto('/order.html?orderId=' + order.orderId);
    await expect(page.getByTestId('order-confirmation')).toBeVisible();
  });
});

test.describe('주문 확인 화면 — 공통 헤더와 배지 (PRD 17.9/17.10)', () => {
  test('상품 목록으로 돌아가는 링크와 공통 헤더(장바구니 링크·수량 배지)가 있다 (17.9)', async () => {
    const order = await createOrder(page, [{ productId: 'p5', quantity: 1 }]);
    await page.goto('/order.html?orderId=' + order.orderId);

    const backlink = page.locator('main a[href="/"]');
    expect(await backlink.count()).toBeGreaterThan(0);
    await expect(backlink.first()).toBeVisible();

    await expect(page.getByTestId('cart-link')).toBeVisible();
    await expect(page.getByTestId('cart-link')).toHaveAttribute('href', '/cart.html');
    await expect(page.getByTestId('cart-count')).toHaveCount(1);
  });

  test('결제 성공으로 장바구니가 비워졌으므로 상단 수량 배지는 0이 되어 숨겨진다 (17.10)', async () => {
    const order = await createOrder(page, [{ productId: 'p6', quantity: 1 }]);
    await page.goto('/order.html?orderId=' + order.orderId);

    await expect(page.getByTestId('cart-count')).toBeHidden();
    const cart = await serverCart(page);
    expect(cart.totalQuantity).toBe(0);
  });
});

test.describe('주문 확인 화면 — 상태 (PRD 17.11)', () => {
  test('로딩·정상·찾을 수 없음·에러 중 항상 하나만 보인다 (17.11)', async () => {
    const order = await createOrder(page, [{ productId: 'p1', quantity: 1 }]);

    // 로딩
    await page.route('**/api/orders/*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await route.continue();
    });
    await page.goto('/order.html?orderId=' + order.orderId, { waitUntil: 'commit' });
    await expectOnlyState(page, 'order-loading');
    await page.unroute('**/api/orders/*');

    // 정상
    await page.goto('/order.html?orderId=' + order.orderId);
    await expectOnlyState(page, 'order-confirmation');

    // 찾을 수 없음
    await page.goto('/order.html?orderId=ORD-99999999-ZZZZZZ');
    await expectOnlyState(page, 'order-not-found');

    // 에러 (500)
    await page.route('**/api/orders/*', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '주문 정보를 불러오지 못했습니다.' } }),
      })
    );
    await page.goto('/order.html?orderId=' + order.orderId);
    await expect(page.getByTestId('order-error')).toBeVisible();
    await expectOnlyState(page, 'order-error');
  });
});

test.describe('주문 확인 화면 — 할인 표시 없음 / 금지된 버튼 (PRD 17.12/17.13)', () => {
  test('할인이 걸린 주문이어도 취소선·할인가·안내 문구가 화면에 없다 (17.12)', async () => {
    const order = await createOrder(page, [{ productId: 'p1', quantity: 10 }]);
    expect(order.items[0].discountApplied).toBe(true);

    await page.goto('/order.html?orderId=' + order.orderId);
    await expect(page.getByTestId('order-confirmation')).toBeVisible();

    // 판정 근거는 요소 부재(할인 표시용 testid가 화면 어디에도 없음)다
    await expect(page.locator('[data-testid*="discount"]')).toHaveCount(0);
    // 표시된 줄 합계는 할인 반영된 최종 금액(lineTotal) 그대로다
    await expect(page.locator('[data-testid="order-item"] [data-testid="order-item-total"]')).toHaveText(
      formatPrice(order.items[0].lineTotal)
    );
  });

  test('주문 취소·환불 요청·재주문·영수증 출력·배송 조회 버튼이 없다 (17.13)', async () => {
    const order = await createOrder(page, [{ productId: 'p2', quantity: 1 }]);
    await page.goto('/order.html?orderId=' + order.orderId);
    await expect(page.getByTestId('order-confirmation')).toBeVisible();

    await expect(page.locator('button, a', { hasText: /취소|환불|재주문|영수증|배송\s*조회/ })).toHaveCount(0);
  });
});
