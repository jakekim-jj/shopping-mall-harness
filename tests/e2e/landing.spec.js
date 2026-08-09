'use strict';

/**
 * 상품 목록(홈) 화면 — tests/test-cases.ko.md "1차 사이클" 전 항목
 *
 * 커버 범위
 *   - 목록 표시    : PRD 1.1 ~ 1.5
 *   - 카드 클릭    : PRD 5.1 ~ 5.5 (헤더 공통 요소 포함)
 *   - 상태 처리    : PRD 2.1 ~ 2.4
 *
 * 규칙 (skills/shopping-mall-qa/SKILL.md)
 *   - 선택자는 data-testid만 쓴다. CSS 클래스·텍스트로 요소를 찾지 않는다.
 *     예외는 링크의 href뿐이다 — href 값 자체가 PRD 5.1이 정한 계약이기 때문이다.
 *   - "DOM에 있는지"(toHaveCount)와 "지금 보이는지"(toBeVisible)를 구분해 단언한다
 *     (bug-history M2 — 빈/에러 상태에서 product-list는 DOM에 남고 hidden만 된다).
 *   - spec 파일 하나당 브라우저 컨텍스트(창)는 하나다. 아래 beforeAll에서 한 번만 만든다.
 */
const { test, expect } = require('@playwright/test');

// ── 파일 전체가 창 하나를 공유한다 (SKILL.md "자동화 테스트 작성 규칙") ──────────────
// Playwright 기본값은 테스트마다 새 컨텍스트를 여는 것이라, --headed로 보면 이 파일에서만
// 창이 10번 열리고 닫힌다. mode:'default'는 config의 fullyParallel을 이 파일에 한해 끄고
// 선언 순서대로 한 워커에서 돌게 한다 — 공유 page가 성립하려면 모든 테스트가 같은 워커에
// 있어야 하기 때문이다. (serial이 아니라 default를 쓴 이유: 한 테스트가 실패해도 나머지가
// skip되지 않고 계속 돌아야 회귀 테스트로서 값이 있다.)
test.describe.configure({ mode: 'default' });

/** 이 파일의 모든 테스트가 재사용하는 컨텍스트/페이지. beforeAll에서 딱 한 번만 만든다. */
let context;
let page;
let defaultViewport;

test.beforeAll(async ({ browser, baseURL, viewport }) => {
  // browser.newContext()는 config의 use 옵션을 자동으로 물려받지 않으므로 명시적으로 넘긴다
  context = await browser.newContext({ baseURL, viewport });
  page = await context.newPage();
  defaultViewport = viewport;
  console.log('[landing.spec] 공유 브라우저 컨텍스트 1개 생성 (테스트마다 새로 열지 않는다)');
});

test.afterAll(async () => {
  await context.close();
});

// 창을 공유해도 테스트 사이에 데이터가 섞이면 안 된다 — 항상 빈 장바구니에서 시작한다.
// (이 화면은 장바구니에 담지 않지만, 수량 배지 5.4/5.5 단언이 "비어 있음"을 전제한다.)
test.beforeEach(async () => {
  const res = await context.request.delete('/api/cart');
  expect(res.status()).toBe(200);
});

// 컨텍스트가 살아남는 만큼 route·listener·viewport도 살아남는다. 매 테스트 뒤에 되돌린다.
// (예: 1.4의 이미지 abort 라우트, 1.5의 375px 뷰포트가 다음 테스트로 새는 것을 막는다.)
test.afterEach(async () => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  page.removeAllListeners('request');
  page.removeAllListeners('dialog');
  await page.setViewportSize(defaultViewport);
});

/** 원 단위 정수 → "19,000원" (PRD 1.3). Node ICU에 의존하지 않도록 직접 만든다. */
function formatPrice(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원';
}

/** 목록 화면의 4개 상태 컨테이너 중 정확히 하나만 보이는지 단언한다 (PRD 2.4). */
async function expectOnlyState(page, expected) {
  const ids = ['loading-state', 'empty-state', 'error-state', 'product-list'];
  const visible = [];
  for (const id of ids) {
    if (await page.getByTestId(id).isVisible()) {
      visible.push(id);
    }
  }
  expect(visible).toEqual([expected]);
}

test.describe('상품 목록 화면 — 목록 표시 (PRD 1.1~1.5)', () => {
  test('시드 상품 8개가 카드로 표시되고 이미지·이름·가격이 서버 값과 일치한다 (1.1/1.2/1.3)', async ({ request }) => {
    const body = await (await request.get('/api/products')).json();
    const items = body.items;
    expect(items.length).toBe(8); // PRD 3.5 — 시드 6개 이상, 현재 8개

    await page.goto('/');
    const cards = page.getByTestId('product-card');
    await expect(cards).toHaveCount(8);

    for (const item of items) {
      const card = page.locator(`[data-testid="product-card"][data-product-id="${item.id}"]`);
      await expect(card).toHaveCount(1);
      await expect(card.getByTestId('product-name')).toHaveText(item.name);
      await expect(card.getByTestId('product-price')).toHaveText(formatPrice(item.price));
      // 가격은 천 단위 콤마 + 소수점 없음 (PRD 1.3)
      await expect(card.getByTestId('product-price')).toHaveText(/^\d{1,3}(,\d{3})*원$/);
      await expect(card.getByTestId('product-image')).toHaveAttribute('src', item.imageUrl);
    }

    await expectOnlyState(page, 'product-list');
  });

  test('이미지 로드가 전부 실패해도 카드 높이가 정상 로드 때와 같다 (1.4)', async () => {
    // 1) 정상 로드에서 카드별 높이를 먼저 잰다.
    await page.goto('/');
    await expect(page.getByTestId('product-card')).toHaveCount(8);
    const normalHeights = await page
      .getByTestId('product-card')
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));

    // 2) 같은 화면을 이미지 요청만 전부 실패시킨 상태로 다시 연다.
    await page.route('**/images/*', (route) => route.abort());
    await page.goto('/');
    await expect(page.getByTestId('product-card')).toHaveCount(8);
    // 이미지 요소 자체는 DOM에 남아 있어야 한다 (대체 영역이 자리를 지킨다)
    await expect(page.getByTestId('product-image')).toHaveCount(8);

    const brokenHeights = await page
      .getByTestId('product-card')
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));

    expect(brokenHeights).toEqual(normalHeights);
    await expectOnlyState(page, 'product-list');
  });

  test('375px 모바일 폭에서 가로 스크롤이 생기지 않고 카드가 리스트 밖으로 삐져나오지 않는다 (1.5)', async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/');
    await expect(page.getByTestId('product-card')).toHaveCount(8);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBe(overflow.clientWidth);

    const outside = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="product-list"]');
      const listBox = list.getBoundingClientRect();
      return Array.from(document.querySelectorAll('[data-testid="product-card"]')).filter((card) => {
        const box = card.getBoundingClientRect();
        return box.left < listBox.left - 1 || box.right > listBox.right + 1;
      }).length;
    });
    expect(outside).toBe(0);
  });
});

test.describe('상품 목록 화면 — 카드 클릭과 공통 헤더 (PRD 5.1~5.5)', () => {
  test('카드는 실제 <a href="/product.html?id={id}"> 링크이고 클릭하면 상세로 이동한다 (5.1/5.3)', async ({ request }) => {
    const body = await (await request.get('/api/products')).json();

    await page.goto('/');
    await expect(page.getByTestId('product-card')).toHaveCount(8);

    for (const item of body.items) {
      const card = page.locator(`[data-testid="product-card"][data-product-id="${item.id}"]`);
      // JS onclick이 아니라 진짜 링크여야 한다 (새 탭·뒤로가기가 브라우저 기본 동작이어야 하므로)
      await expect(card.locator('a')).toHaveAttribute('href', `/product.html?id=${item.id}`);
      // 선택자 위치 불변 (PRD 5.3) — testid는 여전히 카드 요소와 그 내부에 있다
      await expect(card.getByTestId('product-name')).toHaveCount(1);
      await expect(card.getByTestId('product-price')).toHaveCount(1);
      await expect(card.getByTestId('product-image')).toHaveCount(1);
    }

    await page.locator('[data-testid="product-card"][data-product-id="p3"] a').click();
    await expect(page).toHaveURL(/\/product\.html\?id=p3$/);
    await expect(page.getByTestId('detail-name')).toBeVisible();
  });

  test('목록 카드에는 "장바구니 담기" 버튼이 없다 — 클릭 대상은 상세 링크 하나뿐 (5.2)', async () => {
    await page.goto('/');
    await expect(page.getByTestId('product-card')).toHaveCount(8);

    await expect(page.locator('[data-testid="product-list"] button')).toHaveCount(0);
    await expect(page.getByTestId('add-to-cart')).toHaveCount(0);
    // 카드 안의 클릭 가능한 요소는 상세 링크 8개가 전부다
    await expect(page.locator('[data-testid="product-list"] a')).toHaveCount(8);
  });

  test('헤더에 장바구니 링크가 있고, 비어 있으면 수량 배지는 DOM에 남되 보이지 않는다 (5.4/5.5)', async () => {
    await page.goto('/');

    await expect(page.getByTestId('cart-link')).toHaveCount(1);
    await expect(page.getByTestId('cart-link')).toBeVisible();
    await expect(page.getByTestId('cart-link')).toHaveAttribute('href', '/cart.html');

    // 요소는 존재(count 1)하지만 화면에는 보이지 않는다 — 두 가지를 나눠 단언한다 (bug-history M2)
    await expect(page.getByTestId('cart-count')).toHaveCount(1);
    await expect(page.getByTestId('cart-count')).toBeHidden();
  });
});

test.describe('상품 목록 화면 — 상태 처리 (PRD 2.1~2.4)', () => {
  test('응답을 기다리는 동안 로딩 상태만 보인다 (2.1/2.4)', async () => {
    await page.route('**/api/products', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });

    await page.goto('/', { waitUntil: 'commit' });
    await expectOnlyState(page, 'loading-state');
    // 로딩 스켈레톤에는 product-card testid가 없으므로 카드 수는 0이다
    await expect(page.getByTestId('product-card')).toHaveCount(0);
  });

  test('상품이 0개면 에러가 아니라 빈 상태만 보이고 카드는 0개다 (2.2/2.4)', async () => {
    // 고정 fixture가 아니라 실서버의 ?simulate=empty 응답을 그대로 쓴다 (QA 리포트 §1 재현 방식)
    await page.route('**/api/products', async (route) => {
      const response = await route.fetch({
        url: 'http://localhost:3000/api/products?simulate=empty',
      });
      await route.fulfill({ response });
    });

    await page.goto('/');
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await expect(page.getByTestId('product-card')).toHaveCount(0);
    await expectOnlyState(page, 'empty-state');
  });

  test('목록 API가 500이면 에러 상태만 보이고 화면이 백지가 되지 않는다 (2.3/2.4)', async () => {
    await page.route('**/api/products', async (route) => {
      const response = await route.fetch({
        url: 'http://localhost:3000/api/products?simulate=error',
      });
      await route.fulfill({ response });
    });

    await page.goto('/');
    await expect(page.getByTestId('error-state')).toBeVisible();
    await expect(page.getByTestId('product-card')).toHaveCount(0);
    await expectOnlyState(page, 'error-state');
    // 백지가 아니라 안내 문구가 실제로 렌더된다
    await expect(page.getByTestId('error-state')).not.toBeEmpty();
  });

  test('장바구니 조회가 실패해도 상품 목록은 정상 렌더되고 배지만 숨겨진다 (5.7)', async () => {
    await page.route('**/api/cart', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '장바구니 요청을 처리하지 못했습니다.' } }),
      })
    );

    await page.goto('/');
    await expect(page.getByTestId('product-card')).toHaveCount(8);
    await expectOnlyState(page, 'product-list');
    await expect(page.getByTestId('cart-count')).toBeHidden();
  });
});
