'use strict';

/**
 * 상품 상세 화면 — tests/test-cases.ko.md "2차 사이클 — 상품 상세 화면" 전 항목
 *
 * 커버 범위: PRD 6.1 ~ 6.12 (+ 10.3~10.7 선택자, 5.6 배지 갱신)
 *
 * 규칙 (skills/shopping-mall-qa/SKILL.md)
 *   - 선택자는 data-testid만. 예외는 "목록으로 돌아가는 링크"의 href뿐이다
 *     (PRD 6.11에 전용 testid가 없고, 링크의 목적지 자체가 요구사항이다).
 *   - 요청이 "가지 않았다"는 것은 화면 모양이 아니라 실제 요청 개수로 단언한다.
 *   - spec 파일 하나당 브라우저 컨텍스트(창)는 하나다. 아래 beforeAll에서 한 번만 만든다.
 */
const { test, expect } = require('@playwright/test');

// ── 파일 전체가 창 하나를 공유한다 (SKILL.md "자동화 테스트 작성 규칙") ──────────────
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
  console.log('[product-detail.spec] 공유 브라우저 컨텍스트 1개 생성 (테스트마다 새로 열지 않는다)');
});

test.afterAll(async () => {
  await context.close();
});

// ⚠ 창을 공유하면 cartId 쿠키도 공유된다 = 앞 테스트가 담은 상품이 그대로 남는다.
// 이 화면의 담기 테스트(6.4~6.7)는 전부 "빈 장바구니에서 시작"을 전제로 배지 숫자를
// 단언하므로(hidden → 2 → 5 → 99), 매 테스트 시작 전에 서버 장바구니를 비운다.
// 단언을 느슨하게 고치지 않고 격리를 복원하는 쪽을 택했다.
test.beforeEach(async () => {
  const res = await context.request.delete('/api/cart');
  expect(res.status()).toBe(200);
});

// route·listener도 컨텍스트와 함께 살아남는다 (예: 6.11이 건 /api/products/* 500 라우트가
// 남으면 뒤따르는 모든 테스트가 에러 상태가 된다). 매 테스트 뒤에 원상복구한다.
test.afterEach(async () => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  page.removeAllListeners('request');
  page.removeAllListeners('dialog');
});

function formatPrice(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원';
}

/** 상세 화면의 4개 상태 중 정확히 하나만 보이는지 단언한다 (PRD 6.10). */
async function expectOnlyState(page, expected) {
  const ids = ['detail-loading', 'product-detail', 'detail-not-found', 'detail-error'];
  const visible = [];
  for (const id of ids) {
    if (await page.getByTestId(id).isVisible()) {
      visible.push(id);
    }
  }
  expect(visible).toEqual([expected]);
}

test.describe('상품 상세 화면 — 표시 (PRD 6.1/6.2/6.10/6.11)', () => {
  test('이미지·이름·가격·설명 4가지가 모두 표시되고 가격 포맷이 목록과 같다 (6.1/6.2)', async ({ request }) => {
    const body = await (await request.get('/api/products/p1')).json();
    const item = body.item;

    await page.goto('/product.html?id=p1');

    await expect(page.getByTestId('product-detail')).toBeVisible();
    await expect(page.getByTestId('product-detail')).toHaveAttribute('data-product-id', 'p1');
    await expect(page.getByTestId('detail-name')).toHaveText(item.name);
    await expect(page.getByTestId('detail-price')).toHaveText(formatPrice(item.price));
    await expect(page.getByTestId('detail-price')).toHaveText(/^\d{1,3}(,\d{3})*원$/);
    await expect(page.getByTestId('detail-image')).toHaveAttribute('src', item.imageUrl);
    await expect(page.getByTestId('detail-description')).toHaveText(item.description);

    await expectOnlyState(page, 'product-detail');
  });

  test('정상·not-found·에러 어느 상태에서도 목록으로 돌아가는 링크가 있다 (6.11)', async () => {
    const backlink = page.locator('main a[href="/"]');

    await page.goto('/product.html?id=p1');
    await expect(page.getByTestId('product-detail')).toBeVisible();
    expect(await backlink.count()).toBeGreaterThan(0);
    await expect(backlink.first()).toBeVisible();

    await page.goto('/product.html?id=does-not-exist');
    await expect(page.getByTestId('detail-not-found')).toBeVisible();
    await expect(backlink.first()).toBeVisible();

    await page.route('**/api/products/*', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '상품 목록을 불러오지 못했습니다.' } }),
      })
    );
    await page.goto('/product.html?id=p1');
    await expect(page.getByTestId('detail-error')).toBeVisible();
    await expect(backlink.first()).toBeVisible();
    await expectOnlyState(page, 'detail-error');
  });

  test('상세 화면에는 결제/구매 버튼이 없다 (6.12)', async () => {
    await page.goto('/product.html?id=p1');
    await expect(page.getByTestId('product-detail')).toBeVisible();

    await expect(page.locator('button', { hasText: /결제|구매|주문|checkout/i })).toHaveCount(0);
    await expect(page.locator('a', { hasText: /결제|구매|주문|checkout/i })).toHaveCount(0);
    await expect(page.locator('[data-testid*="checkout"]')).toHaveCount(0);
    // 상세 화면의 버튼은 수량 −/+ 와 담기 3개가 전부다
    await expect(page.locator('[data-testid="product-detail"] button')).toHaveCount(3);
  });
});

test.describe('상품 상세 화면 — 수량 조절 (PRD 6.3)', () => {
  test('수량 1에서 감소를 눌러도 0/음수가 되지 않는다', async () => {
    await page.goto('/product.html?id=p1');
    await expect(page.getByTestId('product-detail')).toBeVisible();

    await expect(page.getByTestId('quantity-input')).toHaveValue('1');
    await expect(page.getByTestId('quantity-decrease')).toBeDisabled();

    await page.getByTestId('quantity-decrease').click({ force: true });
    await expect(page.getByTestId('quantity-input')).toHaveValue('1');

    // 증가는 정상 동작한다
    await page.getByTestId('quantity-increase').click();
    await expect(page.getByTestId('quantity-input')).toHaveValue('2');
    await expect(page.getByTestId('quantity-decrease')).toBeEnabled();
  });

  test('수량 99에서 증가를 눌러도 100이 되지 않고, 100 이상을 직접 입력하면 99로 잘린다', async () => {
    await page.goto('/product.html?id=p1');
    await expect(page.getByTestId('product-detail')).toBeVisible();

    await page.getByTestId('quantity-input').fill('150');
    await page.getByTestId('quantity-input').blur();
    await expect(page.getByTestId('quantity-input')).toHaveValue('99');
    await expect(page.getByTestId('quantity-increase')).toBeDisabled();

    await page.getByTestId('quantity-increase').click({ force: true });
    await expect(page.getByTestId('quantity-input')).toHaveValue('99');

    // 0이나 빈 값을 직접 넣어도 1로 복원된다
    await page.getByTestId('quantity-input').fill('0');
    await page.getByTestId('quantity-input').blur();
    await expect(page.getByTestId('quantity-input')).toHaveValue('1');
  });
});

test.describe('상품 상세 화면 — 장바구니 담기 (PRD 6.4~6.7)', () => {
  test('담기를 누르면 POST가 나가고 성공 안내·배지가 갱신되며 화면 이동은 없다 (6.4/6.5)', async () => {
    const posts = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/api/cart/items')) {
        posts.push(req.postDataJSON());
      }
    });

    await page.goto('/product.html?id=p3');
    await expect(page.getByTestId('product-detail')).toBeVisible();
    await expect(page.getByTestId('cart-count')).toBeHidden();

    await page.getByTestId('quantity-increase').click();
    await expect(page.getByTestId('quantity-input')).toHaveValue('2');
    await page.getByTestId('add-to-cart').click();

    await expect(page.getByTestId('add-to-cart-success')).toBeVisible();
    await expect(page.getByTestId('cart-count')).toBeVisible();
    await expect(page.getByTestId('cart-count')).toHaveText('2');

    expect(posts).toEqual([{ productId: 'p3', quantity: 2 }]);
    // 자동으로 장바구니 화면으로 이동하지 않는다 — 사용자는 상세에 머문다
    await expect(page).toHaveURL(/\/product\.html\?id=p3$/);
    await expect(page.getByTestId('product-detail')).toBeVisible();
  });

  test('같은 상품을 다시 담으면 새 줄이 생기지 않고 기존 줄의 수량에 합쳐진다 (6.6)', async () => {
    await page.goto('/product.html?id=p2');
    await expect(page.getByTestId('product-detail')).toBeVisible();

    await page.getByTestId('quantity-increase').click(); // 2개
    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('cart-count')).toHaveText('2');

    await page.getByTestId('quantity-input').fill('3');
    await page.getByTestId('quantity-input').blur();
    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('cart-count')).toHaveText('5');

    // 화면 값이 아니라 서버 상태로 확인한다 (같은 컨텍스트 = 같은 cartId 쿠키)
    const cart = (await (await page.context().request.get('/api/cart')).json()).cart;
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]).toMatchObject({ productId: 'p2', quantity: 5 });
    expect(cart.totalQuantity).toBe(5);
  });

  test('담기에 실패하면(99 상한 초과) 배지는 그대로이고 실패 안내가 뜬다 (6.7)', async () => {
    await page.goto('/product.html?id=p4');
    await expect(page.getByTestId('product-detail')).toBeVisible();

    await page.getByTestId('quantity-input').fill('99');
    await page.getByTestId('quantity-input').blur();
    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('cart-count')).toHaveText('99');

    // 99가 담긴 상태에서 1개 더 → 합산 100이므로 서버가 400으로 거절한다
    await page.getByTestId('quantity-input').fill('1');
    await page.getByTestId('quantity-input').blur();
    await page.getByTestId('add-to-cart').click();

    await expect(page.getByTestId('add-to-cart-error')).toBeVisible();
    await expect(page.getByTestId('add-to-cart-success')).toBeHidden();
    await expect(page.getByTestId('cart-count')).toHaveText('99'); // 담기지도 않았는데 늘면 안 된다

    const cart = (await (await page.context().request.get('/api/cart')).json()).cart;
    expect(cart.totalQuantity).toBe(99);
  });
});

test.describe('상품 상세 화면 — 찾을 수 없음 (PRD 6.8/6.9/6.10)', () => {
  test('존재하지 않는 id로 접속하면 not-found 상태만 보인다 (6.8/6.10)', async () => {
    await page.goto('/product.html?id=zzz-not-a-product');

    await expect(page.getByTestId('detail-not-found')).toBeVisible();
    await expectOnlyState(page, 'detail-not-found');
    await expect(page.locator('[data-testid="detail-not-found"] a[href="/"]')).toHaveCount(1);
  });

  test('id가 아예 없으면 상품 API를 호출하지 않고 바로 not-found가 된다 (6.9)', async () => {
    const productRequests = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/products')) {
        productRequests.push(req.method() + ' ' + req.url());
      }
    });

    await page.goto('/product.html');
    await expect(page.getByTestId('detail-not-found')).toBeVisible();
    await expectOnlyState(page, 'detail-not-found');

    // 화면이 not-found로 보인다는 것만으로는 부족하다 — 요청 자체가 0건이어야 한다
    await page.waitForTimeout(300);
    expect(productRequests).toEqual([]);
  });

  test('id가 빈 문자열이어도 상품 API를 호출하지 않는다 (6.9)', async () => {
    const productRequests = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/products')) {
        productRequests.push(req.url());
      }
    });

    await page.goto('/product.html?id=');
    await expect(page.getByTestId('detail-not-found')).toBeVisible();
    await page.waitForTimeout(300);
    expect(productRequests).toEqual([]);
  });
});
