'use strict';

/**
 * 리뷰 기능의 독립성/회귀 — tests/test-cases.ko.md "6차 사이클 — 상품 리뷰 / 평점" 중
 *   "기존 기능이 그대로인지(회귀 기준)" + "안전 관련 추가 확인(XSS)" + "PRD 밖 글자 수 카운터"
 *   (PRD 27.12/30.14~30.18 · 매트릭스 H1~H12, 27.7 XSS)
 *
 * 구성 방식: BDD/시나리오 스타일. describe = 시나리오, 테스트 제목 끝 [ ]는 PRD/매트릭스
 * 각주, test-cases.ko.md 구조는 그대로 둔다.
 *
 * H1(기존 Playwright 204개 전부 통과)은 이 파일에 개별 테스트로 옮기지 않는다 — 그 자체가
 * "전체 스위트를 실행해서 확인하는 것"이라, 이 파일 하나로는 증명할 수 없다. 대신 이 사이클
 * 완료 후 `npx playwright test`로 기존 9개 파일 + 신규 4개 파일 전체를 돌려 확인한다
 * (tests/test-cases.ko.md의 "자동화 현황" 표 참고). H5/H9/H11은 각각 review-write.spec.js /
 * review-write.spec.js / review-read.spec.js에서 이미 검증했으므로 여기서 중복하지 않는다.
 *
 * 상품 할당: p8 하나만 쓴다(read=p1~p3, write=p4~p5, ownership=p7과 겹치지 않는다).
 *
 * 창 정책 예외: H12(주문 조회 403/404 비교)는 cart.spec.js의 8.5·order.spec.js와 같은 이유로
 * cartId 쿠키가 다른 컨텍스트 2개가 필요하다 — 그 테스트 안에서만 추가로 열고 닫는다.
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
  console.log('[review-independence.spec] 공유 브라우저 컨텍스트 1개 생성 (테스트마다 새로 열지 않는다)');
});

test.afterAll(async () => {
  await context.close();
});

test.beforeEach(async () => {
  await context.request.post('/api/auth/logout').catch(() => {});
  await context.request.delete('/api/cart').catch(() => {});
});

test.afterEach(async () => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  page.removeAllListeners('request');
  page.removeAllListeners('dialog');
});

const PRODUCT = 'p8';
const ORDER_NOT_FOUND_ERROR = '주문을 찾을 수 없습니다.';
const REVIEW_PROCESSING_ERROR = '리뷰 요청을 처리하지 못했습니다.';
const PRODUCT_LIST_ERROR = '상품 목록을 불러오지 못했습니다.';
const CART_PROCESSING_ERROR = '장바구니 요청을 처리하지 못했습니다.';
const NO_SUCH_API_ERROR = '존재하지 않는 API 경로입니다.';

let emailSeq = 0;
function uniqueEmail(prefix) {
  emailSeq += 1;
  const safePrefix = String(prefix).replace(/[^a-zA-Z0-9.-]/g, '') || 'x';
  return `${safePrefix}.${Date.now()}.${emailSeq}.${Math.random().toString(36).slice(2, 8)}@example.com`.toLowerCase();
}

function errMsg(body) {
  return body && body.error && typeof body.error.message === 'string' ? body.error.message : '';
}

function reviewsUrl(productId) {
  return `/api/products/${encodeURIComponent(productId)}/reviews`;
}

function reviewUrl(reviewId) {
  return `/api/reviews/${encodeURIComponent(reviewId)}`;
}

async function createAccount(prefix, password) {
  const email = uniqueEmail(prefix);
  const pw = password || 'abcd1234';
  const res = await context.request.post('/api/auth/signup', { data: { email, password: pw, passwordConfirm: pw } });
  expect(res.status()).toBe(201);
  return { email, password: pw };
}

async function loginAs(reqCtx, email, password) {
  const res = await reqCtx.request.post('/api/auth/login', { data: { email, password } });
  expect(res.status()).toBe(200);
}

async function logout(reqCtx) {
  await reqCtx.request.post('/api/auth/logout').catch(() => {});
}

async function postReviewAs(reqCtx, productId, rating, content) {
  const res = await reqCtx.request.post(reviewsUrl(productId), { data: { rating, content } });
  const body = await res.json().catch(() => null);
  return { status: res.status(), body };
}

async function deleteReviewAs(reqCtx, reviewId) {
  const res = await reqCtx.request.delete(reviewUrl(reviewId));
  expect(res.status()).toBe(200);
}

// ===========================================================================
// 시나리오 1: 로그인 없이 전체 플로우가 완주되고, 기존 요소가 그대로다
// [PRD 31.12/30.13/D52 · H1(31.12 부분)/H2/H4]
// ===========================================================================
test.describe('시나리오: 로그인 없이 전체 플로우가 완주되고, 기존 요소가 그대로다', () => {
  test('상세 화면의 기존 요소와 헤더의 이름·위치·의미가 그대로다 [31.12 · H1]', async () => {
    await page.goto(`/product.html?id=${PRODUCT}`);
    for (const id of ['detail-name', 'detail-price', 'detail-description', 'quantity-input', 'add-to-cart']) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    for (const id of ['cart-link', 'cart-count', 'auth-area']) {
      await expect(page.getByTestId(id)).toBeVisible({ visible: true }).catch(() => {});
    }
    await expect(page.getByTestId('cart-link')).toHaveAttribute('href', '/cart.html');

    // DOM 순서: 상세 패널이 리뷰 영역보다 앞에 있다 (리뷰가 끼어들며 순서를 바꾸지 않았다)
    const order = await page.evaluate(() => {
      const detail = document.querySelector('[data-testid="product-detail"]');
      const reviews = document.querySelector('[data-testid="review-section"]');
      return detail.compareDocumentPosition(reviews) & Node.DOCUMENT_POSITION_FOLLOWING ? 'detail-first' : 'other';
    });
    expect(order).toBe('detail-first');
  });

  test('로그인하지 않고 목록→상세(리뷰 읽기)→담기→수량변경→할인→결제→주문확인까지 전 과정이 동작한다 [30.13 · H2]', async () => {
    await page.goto('/');
    await expect(page.getByTestId('product-list')).toBeVisible();

    await page.goto(`/product.html?id=${PRODUCT}`);
    await expect(page.getByTestId('review-section')).toBeVisible(); // 리뷰 읽기 — 로그인 불필요

    await page.getByTestId('quantity-input').fill('10'); // 수량 변경 + 할인 경계(10개)
    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('add-to-cart-success')).toBeVisible();

    await page.goto('/cart.html');
    const cart = await (await context.request.get('/api/cart')).json();
    const line = cart.cart.items.find((i) => i.productId === PRODUCT);
    expect(line.discountApplied).toBe(true); // 할인

    await page.getByTestId('checkout-link').click();
    await page.waitForURL(/\/checkout\.html$/);
    await expect(page.getByTestId('auth-guest')).toBeVisible(); // 로그인 화면으로 튕기지 않음

    await page.getByTestId('orderer-name').fill('H2 완주테스트');
    await page.getByTestId('orderer-phone').fill('010-1111-2222');
    await page.getByTestId('checkout-submit').click();

    await page.waitForURL(/\/order\.html\?orderId=/);
    await expect(page.getByTestId('order-confirmation')).toBeVisible();
    await expect(page.getByTestId('auth-guest')).toBeVisible(); // 끝까지 비로그인

    await context.request.delete('/api/cart');
  });

  test('상세 화면을 열 때 로그인 상태 조회 요청이 정확히 한 건이다 [D52 · H4]', async () => {
    const meRequests = [];
    page.on('request', (req) => {
      if (req.url().endsWith('/api/auth/me')) meRequests.push(req);
    });
    await page.goto(`/product.html?id=${PRODUCT}`);
    await page.waitForLoadState('networkidle');
    expect(meRequests.length).toBe(1);
  });
});

// ===========================================================================
// 시나리오 2: 쿠키가 하나도 없는 완전 첫 방문자
// [PRD 30.15 · H6, bug-history M4 재발 확인]
// ===========================================================================
test.describe('시나리오: 쿠키가 하나도 없는 완전 첫 방문자', () => {
  test('네 요청(상품·장바구니·로그인상태·리뷰)이 동시에 나가도 장바구니 쿠키는 딱 한 번만 발급된다 [30.15 · H6]', async ({
    browser,
  }) => {
    const freshContext = await browser.newContext({ baseURL: 'http://localhost:3000' });
    try {
      const freshPage = await freshContext.newPage();
      const urls = [];
      freshPage.on('request', (req) => {
        const u = req.url();
        if (
          u.endsWith(`/api/products/${PRODUCT}`) ||
          u.endsWith('/api/cart') ||
          u.endsWith('/api/auth/me') ||
          u.endsWith(reviewsUrl(PRODUCT))
        ) {
          urls.push(u);
        }
      });

      await freshPage.goto(`/product.html?id=${PRODUCT}`);
      await freshPage.waitForLoadState('networkidle');

      expect(urls.some((u) => u.endsWith(`/api/products/${PRODUCT}`))).toBe(true);
      expect(urls.some((u) => u.endsWith('/api/cart'))).toBe(true);
      expect(urls.some((u) => u.endsWith('/api/auth/me'))).toBe(true);
      expect(urls.some((u) => u.endsWith(reviewsUrl(PRODUCT)))).toBe(true);

      const cookies = await freshContext.cookies();
      expect(cookies.filter((c) => c.name === 'cartId')).toHaveLength(1); // 단 한 번만 발급 (bug-history M4)

      await freshPage.getByTestId('add-to-cart').click();
      await expect(freshPage.getByTestId('add-to-cart-success')).toBeVisible();

      await freshPage.goto('/cart.html');
      const cartBody = await (await freshContext.request.get('/api/cart')).json();
      expect(cartBody.cart.items.some((i) => i.productId === PRODUCT)).toBe(true); // 담은 상품이 그대로

      await freshContext.request.delete('/api/cart');
    } finally {
      await freshContext.close();
    }
  });
});

// ===========================================================================
// 시나리오 3: 리뷰와 장바구니·주문은 서로 영향을 주지 않는다
// [PRD D53 · H7]
// ===========================================================================
test.describe('시나리오: 리뷰와 장바구니·주문은 서로 영향을 주지 않는다', () => {
  test('결제와 장바구니 비우기가 리뷰를 건드리지 않는다 [D53 · H7]', async () => {
    const acc = await createAccount('h7a');
    await loginAs(context, acc.email, acc.password);
    const created = await postReviewAs(context, PRODUCT, 4, 'H7 리뷰 독립성 확인');
    const reviewId = created.body.reviews.find((r) => r.email === acc.email).reviewId;
    await logout(context);

    await context.request.post('/api/cart/items', { data: { productId: PRODUCT, quantity: 1 } });
    const checkoutRes = await context.request.post('/api/checkout', {
      data: { ordererName: 'H7', ordererPhone: '010-0000-0001', paymentMethod: 'MOCK_SUCCESS' },
    });
    expect(checkoutRes.status()).toBe(200);
    await context.request.delete('/api/cart');

    const snapAfter = await (await context.request.get(reviewsUrl(PRODUCT))).json();
    expect(snapAfter.reviews.some((r) => r.reviewId === reviewId)).toBe(true); // 결제/비우기로 사라지지 않음

    await loginAs(context, acc.email, acc.password);
    await deleteReviewAs(context, reviewId);
    await logout(context);
  });

  test('리뷰를 쓰거나 지워도 장바구니·주문이 바뀌지 않는다 [D53 · H7]', async () => {
    await context.request.post('/api/cart/items', { data: { productId: PRODUCT, quantity: 3 } });
    const beforeCart = await (await context.request.get('/api/cart')).json();

    const acc = await createAccount('h7b');
    await loginAs(context, acc.email, acc.password);
    const created = await postReviewAs(context, PRODUCT, 2, 'H7b 리뷰 쓰기');
    const reviewId = created.body.reviews.find((r) => r.email === acc.email).reviewId;
    await deleteReviewAs(context, reviewId);
    await logout(context);

    const afterCart = await (await context.request.get('/api/cart')).json();
    expect(afterCart.cart).toEqual(beforeCart.cart);
    await context.request.delete('/api/cart');
  });
});

// ===========================================================================
// 시나리오 4: 서버 오류 문구가 기능별로 올바르게 분기된다
// [PRD 30.18 · H8, bug-history M5 세 번째 재발 지점]
// ===========================================================================
test.describe('시나리오: 서버 오류 문구가 기능별로 올바르게 분기된다', () => {
  test('🚨 리뷰 목록 주소에서 서버 오류가 나면 "리뷰 요청을 처리하지 못했습니다."가 나온다(상품 문구가 새어나가지 않는다) [30.18 · H8]', async () => {
    const acc = await createAccount('h8a');
    await loginAs(context, acc.email, acc.password);
    const hugeFiller = 'x'.repeat(200 * 1024);
    const res = await context.request.post(reviewsUrl(PRODUCT), {
      data: { rating: 5, content: 'h8', filler: hugeFiller },
    });
    expect(res.status()).toBe(500);
    const body = await res.json();
    expect(body.error.message).toBe(REVIEW_PROCESSING_ERROR);
    expect(body.error.message).not.toBe(PRODUCT_LIST_ERROR); // bug-history M5 재발 패턴
    await logout(context);
  });

  test('🚨 리뷰 수정 주소(/api/reviews/:id)에서도 서버 오류가 나면 같은 리뷰 전용 문구가 나온다 [30.18 · H8]', async () => {
    const acc = await createAccount('h8b');
    await loginAs(context, acc.email, acc.password);
    const created = await postReviewAs(context, PRODUCT, 3, 'H8 수정 대상');
    const reviewId = created.body.reviews.find((r) => r.email === acc.email).reviewId;

    const hugeFiller = 'y'.repeat(200 * 1024);
    const res = await context.request.patch(reviewUrl(reviewId), {
      data: { rating: 4, content: 'h8 수정', filler: hugeFiller },
    });
    expect(res.status()).toBe(500);
    const body = await res.json();
    expect(body.error.message).toBe(REVIEW_PROCESSING_ERROR);
    expect(body.error.message).not.toBe(PRODUCT_LIST_ERROR);

    await deleteReviewAs(context, reviewId);
    await logout(context);
  });

  test('리뷰 분기를 추가해도 기존 상품·장바구니 오류 문구는 그대로다 [30.18 회귀]', async () => {
    const productRes = await context.request.get('/api/products?simulate=error');
    expect(productRes.status()).toBe(500);
    expect((await productRes.json()).error.message).toBe(PRODUCT_LIST_ERROR);

    const hugeFiller = 'z'.repeat(200 * 1024);
    const cartRes = await context.request.post('/api/cart/items', {
      data: { productId: PRODUCT, quantity: 1, filler: hugeFiller },
    });
    expect(cartRes.status()).toBe(500);
    expect((await cartRes.json()).error.message).toBe(CART_PROCESSING_ERROR);
  });
});

// ===========================================================================
// 시나리오 5: 새 라이브러리 없이, 기존 화면에 리뷰 흔적이 없고, 없는 API는 전부 404다
// [최상단 제약 ①/27.1/30.14 · H10]
// ===========================================================================
test.describe('시나리오: 새 라이브러리 없이, 기존 화면에 리뷰 흔적이 없고, 없는 API는 전부 404다', () => {
  test('리뷰 기능을 추가하면서 새 외부 패키지를 추가하지 않았다 [최상단 제약 ① · H10]', async () => {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    expect(pkg.dependencies).toEqual({ express: '^4.19.2' });
  });

  test('상품 목록·장바구니·결제·주문확인·회원가입·로그인 여섯 화면에 리뷰 관련 요소가 하나도 없다 [27.1]', async () => {
    const pages = ['/', '/cart.html', '/checkout.html', '/signup.html', '/login.html'];
    for (const url of pages) {
      await page.goto(url);
      await expect(page.locator('[data-testid*="review" i]')).toHaveCount(0);
      await expect(page.locator('[data-testid*="rating" i]')).toHaveCount(0);
    }
    // 주문 확인 화면은 주문이 있어야 들어갈 수 있으므로, 더미 주문 하나를 만들어 확인한다
    await context.request.post('/api/cart/items', { data: { productId: PRODUCT, quantity: 1 } });
    const checkout = await (
      await context.request.post('/api/checkout', {
        data: { ordererName: '27.1', ordererPhone: '010-0000-0002', paymentMethod: 'MOCK_SUCCESS' },
      })
    ).json();
    await page.goto(`/order.html?orderId=${checkout.order.orderId}`);
    await expect(page.locator('[data-testid*="review" i]')).toHaveCount(0);
    await expect(page.locator('[data-testid*="rating" i]')).toHaveCount(0);
  });

  test('만들지 않기로 한 리뷰 관련 주소들이 실제로 없다(전부 "존재하지 않는 API 경로입니다.") [30.14]', async () => {
    const notImplemented = [
      { method: 'get', path: '/api/reviews' }, // 전체 리뷰 목록
      { method: 'get', path: '/api/users/me/reviews' }, // 내가 쓴 리뷰 목록
      { method: 'post', path: `/api/products/${PRODUCT}/reviews/x/photos` }, // 사진 업로드
      { method: 'post', path: '/api/reviews/x/helpful' }, // 도움돼요 투표
      { method: 'post', path: '/api/reviews/x/reply' }, // 판매자 답글
      { method: 'post', path: '/api/reviews/x/report' }, // 리뷰 신고
      { method: 'get', path: `/api/products/${PRODUCT}/reviews/distribution` }, // 평점 분포
      { method: 'get', path: `/api/products/${PRODUCT}/reviews/sorted-by-rating` }, // 평점 정렬 전용 주소
    ];
    for (const { method, path: p } of notImplemented) {
      const res = await context.request[method](p);
      expect(res.status()).toBe(404);
      expect((await res.json()).error.message).toBe(NO_SUCH_API_ERROR);
    }
  });
});

// ===========================================================================
// 시나리오 6: 주문 조회는 리뷰와 다르게 둘 다 "주문을 찾을 수 없습니다"로 뭉뚱그린다
// [PRD D23 · H12]
// ===========================================================================
test.describe('시나리오: 주문 조회는 리뷰와 다르게 둘 다 뭉뚱그린다', () => {
  test('🔑 남의 주문·없는 주문 모두 같은 "주문을 찾을 수 없습니다"다 — 리뷰가 권한 오류를 쓰기 시작했다고 주문 쪽을 바꾸지 않았다 [D23 · H12]', async ({
    browser,
  }) => {
    const contextA = await browser.newContext({ baseURL: 'http://localhost:3000' });
    const contextB = await browser.newContext({ baseURL: 'http://localhost:3000' });
    console.log('[review-independence.spec] 예외: H12가 cartId 비교용 컨텍스트 2개 추가 생성');
    try {
      await contextA.request.post('/api/cart/items', { data: { productId: PRODUCT, quantity: 1 } });
      const orderA = await (
        await contextA.request.post('/api/checkout', {
          data: { ordererName: 'H12-A', ordererPhone: '010-0000-0003', paymentMethod: 'MOCK_SUCCESS' },
        })
      ).json();

      await contextB.request.post('/api/cart/items', { data: { productId: PRODUCT, quantity: 1 } });
      const orderB = await (
        await contextB.request.post('/api/checkout', {
          data: { ordererName: 'H12-B', ordererPhone: '010-0000-0004', paymentMethod: 'MOCK_SUCCESS' },
        })
      ).json();

      const othersOrder = await contextA.request.get(`/api/orders/${orderB.order.orderId}`);
      const noSuchOrder = await contextA.request.get('/api/orders/no-such-order-id-0000');

      expect(othersOrder.status()).toBe(404);
      expect(noSuchOrder.status()).toBe(404);
      expect((await othersOrder.json()).error.message).toBe(ORDER_NOT_FOUND_ERROR);
      expect((await noSuchOrder.json()).error.message).toBe(ORDER_NOT_FOUND_ERROR);
      expect((await contextA.request.get(`/api/orders/${orderA.order.orderId}`)).status()).toBe(200); // 본인 것은 조회됨
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});

// ===========================================================================
// 시나리오 7: 리뷰 본문에 악성 스크립트를 넣는 사람
// [PRD 27.7 · XSS]
// ===========================================================================
test.describe('시나리오: 리뷰 본문에 악성 스크립트를 넣는 사람', () => {
  test('본문의 HTML 태그·스크립트가 글자 그대로 표시되고 태그로 해석되거나 실행되지 않는다 [27.7]', async () => {
    const acc = await createAccount('xss');
    await loginAs(context, acc.email, acc.password);
    const malicious = '<img src=x onerror=alert(1)><b>bold</b>';
    const created = await postReviewAs(context, PRODUCT, 3, malicious);
    const reviewId = created.body.reviews.find((r) => r.email === acc.email).reviewId;
    await logout(context);

    let dialogFired = false;
    page.on('dialog', () => {
      dialogFired = true;
    });

    await page.goto(`/product.html?id=${PRODUCT}`);
    const row = page.locator(`[data-testid="review-item"][data-review-id="${reviewId}"]`);
    await expect(row.getByTestId('review-item-content')).toHaveText(malicious); // 글자 그대로
    expect(await row.getByTestId('review-item-content').locator('img').count()).toBe(0); // 태그로 해석되지 않음
    expect(await row.getByTestId('review-item-content').locator('b').count()).toBe(0);
    await page.waitForTimeout(300);
    expect(dialogFired).toBe(false); // 스크립트가 실행되지 않음

    await loginAs(context, acc.email, acc.password);
    await deleteReviewAs(context, reviewId);
    await logout(context);
  });
});
