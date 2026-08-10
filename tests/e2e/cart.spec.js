'use strict';

/**
 * 장바구니 화면 — tests/test-cases.ko.md
 *   "2차 사이클 — 장바구니 화면 + 세션" (PRD 7.1~7.10, 8.1~8.5)
 *   "3차 사이클 — 전체 비우기 + 수량 할인" (PRD 11.1~11.8, 12.1~12.15, 13.1~13.2, 14.1~14.6)
 *
 * 규칙 (skills/shopping-mall-qa/SKILL.md)
 *   - 화면에 보이는 금액은 절대 테스트 안에서 곱하거나 더해서 만들지 않는다.
 *     항상 GET /api/cart를 같은 세션으로 따로 호출해 서버 값과 문자열 비교한다 (PRD 7.6).
 *   - "요청이 나가지 않았다"는 화면 모양이 아니라 요청 개수 0으로 단언한다.
 *   - 경계값(9 / 10)은 금액이 아니라 discountApplied와 요소 "개수"로 판정한다.
 *     price=19000일 때 9개와 10개의 줄 합계가 둘 다 171,000원이라 금액으로는 구분되지 않는다.
 *   - cart-clear는 "DOM 존재 + hidden"(PRD 14.1), 할인 요소 2개는 "DOM 부재"(PRD 14.4)다.
 *     toBeHidden()과 toHaveCount(0)을 규칙대로 구분해서 쓴다 (bug-history M2).
 *   - spec 파일 하나당 브라우저 컨텍스트(창)는 하나다. 아래 beforeAll에서 한 번만 만든다.
 *
 * 장바구니 격리: 이 파일의 24개 테스트는 창(=cartId 쿠키) 하나를 공유하므로, 앞 테스트가
 * 담아둔 상품이 그대로 남는다. 거의 모든 테스트가 "빈 장바구니에서 시작"을 전제로 줄 개수와
 * 합계를 단언하므로, beforeEach에서 DELETE /api/cart로 서버 장바구니를 비우고 시작한다.
 * (컨텍스트 격리가 사라진 자리를 명시적 초기화로 대체한 것이지, 단언을 느슨하게 바꾼 게 아니다.)
 */
const { test, expect } = require('@playwright/test');

// ── 파일 전체가 창 하나를 공유한다 (SKILL.md "자동화 테스트 작성 규칙") ──────────────
// Playwright 기본값(테스트마다 새 컨텍스트)이면 이 파일에서만 창이 24번 열리고 닫힌다.
// mode:'default'는 config의 fullyParallel을 이 파일에 한해 끄고 선언 순서대로 한 워커에서
// 돌게 한다 — 공유 page가 성립하려면 모든 테스트가 같은 워커에 있어야 하기 때문이다.
test.describe.configure({ mode: 'default' });

/** 이 파일의 모든 테스트가 재사용하는 컨텍스트/페이지. beforeAll에서 딱 한 번만 만든다. */
let context;
let page;

test.beforeAll(async ({ browser, baseURL, viewport }) => {
  // browser.newContext()는 config의 use 옵션을 자동으로 물려받지 않으므로 명시적으로 넘긴다
  context = await browser.newContext({ baseURL, viewport });
  page = await context.newPage();
  console.log('[cart.spec] 공유 브라우저 컨텍스트 1개 생성 (테스트마다 새로 열지 않는다)');
});

test.afterAll(async () => {
  await context.close();
});

/** 창을 공유하는 대신, 매 테스트를 빈 장바구니에서 시작시킨다 (격리의 대체 수단). */
test.beforeEach(async () => {
  const res = await context.request.delete('/api/cart');
  expect(res.status()).toBe(200);
});

// route·listener도 컨텍스트와 함께 살아남는다. 특히 7.9의 `**/api/cart` 500 라우트가
// 남으면 뒤따르는 모든 테스트가 에러 상태로 깨진다. 매 테스트 뒤에 원상복구한다.
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

/** 화면과 대조할 "정답" — 서버가 지금 들고 있는 스냅샷을 직접 조회한다. */
async function serverCart(page) {
  const res = await page.context().request.get('/api/cart');
  expect(res.status()).toBe(200);
  return (await res.json()).cart;
}

/** 장바구니 화면의 4개 상태 중 정확히 하나만 보이는지 단언한다 (PRD 7.9). */
async function expectOnlyState(page, expected) {
  const ids = ['cart-loading', 'cart-list', 'cart-empty', 'cart-error'];
  const visible = [];
  for (const id of ids) {
    if (await page.getByTestId(id).isVisible()) {
      visible.push(id);
    }
  }
  expect(visible).toEqual([expected]);
}

/** 화면에 그려진 모든 금액이 서버 스냅샷과 문자 단위로 같은지 확인한다 (PRD 7.6 / 12.6). */
async function expectTotalsMatchServer(page) {
  const cart = await serverCart(page);

  await expect(page.getByTestId('cart-total-quantity')).toHaveText(String(cart.totalQuantity));
  await expect(page.getByTestId('cart-total-price')).toHaveText(formatPrice(cart.totalPrice));

  for (const item of cart.items) {
    const line = page.locator(`[data-testid="cart-item"][data-product-id="${item.productId}"]`);
    await expect(line.getByTestId('cart-item-quantity')).toHaveText(String(item.quantity));
    await expect(line.getByTestId('cart-item-price')).toHaveText(formatPrice(item.price));
    await expect(line.getByTestId('cart-item-total')).toHaveText(formatPrice(item.lineTotal));
  }
  return cart;
}

test.describe('장바구니 화면 — 줄 표시 (PRD 7.1/7.6)', () => {
  test('담긴 줄마다 이미지·이름·단가·수량·줄 합계가 서버 값 그대로 표시된다 (7.1)', async () => {
    await seed(page, 'p1', 2);
    await seed(page, 'p7', 1);

    await page.goto('/cart.html');
    await expect(page.getByTestId('cart-item')).toHaveCount(2);
    await expectOnlyState(page, 'cart-list');

    const cart = await serverCart(page);
    for (const item of cart.items) {
      const line = page.locator(`[data-testid="cart-item"][data-product-id="${item.productId}"]`);
      await expect(line.getByTestId('cart-item-name')).toHaveText(item.name);
      await expect(line.locator('img')).toHaveAttribute('src', item.imageUrl);
    }
    await expectTotalsMatchServer(page);
  });

  test('화면의 합계는 프론트 계산이 아니라 서버 응답 값과 일치한다 (7.6)', async () => {
    await seed(page, 'p2', 3);
    await seed(page, 'p6', 2);

    await page.goto('/cart.html');
    await expect(page.getByTestId('cart-item')).toHaveCount(2);

    // 화면을 그린 것과 별개로 서버에 직접 물어본 값과 대조한다
    const cart = await expectTotalsMatchServer(page);
    expect(cart.totalPrice).toBe(cart.items.reduce((s, i) => s + i.lineTotal, 0));
  });
});

test.describe('장바구니 화면 — 수량 변경 (PRD 7.2/7.3/7.4)', () => {
  test('수량 변경은 증감분이 아니라 "변경 후 절대 수량"을 보낸다 (7.2/7.3)', async () => {
    await seed(page, 'p1', 2);

    const patchBodies = [];
    page.on('request', (req) => {
      if (req.method() === 'PATCH' && req.url().includes('/api/cart/items/')) {
        patchBodies.push({ url: req.url(), body: req.postDataJSON() });
      }
    });

    await page.goto('/cart.html');
    const line = page.locator('[data-testid="cart-item"][data-product-id="p1"]');
    await expect(line.getByTestId('cart-item-quantity')).toHaveText('2');

    await line.getByTestId('cart-item-increase').click();
    await expect(line.getByTestId('cart-item-quantity')).toHaveText('3');

    expect(patchBodies).toHaveLength(1);
    expect(patchBodies[0].url).toContain('/api/cart/items/p1');
    // 보낸 값은 delta(1)가 아니라 변경 후 총 수량(3)이어야 한다
    expect(patchBodies[0].body).toEqual({ quantity: 3 });

    await expectTotalsMatchServer(page);
  });

  test('수량 1에서 감소를 눌러도 quantity 0 요청이 나가지 않고 줄이 사라지지 않는다 (7.4)', async () => {
    await seed(page, 'p5', 1);

    const patchRequests = [];
    page.on('request', (req) => {
      if (req.method() === 'PATCH' && req.url().includes('/api/cart/items/')) {
        patchRequests.push(req.postDataJSON());
      }
    });

    await page.goto('/cart.html');
    const line = page.locator('[data-testid="cart-item"][data-product-id="p5"]');
    await expect(line.getByTestId('cart-item-quantity')).toHaveText('1');
    await expect(line.getByTestId('cart-item-decrease')).toBeDisabled();

    await line.getByTestId('cart-item-decrease').click({ force: true });
    await page.waitForTimeout(300);

    // 화면이 그대로인 것만으로는 부족하다 — 요청 자체가 0건이어야 한다
    expect(patchRequests).toEqual([]);
    await expect(page.getByTestId('cart-item')).toHaveCount(1);
    await expect(line.getByTestId('cart-item-quantity')).toHaveText('1');
    await expectOnlyState(page, 'cart-list');

    const cart = await serverCart(page);
    expect(cart.items[0].quantity).toBe(1);
  });
});

test.describe('장바구니 화면 — 삭제와 빈 상태 (PRD 7.5/7.7/7.8)', () => {
  test('줄의 삭제 버튼을 누르면 그 상품만 사라지고 다른 줄은 그대로다 (7.5)', async () => {
    await seed(page, 'p1', 2);
    await seed(page, 'p7', 1);

    await page.goto('/cart.html');
    await expect(page.getByTestId('cart-item')).toHaveCount(2);

    const kept = page.locator('[data-testid="cart-item"][data-product-id="p7"]');
    const keptQuantityBefore = await kept.getByTestId('cart-item-quantity').textContent();
    const keptTotalBefore = await kept.getByTestId('cart-item-total').textContent();

    await page
      .locator('[data-testid="cart-item"][data-product-id="p1"]')
      .getByTestId('cart-item-remove')
      .click();

    await expect(page.getByTestId('cart-item')).toHaveCount(1);
    await expect(page.locator('[data-testid="cart-item"][data-product-id="p1"]')).toHaveCount(0);
    await expect(kept.getByTestId('cart-item-quantity')).toHaveText(keptQuantityBefore);
    await expect(kept.getByTestId('cart-item-total')).toHaveText(keptTotalBefore);

    await expectTotalsMatchServer(page);
  });

  test('장바구니가 비어 있으면 빈 상태만 보이고 합계 영역은 숨겨진다 (7.7)', async () => {
    await page.goto('/cart.html');

    await expect(page.getByTestId('cart-empty')).toBeVisible();
    await expect(page.getByTestId('cart-item')).toHaveCount(0);
    await expectOnlyState(page, 'cart-empty');

    // 요약 영역은 DOM에는 남고 화면에서만 사라진다
    await expect(page.getByTestId('cart-summary')).toHaveCount(1);
    await expect(page.getByTestId('cart-summary')).toBeHidden();
    await expect(page.locator('[data-testid="cart-empty"] a[href="/"]')).toHaveCount(1);
  });

  test('마지막 항목을 삭제하면 추가 조회 없이 즉시 빈 상태가 된다 (7.8)', async () => {
    await seed(page, 'p6', 1);

    await page.goto('/cart.html');
    await expect(page.getByTestId('cart-item')).toHaveCount(1);

    const getsAfterClick = [];
    page.on('request', (req) => {
      if (req.method() === 'GET' && req.url().endsWith('/api/cart')) {
        getsAfterClick.push(req.url());
      }
    });

    await page.getByTestId('cart-item-remove').click();

    await expect(page.getByTestId('cart-empty')).toBeVisible();
    await expectOnlyState(page, 'cart-empty');
    await expect(page.getByTestId('cart-summary')).toBeHidden();
    await expect(page.getByTestId('cart-count')).toBeHidden();

    // DELETE 응답 스냅샷만으로 다시 그린다 — 배지·목록용 GET을 새로 쏘지 않는다
    await page.waitForTimeout(300);
    expect(getsAfterClick).toEqual([]);
  });
});

test.describe('장바구니 화면 — 실패 처리 (PRD 7.9)', () => {
  test('수량 변경이 실패하면 에러 상태 하나만 보인다 (7.9)', async () => {
    await seed(page, 'p1', 2);

    await page.goto('/cart.html');
    await expect(page.getByTestId('cart-item')).toHaveCount(1);

    await page.route('**/api/cart/items/*', async (route, request) => {
      if (request.method() === 'PATCH') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: '장바구니 요청을 처리하지 못했습니다.' } }),
        });
        return;
      }
      await route.continue();
    });

    await page.getByTestId('cart-item-increase').click();

    await expect(page.getByTestId('cart-error')).toBeVisible();
    await expectOnlyState(page, 'cart-error');

    // 서버 상태는 바뀌지 않았다 (낙관적 갱신을 하지 않는다)
    const cart = await serverCart(page);
    expect(cart.items[0].quantity).toBe(2);
  });

  test('조회가 실패하면 에러 상태 하나만 보이고 화면이 백지가 되지 않는다 (7.9)', async () => {
    await page.route('**/api/cart', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '장바구니 요청을 처리하지 못했습니다.' } }),
      })
    );

    await page.goto('/cart.html');
    await expect(page.getByTestId('cart-error')).toBeVisible();
    await expect(page.getByTestId('cart-error')).not.toBeEmpty();
    await expectOnlyState(page, 'cart-error');
  });
});

test.describe('장바구니 세션 (PRD 8.1~8.5)', () => {
  test('장바구니 내용은 브라우저가 아니라 서버에 저장된다 (8.1)', async () => {
    await page.goto('/cart.html'); // 화면을 먼저 연다 (cartId 쿠키는 공유 컨텍스트가 이미 갖고 있다)
    await seed(page, 'p1', 2);
    await page.reload();
    await expect(page.getByTestId('cart-item')).toHaveCount(1);

    const stored = await page.evaluate(() => ({
      localStorage: Object.keys(localStorage),
      sessionStorage: Object.keys(sessionStorage),
    }));
    expect(stored.localStorage).toEqual([]);
    expect(stored.sessionStorage).toEqual([]);

    // 브라우저 저장소를 통째로 비워도 장바구니는 그대로다 — 저장 주체가 서버 한 곳뿐이기 때문
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.reload();
    await expect(page.getByTestId('cart-item')).toHaveCount(1);
    await expect(page.getByTestId('cart-item-quantity')).toHaveText('2');
  });

  // ⚠ 공유 컨텍스트 규칙의 예외 — "처음 방문"을 검증하려면 쿠키가 하나도 없는 창이 있어야 한다.
  //   파일 공유 컨텍스트에는 이미 cartId가 발급돼 있어서 이 테스트를 그 창에서는 할 수 없다.
  test('처음 방문하면 서버가 장바구니 식별 정보를 발급하고 7일간 유지된다 (8.2/8.4)', async ({ browser }) => {
    const freshContext = await browser.newContext({ baseURL: 'http://localhost:3000' });
    console.log('[cart.spec] 예외: 8.2/8.4가 "쿠키 없는 첫 방문"용 컨텍스트 1개 추가 생성');
    try {
      expect(await freshContext.cookies()).toEqual([]); // 처음에는 식별 정보가 없다

      const freshPage = await freshContext.newPage();
      await freshPage.goto('/cart.html');
      await expect(freshPage.getByTestId('cart-empty')).toBeVisible();

      const cartId = (await freshContext.cookies()).find((c) => c.name === 'cartId');
      expect(cartId).toBeTruthy();
      expect(cartId.value.length).toBeGreaterThan(0);
      expect(cartId.path).toBe('/');
      expect(cartId.httpOnly).toBe(true);
      expect(cartId.sameSite).toBe('Lax');
      // 로컬 http에서 쿠키가 저장되도록 Secure는 붙이지 않는다 (붙이면 장바구니가 매 요청 초기화된다)
      expect(cartId.secure).toBe(false);

      // 유효기간 7일 (604800초). 왕복 지연을 감안해 60초 오차를 허용한다
      const remainingSeconds = cartId.expires - Date.now() / 1000;
      expect(Math.abs(remainingSeconds - 7 * 24 * 60 * 60)).toBeLessThan(60);

      // 두 번째 요청부터는 같은 식별 정보를 계속 쓴다 (재발급하지 않는다)
      await freshPage.reload();
      const reused = (await freshContext.cookies()).find((c) => c.name === 'cartId');
      expect(reused.value).toBe(cartId.value);
    } finally {
      await freshContext.close();
    }
  });

  test('새로고침하거나 다른 화면을 거쳐 돌아와도 담긴 내용이 유지된다 (8.3)', async () => {
    await seed(page, 'p1', 2);

    await page.goto('/cart.html');
    await expect(page.getByTestId('cart-item')).toHaveCount(1);

    await page.reload();
    await expect(page.getByTestId('cart-item')).toHaveCount(1);
    await expect(page.getByTestId('cart-item-quantity')).toHaveText('2');

    await page.goto('/');
    await expect(page.getByTestId('cart-count')).toHaveText('2');
    await page.goto('/cart.html');
    await expect(page.getByTestId('cart-item')).toHaveCount(1);
    await expectTotalsMatchServer(page);
  });

  // ⚠ 공유 컨텍스트 규칙의 명시적 예외 (SKILL.md) — "서로 다른 브라우저가 독립적인가"를
  //   증명하려면 창이 2개 이상 필요하다. 파일 공유 창 하나로는 이 요구사항 자체를 못 만든다.
  test('서로 다른 브라우저 컨텍스트는 완전히 독립된 장바구니를 갖는다 (8.5)', async ({ browser }) => {
    const contextA = await browser.newContext({ baseURL: 'http://localhost:3000' });
    const contextB = await browser.newContext({ baseURL: 'http://localhost:3000' });
    console.log('[cart.spec] 예외: 8.5가 격리 증명용 컨텍스트 2개 추가 생성');

    try {
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();

      await contextA.request.post('/api/cart/items', { data: { productId: 'p3', quantity: 4 } });

      await pageA.goto('/cart.html');
      await expect(pageA.getByTestId('cart-item')).toHaveCount(1);
      await expect(pageA.getByTestId('cart-count')).toHaveText('4');

      // B에는 A가 담은 상품이 보이지 않아야 한다
      await pageB.goto('/cart.html');
      await expect(pageB.getByTestId('cart-empty')).toBeVisible();
      await expect(pageB.getByTestId('cart-item')).toHaveCount(0);
      await expect(pageB.getByTestId('cart-count')).toBeHidden();

      // B에서 담아도 A는 영향받지 않는다
      await contextB.request.post('/api/cart/items', { data: { productId: 'p8', quantity: 1 } });
      await pageB.reload();
      await expect(pageB.locator('[data-testid="cart-item"][data-product-id="p8"]')).toHaveCount(1);
      await expect(pageB.locator('[data-testid="cart-item"][data-product-id="p3"]')).toHaveCount(0);

      await pageA.reload();
      await expect(pageA.locator('[data-testid="cart-item"][data-product-id="p3"]')).toHaveCount(1);
      await expect(pageA.locator('[data-testid="cart-item"][data-product-id="p8"]')).toHaveCount(0);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});

test.describe('장바구니 전체 비우기 (PRD 11.1~11.5, 13.2)', () => {
  test('비우기 버튼 한 번에 DELETE /api/cart가 정확히 1건만 나가고 줄 단위 삭제는 0건이다 (11.1/11.2/11.3)', async () => {
    await seed(page, 'p1', 2);
    await seed(page, 'p7', 3);
    await seed(page, 'p4', 1);

    // 확인 다이얼로그가 뜨면 자동화가 그 자리에서 멈춘다 (PRD D10 / 11.4)
    let dialogFired = false;
    page.on('dialog', async (dialog) => {
      dialogFired = true;
      await dialog.dismiss();
    });

    await page.goto('/cart.html');
    await expect(page.getByTestId('cart-item')).toHaveCount(3);
    await expect(page.getByTestId('cart-clear')).toBeVisible();

    const requestsAfterClick = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/cart')) {
        requestsAfterClick.push(req.method() + ' ' + new URL(req.url()).pathname);
      }
    });

    await page.getByTestId('cart-clear').click();

    await expect(page.getByTestId('cart-empty')).toBeVisible();
    await expect(page.getByTestId('cart-item')).toHaveCount(0);
    await expectOnlyState(page, 'cart-empty');
    await expect(page.getByTestId('cart-summary')).toBeHidden();
    await expect(page.getByTestId('cart-count')).toHaveText('0');
    await expect(page.getByTestId('cart-count')).toBeHidden();

    await page.waitForTimeout(300);
    // 줄 개수(3)만큼 DELETE를 반복하는 구현이면 여기서 즉시 잡힌다
    expect(requestsAfterClick).toEqual(['DELETE /api/cart']);
    expect(dialogFired).toBe(false);

    // 화면만 비운 게 아니라 서버 장바구니가 실제로 비었다 (11.7)
    const cart = await serverCart(page);
    expect(cart).toEqual({ items: [], totalQuantity: 0, totalPrice: 0 });
  });

  test('장바구니가 비어 있으면 비우기 버튼은 DOM에 남되 보이지 않는다 (11.5/14.1)', async () => {
    await page.goto('/cart.html');
    await expect(page.getByTestId('cart-empty')).toBeVisible();

    // 존재(count)와 가시성(visible)을 각각 단언한다 — 규칙이 다르다 (bug-history M2)
    await expect(page.getByTestId('cart-clear')).toHaveCount(1);
    await expect(page.getByTestId('cart-clear')).toBeHidden();

    await seed(page, 'p1', 1);
    await page.reload();
    await expect(page.getByTestId('cart-clear')).toBeVisible();
  });

  test('이미 비어 있는 장바구니를 다시 비워도 에러가 나지 않는다 — 멱등 (11.3/13.2)', async () => {
    // 화면에서는 버튼이 숨겨져 있으므로(11.5) 멱등성은 엔드포인트로 확인한다
    const first = await page.context().request.delete('/api/cart');
    const second = await page.context().request.delete('/api/cart');
    const third = await page.context().request.delete('/api/cart');

    for (const res of [first, second, third]) {
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.cart).toEqual({ items: [], totalQuantity: 0, totalPrice: 0 });
    }

    await page.goto('/cart.html');
    await expectOnlyState(page, 'cart-empty');
  });

  test('비우기 버튼은 장바구니 화면에만 있다 (11.8)', async () => {
    await page.goto('/');
    await expect(page.getByTestId('cart-clear')).toHaveCount(0);

    await page.goto('/product.html?id=p1');
    await expect(page.getByTestId('product-detail')).toBeVisible();
    await expect(page.getByTestId('cart-clear')).toHaveCount(0);
  });

});

// ⚠ 4차 개정 — 여기 있던 "장바구니 화면에는 결제/주문 버튼이 없다 (7.10)" 테스트는 폐기되었다.
// 4차에서 PRD 7.10이 15.1로 대체되어 "결제하기" 링크가 정상적으로 생겼기 때문이다
// (test-cases.ko.md "4차 사이클에서 폐기된 기존 케이스" 참고). 아래 15.x 블록으로 교체한다.
test.describe('장바구니 → 결제 진입 (PRD 15.1~15.5, 19.18)', () => {
  test('담긴 상품이 있으면 결제하기 링크가 보이고, 진짜 링크라서 누르면 이동하고 뒤로가기도 정상 동작한다 (15.1)', async () => {
    await seed(page, 'p1', 2);
    await page.goto('/cart.html');

    const link = page.getByTestId('checkout-link');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', '/checkout.html');
    // JS 버튼이 아니라 진짜 <a> 링크다 — 새 탭·뒤로가기 등 브라우저 기본 동작이 그대로 통한다
    expect(await link.evaluate((el) => el.tagName)).toBe('A');

    await link.click();
    await expect(page).toHaveURL(/\/checkout\.html$/);

    await page.goBack();
    await expect(page).toHaveURL(/\/cart\.html$/);
    await expect(page.getByTestId('cart-item')).toHaveCount(1);
  });

  test('장바구니가 비어 있으면 결제하기 링크는 DOM에는 남고 화면에서만 숨겨진다 (15.2/19.18)', async () => {
    await page.goto('/cart.html');
    await expect(page.getByTestId('cart-empty')).toBeVisible();

    await expect(page.getByTestId('checkout-link')).toHaveCount(1);
    await expect(page.getByTestId('checkout-link')).toBeHidden();

    await seed(page, 'p1', 1);
    await page.reload();
    await expect(page.getByTestId('checkout-link')).toBeVisible();
  });

  test('결제하기 링크가 생겨도 비우기 버튼은 그대로 있고, 결제하기를 눌러도 장바구니가 비워지지 않는다 (15.5)', async () => {
    await seed(page, 'p1', 2);
    await page.goto('/cart.html');

    await expect(page.getByTestId('cart-clear')).toBeVisible();
    await expect(page.getByTestId('checkout-link')).toBeVisible();

    await page.getByTestId('checkout-link').click();
    await expect(page).toHaveURL(/\/checkout\.html$/);

    // 결제를 완료한 게 아니라 그냥 이동만 했을 뿐이므로 서버 장바구니는 그대로다
    const cart = await serverCart(page);
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]).toMatchObject({ productId: 'p1', quantity: 2 });
  });

  test('결제 화면으로 들어가는 입구는 장바구니 화면 하나뿐이다 — 목록·상세·헤더 어디에도 없다 (15.3)', async () => {
    await page.goto('/');
    await expect(page.locator('[data-testid*="checkout"]')).toHaveCount(0);
    await expect(page.locator('a,button', { hasText: /결제|바로\s*구매/i })).toHaveCount(0);

    await page.goto('/product.html?id=p1');
    await expect(page.getByTestId('product-detail')).toBeVisible();
    await expect(page.locator('[data-testid*="checkout"]')).toHaveCount(0);
    await expect(page.locator('a,button', { hasText: /결제|바로\s*구매/i })).toHaveCount(0);

    // 결제 진입점(checkout-link)은 장바구니 화면에만 존재한다
    await page.goto('/cart.html');
    await expect(page.getByTestId('checkout-link')).toHaveCount(1);
  });
});

test.describe('수량 기반 자동 할인 (PRD 12.1~12.13, 14.2~14.5)', () => {
  test('9개는 할인이 적용되지 않고 할인 관련 요소가 DOM에 아예 없다 (12.1/12.2/12.10/14.4)', async () => {
    await seed(page, 'p1', 9);

    await page.goto('/cart.html');
    const line = page.locator('[data-testid="cart-item"][data-product-id="p1"]');
    await expect(line.getByTestId('cart-item-quantity')).toHaveText('9');

    // 판정 근거는 금액이 아니라 서버의 discountApplied와 요소의 존재 여부다
    const cart = await serverCart(page);
    expect(cart.items[0].discountApplied).toBe(false);
    expect(cart.items[0].discountPercent).toBe(0);
    expect(cart.items[0].discountedUnitPrice).toBe(cart.items[0].price);

    // 흐리게 숨긴 게 아니라 DOM에 존재하지 않아야 한다
    await expect(page.getByTestId('cart-item-discounted-price')).toHaveCount(0);
    await expect(page.getByTestId('cart-item-discount-notice')).toHaveCount(0);

    await expectTotalsMatchServer(page);
  });

  test('9개 → 10개로 올리면 그 줄에 할인 표시가 나타난다 — 금액은 그대로여도 (12.2/12.7/12.9/14.2/14.3)', async () => {
    await seed(page, 'p1', 9);

    await page.goto('/cart.html');
    const line = page.locator('[data-testid="cart-item"][data-product-id="p1"]');
    await expect(line.getByTestId('cart-item-quantity')).toHaveText('9');

    // ⚠ 함정: price 19,000원에서 9개와 10개의 줄 합계가 둘 다 171,000원이다.
    //   금액으로 단언하면 경계가 한 칸 밀린 구현(> 10)이 조용히 통과한다.
    const totalAt9 = await line.getByTestId('cart-item-total').textContent();

    await line.getByTestId('cart-item-increase').click();
    await expect(line.getByTestId('cart-item-quantity')).toHaveText('10');

    const cart = await serverCart(page);
    expect(cart.items[0].discountApplied).toBe(true);
    expect(cart.items[0].discountPercent).toBe(10);
    expect(cart.items[0].discountedUnitPrice).toBe(17100);
    expect(cart.items[0].lineSubtotal).toBe(190000);
    expect(cart.items[0].lineTotal).toBe(171000);

    // 할인 판정의 근거 — 요소가 "생겼는가"
    await expect(line.getByTestId('cart-item-discounted-price')).toHaveCount(1);
    await expect(line.getByTestId('cart-item-discounted-price')).toHaveText(
      formatPrice(cart.items[0].discountedUnitPrice)
    );
    await expect(line.getByTestId('cart-item-discount-notice')).toHaveCount(1);
    await expect(line.getByTestId('cart-item-discount-notice')).toHaveText(
      `10개 이상 ${cart.items[0].discountPercent}% 할인 적용`
    );

    // 원래 단가 자리는 할인이 걸려도 계속 원가다 (PRD 10.10 / 14.6)
    await expect(line.getByTestId('cart-item-price')).toHaveText(formatPrice(cart.items[0].price));
    // 원가에 취소선이 실제로 보이는지 (표시 요구사항 12.9-1).
    // ⚠ 이건 "표시가 되는가"의 보조 확인일 뿐, 할인 여부의 판정 근거가 아니다 —
    //   판정은 위의 cart-item-discounted-price 존재 여부로 한다 (PRD 14.5).
    await expect(line.getByTestId('cart-item-price')).toHaveCSS(
      'text-decoration-line',
      'line-through'
    );
    // 줄 합계 자리에는 할인 후 금액 하나만 — 할인 전 190,000원은 화면 어디에도 없다 (12.12)
    await expect(line.getByTestId('cart-item-total')).toHaveText(formatPrice(cart.items[0].lineTotal));
    await expect(page.locator('body')).not.toContainText('190,000');

    // 함정 확인: 금액은 9개일 때와 똑같은데 할인 표시만 뒤집혔다
    expect(await line.getByTestId('cart-item-total').textContent()).toBe(totalAt9);

    await expectTotalsMatchServer(page);
  });

  test('10개 → 9개로 내리면 할인 표시가 DOM에서 사라진다 (12.7/12.10)', async () => {
    await seed(page, 'p1', 10);

    await page.goto('/cart.html');
    const line = page.locator('[data-testid="cart-item"][data-product-id="p1"]');
    await expect(line.getByTestId('cart-item-quantity')).toHaveText('10');
    await expect(page.getByTestId('cart-item-discounted-price')).toHaveCount(1);

    await line.getByTestId('cart-item-decrease').click();
    await expect(line.getByTestId('cart-item-quantity')).toHaveText('9');

    await expect(page.getByTestId('cart-item-discounted-price')).toHaveCount(0);
    await expect(page.getByTestId('cart-item-discount-notice')).toHaveCount(0);
    // 취소선도 함께 사라진다 (보조 확인 — 판정 근거는 위의 요소 개수다)
    await expect(line.getByTestId('cart-item-price')).toHaveCSS('text-decoration-line', 'none');

    const cart = await serverCart(page);
    expect(cart.items[0].discountApplied).toBe(false);
    await expectTotalsMatchServer(page);
  });

  test('할인은 줄마다 따로 판정한다 — 6개 + 5개(합 11개)는 어느 줄도 할인되지 않는다 (12.4/12.5)', async () => {
    await seed(page, 'p1', 6);
    await seed(page, 'p7', 5);

    await page.goto('/cart.html');
    await expect(page.getByTestId('cart-item')).toHaveCount(2);

    const cart = await serverCart(page);
    expect(cart.totalQuantity).toBe(11); // 합계는 11이지만
    for (const item of cart.items) {
      expect(item.discountApplied).toBe(false); // 어느 줄도 할인되지 않는다
      expect(item.discountAmount).toBe(0);
      expect(item.lineTotal).toBe(item.lineSubtotal);
    }

    // 할인 요소는 장바구니 전체에서 0개여야 한다
    await expect(page.getByTestId('cart-item-discounted-price')).toHaveCount(0);
    await expect(page.getByTestId('cart-item-discount-notice')).toHaveCount(0);

    await expectTotalsMatchServer(page);
  });

  test('한 줄만 10개면 그 줄만 할인되고 다른 줄은 정가다 (12.4/12.6)', async () => {
    await seed(page, 'p1', 10);
    await seed(page, 'p7', 1);

    await page.goto('/cart.html');
    await expect(page.getByTestId('cart-item')).toHaveCount(2);

    const cart = await serverCart(page);
    const discounted = cart.items.find((i) => i.productId === 'p1');
    const regular = cart.items.find((i) => i.productId === 'p7');
    expect(discounted.discountApplied).toBe(true);
    expect(regular.discountApplied).toBe(false);
    expect(cart.totalPrice).toBe(discounted.lineTotal + regular.lineTotal);

    // 할인 요소 개수 = 할인된 줄 수(1)와 정확히 같아야 한다
    await expect(page.getByTestId('cart-item-discounted-price')).toHaveCount(1);
    await expect(page.getByTestId('cart-item-discount-notice')).toHaveCount(1);

    const discountedLine = page.locator('[data-testid="cart-item"][data-product-id="p1"]');
    const regularLine = page.locator('[data-testid="cart-item"][data-product-id="p7"]');
    await expect(discountedLine.getByTestId('cart-item-discounted-price')).toHaveCount(1);
    await expect(regularLine.getByTestId('cart-item-discounted-price')).toHaveCount(0);
    await expect(regularLine.getByTestId('cart-item-discount-notice')).toHaveCount(0);

    await expectTotalsMatchServer(page);
  });

  test('상세 화면에서 나눠 담아 10개가 되어도 장바구니에서는 할인 줄로 보인다 (12.8)', async () => {
    await page.goto('/product.html?id=p1');
    await expect(page.getByTestId('product-detail')).toBeVisible();

    await page.getByTestId('quantity-input').fill('6');
    await page.getByTestId('quantity-input').blur();
    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('cart-count')).toHaveText('6');

    await page.getByTestId('quantity-input').fill('4');
    await page.getByTestId('quantity-input').blur();
    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('cart-count')).toHaveText('10');

    // 상세 화면에는 할인 UI가 없다 (12.14 / D15)
    await expect(page.getByTestId('cart-item-discounted-price')).toHaveCount(0);
    await expect(page.getByTestId('cart-item-discount-notice')).toHaveCount(0);

    await page.goto('/cart.html');
    const cart = await serverCart(page);
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].quantity).toBe(10);
    expect(cart.items[0].discountApplied).toBe(true);

    await expect(page.getByTestId('cart-item-discounted-price')).toHaveCount(1);
    await expect(page.getByTestId('cart-item-discount-notice')).toHaveCount(1);
    await expectTotalsMatchServer(page);
  });
});
