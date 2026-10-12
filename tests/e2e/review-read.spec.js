'use strict';

/**
 * 리뷰 조회 화면/API — tests/test-cases.ko.md "6차 사이클 — 상품 리뷰 / 평점" 중
 *   "리뷰 조회 — 로그인하지 않아도 읽을 수 있다" ~ "리뷰 조회가 실패해도 상품 상세 화면은
 *   멀쩡하다" (PRD 27장 / 30.2~30.5 · 매트릭스 E1~E14, H3, G2, H11)
 *
 * 구성 방식: BDD/시나리오 스타일 (auth-signup.spec.js 머릿말 참고). describe = 시나리오,
 * 테스트 제목 끝 [ ]는 PRD/매트릭스 각주, test-cases.ko.md 구조는 그대로 둔다.
 *
 * 제외 (test-cases.ko.md "6차 자동화 계획"에서 합의):
 *   - E15(서버를 재시작해 리뷰를 비우는 것) — 실행 중인 서버를 재시작하면 같은 실행 안의
 *     다른 테스트/계정/세션이 전부 날아간다(5차 C7과 같은 이유). 대신 이 파일의 모든 테스트가
 *     "자기가 만든 리뷰를 끝에 직접 지워서 0개로 복귀"하는 방식으로 같은 효과를 낸다.
 *
 * 상품 할당(리뷰는 서버 메모리 누적형이라 파일끼리 상품이 겹치면 병렬 실행 시 서로 오염된다):
 *   p1 = EMPTY_PRODUCT  — 이 파일에서 절대 리뷰를 쓰지 않는다. "0개 상태" 전용 기준 상품.
 *   p2 = SCRATCH        — 쓰고 측정하고 지우는 일반 작업용 상품.
 *   p3 = SECOND         — 상품 간 분리(E9)·화면 단건 확인용 두 번째 상품.
 * (write/ownership/independence 파일은 각각 p4~p6 / p7 / p8을 쓴다 — 서로 겹치지 않는다.)
 *
 * 규칙 (skills/shopping-mall-qa/SKILL.md): data-testid 선택자만 사용, 파일당 창 하나 공유,
 * 404(G8류 "없음")과 달리 여기선 전부 읽기 경로라 403 전용 임시 컨텍스트가 필요 없다 —
 * 단 E6(가짜 쿠키)는 "진짜 쿠키"를 건드리지 않기 위해 전용 임시 컨텍스트를 쓴다
 * (auth-login.spec.js B12의 "옛 쿠키" 격리와 같은 이유).
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
  console.log('[review-read.spec] 공유 브라우저 컨텍스트 1개 생성 (테스트마다 새로 열지 않는다)');
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

const EMPTY_PRODUCT = 'p1';
const SCRATCH = 'p2';
const SECOND = 'p3';

const PRODUCT_NOT_FOUND_ERROR = '상품을 찾을 수 없습니다.';

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

/** 현재 로그인된 사용자로 리뷰를 작성한다. */
async function postReviewAs(reqCtx, productId, rating, content) {
  const res = await reqCtx.request.post(reviewsUrl(productId), { data: { rating, content } });
  const body = await res.json().catch(() => null);
  return { status: res.status(), body };
}

/** 현재 로그인된 사용자로 reviewId를 삭제한다(정리용 — 반드시 본인 계정으로 로그인한 뒤 호출한다). */
async function deleteReviewAs(reqCtx, reviewId) {
  const res = await reqCtx.request.delete(reviewUrl(reviewId));
  expect(res.status()).toBe(200);
}

// ===========================================================================
// 시나리오 1: 로그인하지 않고 리뷰를 읽는 방문자
// [PRD 30.5/D40/D51 · E1/E2/E4/E14]
// ===========================================================================
test.describe('시나리오: 로그인하지 않고 리뷰를 읽는 방문자', () => {
  test('리뷰가 하나도 없는 상품을 조회하면 "없다(404)"가 아니라 "비어있다(200)"로 응답한다 [30.5 · E1]', async () => {
    const res = await context.request.get(reviewsUrl(EMPTY_PRODUCT));
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.reviews).toEqual([]);
    expect(body.averageRating).toBeNull();
    expect(body.reviewCount).toBe(0);
  });

  test('🔑 쿠키가 전혀 없는 상태에서 같은 주소로 읽기는 성공(200)하고 쓰기는 거절(401)된다 [D40 · E2]', async () => {
    const getRes = await context.request.get(reviewsUrl(SCRATCH));
    expect(getRes.status()).toBe(200);

    const postRes = await context.request.post(reviewsUrl(SCRATCH), { data: { rating: 5, content: 'E2 쓰기 시도' } });
    expect(postRes.status()).toBe(401);

    // 쓰기가 거절됐으므로 아무것도 생성되지 않았어야 한다 — 주소 단위로 막혔다면 읽기도 막혔을 것이다.
    const after = await (await context.request.get(reviewsUrl(SCRATCH))).json();
    expect(after.reviewCount).toBe(0);
  });

  test('존재하지 않는 상품의 리뷰를 조회하면 "상품을 찾을 수 없습니다."로 거절된다 [30.5 · E4]', async () => {
    const res = await context.request.get(reviewsUrl('no-such-product-xyz'));
    expect(res.status()).toBe(404);
    expect(errMsg(await res.json())).toBe(PRODUCT_NOT_FOUND_ERROR);
  });

  test('정렬·페이지 번호 같은 쿼리 조건을 붙여도 전부 무시하고 최신순 전체를 그대로 돌려준다 [D51 · E14]', async () => {
    const a = await createAccount('e14a');
    const b = await createAccount('e14b');

    await loginAs(context, a.email, a.password);
    const r1 = await postReviewAs(context, SCRATCH, 2, 'E14 쿼리 무시 확인 A');
    await logout(context);

    await loginAs(context, b.email, b.password);
    const r2 = await postReviewAs(context, SCRATCH, 4, 'E14 쿼리 무시 확인 B');
    await logout(context);

    const plain = await (await context.request.get(reviewsUrl(SCRATCH))).json();
    const withQuery = await (
      await context.request.get(`${reviewsUrl(SCRATCH)}?sort=rating&page=2&limit=1&rating=5`)
    ).json();
    expect(withQuery).toEqual(plain);
    expect(plain.reviewCount).toBe(2);

    await loginAs(context, a.email, a.password);
    await deleteReviewAs(context, r1.body.reviews.find((r) => r.email === a.email).reviewId);
    await logout(context);
    await loginAs(context, b.email, b.password);
    await deleteReviewAs(context, r2.body.reviews.find((r) => r.email === b.email).reviewId);
    await logout(context);
  });
});

// ===========================================================================
// 시나리오 2: 응답에 무엇이 들어있는지, 평균이 정확한지 확인하는 QA
// [PRD 30.2~30.4/D47~D51 · E5/E7/E8/E9/E10/H3]
// ===========================================================================
test.describe('시나리오: 응답 shape과 평균 평점 계산을 확인하는 QA', () => {
  test('응답의 바깥 껍데기는 정확히 3가지, 리뷰 한 줄은 정확히 7가지 필드다 [30.2 · E5]', async () => {
    const acc = await createAccount('e5');
    await loginAs(context, acc.email, acc.password);
    const created = await postReviewAs(context, SCRATCH, 3, 'E5 응답 모양 확인');
    expect(created.status).toBe(201);

    expect(Object.keys(created.body).sort()).toEqual(['averageRating', 'reviewCount', 'reviews']);
    expect(Object.keys(created.body.reviews[0]).sort()).toEqual(
      ['content', 'createdAt', 'email', 'isMine', 'productId', 'rating', 'reviewId'].sort(),
    );
    // "수정 시각"·"별명"·"도움돼요 수" 같은 항목이 없다
    expect(created.body.reviews[0]).not.toHaveProperty('updatedAt');
    expect(created.body.reviews[0]).not.toHaveProperty('nickname');
    expect(created.body.reviews[0]).not.toHaveProperty('helpfulCount');

    await deleteReviewAs(context, created.body.reviews[0].reviewId);
    await logout(context);
  });

  test('🔑 리뷰가 0개일 때 평균 평점은 "없음"(null)이고 리뷰 개수는 0이다 — 둘의 규칙이 반대다 [D50 · E7]', async () => {
    const res = await context.request.get(reviewsUrl(EMPTY_PRODUCT));
    const body = await res.json();
    expect(body.averageRating).toBeNull();
    expect(body.reviewCount).toBe(0);
  });

  test('평균 평점 계산이 정확하다: 5→5, 5·4→4.5, 5·4·4→4.3, 1·2→1.5, 3·4·4·5→4 [30.4 · E8]', async () => {
    const pool = [];
    for (let i = 0; i < 4; i += 1) pool.push(await createAccount(`e8-${i}`));

    const scenarios = [
      { ratings: [5], expected: 5 },
      { ratings: [5, 4], expected: 4.5 },
      { ratings: [5, 4, 4], expected: 4.3 },
      { ratings: [1, 2], expected: 1.5 },
      { ratings: [3, 4, 4, 5], expected: 4 },
    ];

    for (const { ratings, expected } of scenarios) {
      const createdIds = [];
      for (let i = 0; i < ratings.length; i += 1) {
        await loginAs(context, pool[i].email, pool[i].password);
        const res = await postReviewAs(context, SCRATCH, ratings[i], `E8 ${ratings.join('-')} #${i}`);
        createdIds.push(res.body.reviews.find((r) => r.email === pool[i].email).reviewId);
        await logout(context);
      }

      const snap = await (await context.request.get(reviewsUrl(SCRATCH))).json();
      expect(snap.averageRating).toBe(expected);
      expect(typeof snap.averageRating).toBe('number');

      for (let i = 0; i < ratings.length; i += 1) {
        await loginAs(context, pool[i].email, pool[i].password);
        await deleteReviewAs(context, createdIds[i]);
        await logout(context);
      }
    }

    const after = await (await context.request.get(reviewsUrl(SCRATCH))).json();
    expect(after.reviewCount).toBe(0);
  });

  test('다른 상품의 리뷰가 섞이지 않는다 — 개수·평균이 각자 자기 상품 것으로만 계산된다 [30.4 · E9]', async () => {
    const a1 = await createAccount('e9a1');
    const a2 = await createAccount('e9a2');
    const b1 = await createAccount('e9b1');

    await loginAs(context, a1.email, a1.password);
    const r1 = await postReviewAs(context, SCRATCH, 5, 'E9 상품A 리뷰1');
    await logout(context);
    await loginAs(context, a2.email, a2.password);
    const r2 = await postReviewAs(context, SCRATCH, 3, 'E9 상품A 리뷰2');
    await logout(context);
    await loginAs(context, b1.email, b1.password);
    const r3 = await postReviewAs(context, SECOND, 1, 'E9 상품B 리뷰1');
    await logout(context);

    const snapA = await (await context.request.get(reviewsUrl(SCRATCH))).json();
    const snapB = await (await context.request.get(reviewsUrl(SECOND))).json();
    expect(snapA.reviewCount).toBe(2);
    expect(snapA.averageRating).toBe(4);
    expect(snapB.reviewCount).toBe(1);
    expect(snapB.averageRating).toBe(1);
    expect(snapA.reviews.every((r) => r.productId === SCRATCH)).toBe(true);
    expect(snapB.reviews.every((r) => r.productId === SECOND)).toBe(true);

    await loginAs(context, a1.email, a1.password);
    await deleteReviewAs(context, r1.body.reviews.find((r) => r.email === a1.email).reviewId);
    await logout(context);
    await loginAs(context, a2.email, a2.password);
    await deleteReviewAs(context, r2.body.reviews.find((r) => r.email === a2.email).reviewId);
    await logout(context);
    await loginAs(context, b1.email, b1.password);
    await deleteReviewAs(context, r3.body.reviews.find((r) => r.email === b1.email).reviewId);
    await logout(context);
  });

  test('목록은 최근에 쓴 것이 맨 위이고, 화면도 서버가 준 순서를 그대로 그린다(다시 정렬하지 않는다) [D51 · E10]', async () => {
    const accs = [await createAccount('e10a'), await createAccount('e10b'), await createAccount('e10c')];
    const ids = [];
    for (let i = 0; i < accs.length; i += 1) {
      await loginAs(context, accs[i].email, accs[i].password);
      const res = await postReviewAs(context, SCRATCH, (i % 5) + 1, `E10 순서 확인 ${i}`);
      ids.push(res.body.reviews.find((r) => r.email === accs[i].email).reviewId);
      await logout(context);
    }

    const snap = await (await context.request.get(reviewsUrl(SCRATCH))).json();
    expect(snap.reviews[0].reviewId).toBe(ids[2]);
    expect(snap.reviews[1].reviewId).toBe(ids[1]);
    expect(snap.reviews[2].reviewId).toBe(ids[0]);

    await page.goto(`/product.html?id=${SCRATCH}`);
    // 전체 스위트를 동시에 돌리면(서버가 느려지는 상황) 목록이 아직 로딩 중인 순간을 읽는 레이스가
    // 있다 — review-list가 보일 때까지 기다려 "조회 완료" 동기화 지점을 둔다 (cart.spec.js의
    // cart-loading과 같은 패턴, test-cases.ko.md 5차 섹션 참고).
    await expect(page.getByTestId('review-list')).toBeVisible();
    const domOrder = await page
      .getByTestId('review-item')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-review-id')));
    expect(domOrder.slice(0, 3)).toEqual([ids[2], ids[1], ids[0]]);

    for (let i = 0; i < accs.length; i += 1) {
      await loginAs(context, accs[i].email, accs[i].password);
      await deleteReviewAs(context, ids[i]);
      await logout(context);
    }
  });

  test('🔑 상품 정보 응답에는 평점이 들어가지 않는다 — 목록·상세 모두 5개 필드뿐이고 리뷰를 쓴 뒤에도 그대로다 [D47 · H3]', async () => {
    const acc = await createAccount('h3');
    await loginAs(context, acc.email, acc.password);
    const created = await postReviewAs(context, SCRATCH, 5, 'H3 평점 누출 확인');
    await logout(context);

    const listBody = await (await context.request.get('/api/products')).json();
    const item = listBody.items.find((p) => p.id === SCRATCH);
    expect(Object.keys(item).sort()).toEqual(['description', 'id', 'imageUrl', 'name', 'price']);

    const detailBody = await (await context.request.get(`/api/products/${SCRATCH}`)).json();
    expect(Object.keys(detailBody.item).sort()).toEqual(['description', 'id', 'imageUrl', 'name', 'price']);

    await page.goto('/');
    const card = page.locator(`[data-testid="product-card"][data-product-id="${SCRATCH}"]`);
    await expect(card.locator('[data-testid*="rating" i]')).toHaveCount(0);
    await expect(card.locator('[data-testid*="review" i]')).toHaveCount(0);

    await loginAs(context, acc.email, acc.password);
    await deleteReviewAs(context, created.body.reviews.find((r) => r.email === acc.email).reviewId);
    await logout(context);
  });
});

// ===========================================================================
// 시나리오 3: 세션이 있을 때/없을 때 "내 리뷰 여부"가 달라지는지 확인하는 QA
// [PRD 30.3/D36 · E6/G2, 28.2/29.1 코드 점검]
// ===========================================================================
test.describe('시나리오: 세션 유무에 따라 "내 리뷰 여부"가 달라지는지 확인하는 QA', () => {
  test('존재하지 않는 가짜 로그인 쿠키로 조회해도 거절되지 않고 성공하며, 모든 줄이 "내 리뷰 아님"이고 가짜 쿠키를 지우라는 헤더가 온다 [30.3 · E6]', async ({
    browser,
  }) => {
    const owner = await createAccount('e6');
    await loginAs(context, owner.email, owner.password);
    const created = await postReviewAs(context, SCRATCH, 5, 'E6 가짜 쿠키 확인용');
    await logout(context);

    const probe = await browser.newContext({ baseURL: 'http://localhost:3000' });
    try {
      await probe.addCookies([{ name: 'sessionId', value: 'bogus-session-value-e6', domain: 'localhost', path: '/' }]);
      const res = await probe.request.get(reviewsUrl(SCRATCH));
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.reviews.length).toBeGreaterThan(0);
      expect(body.reviews.every((r) => r.isMine === false)).toBe(true);

      const setCookies = res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
      expect(setCookies.some((h) => h.value.startsWith('sessionId=') && h.value.includes('Max-Age=0'))).toBe(true);
    } finally {
      await probe.close();
    }

    await loginAs(context, owner.email, owner.password);
    await deleteReviewAs(context, created.body.reviews.find((r) => r.email === owner.email).reviewId);
    await logout(context);
  });

  test('🔑 같은 리뷰가 보는 사람에 따라 다르게 보인다: 본인=내 리뷰, 다른 계정=내 리뷰 아님, 비로그인=내 리뷰 아님 [D50 · G2]', async () => {
    const author = await createAccount('g2author');
    const other = await createAccount('g2other');

    await loginAs(context, author.email, author.password);
    const created = await postReviewAs(context, SCRATCH, 4, 'G2 시점별 확인용');
    const reviewId = created.body.reviews.find((r) => r.email === author.email).reviewId;

    const asAuthor = await (await context.request.get(reviewsUrl(SCRATCH))).json();
    expect(asAuthor.reviews.find((r) => r.reviewId === reviewId).isMine).toBe(true);
    await logout(context);

    const asGuest = await (await context.request.get(reviewsUrl(SCRATCH))).json();
    const guestLine = asGuest.reviews.find((r) => r.reviewId === reviewId);
    expect(guestLine.isMine).toBe(false);
    expect(typeof guestLine.isMine).toBe('boolean');

    await loginAs(context, other.email, other.password);
    const asOther = await (await context.request.get(reviewsUrl(SCRATCH))).json();
    expect(asOther.reviews.find((r) => r.reviewId === reviewId).isMine).toBe(false);
    await logout(context);

    await loginAs(context, author.email, author.password);
    await deleteReviewAs(context, reviewId);
    await logout(context);
  });

  test('화면 코드는 작성자 이메일을 직접 비교하지 않고, 서버가 준 isMine 값만으로 수정·삭제 버튼을 그린다 [28.2/29.1]', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'product.js'), 'utf8');
    expect(src).toMatch(/review\.isMine/);
    expect(src).not.toMatch(/email\s*===/);
    expect(src).not.toMatch(/email\s*!==/);
  });
});

// ===========================================================================
// 시나리오 4: 로그인하지 않은 방문자가 상품 상세에 들어왔을 때
// [PRD 28.3/28.11/27.7/D41/D44 · E3, G15, D44]
// ===========================================================================
test.describe('시나리오: 로그인하지 않은 방문자가 상품 상세에 들어왔을 때', () => {
  test('리뷰 목록과 평균 평점은 그대로 보이고, 가려지는 것은 작성 폼 하나뿐이다 [D41 · E3]', async () => {
    await page.goto(`/product.html?id=${EMPTY_PRODUCT}`);
    await expect(page.getByTestId('review-section')).toBeVisible();
    await expect(page.getByTestId('review-summary')).toBeVisible();
    await expect(page.getByTestId('review-form')).toBeHidden();
    await expect(page.getByTestId('review-login-notice')).toBeVisible();
  });

  test('작성 폼 자리에 "로그인 후 작성할 수 있습니다." 안내가 보이고, 꼬리표 없는 /login.html 링크가 있다 [28.3 · E3]', async () => {
    await page.goto(`/product.html?id=${EMPTY_PRODUCT}`);
    await expect(page.getByTestId('review-login-notice')).toContainText('로그인 후 작성할 수 있습니다.');
    await expect(page.getByTestId('review-login-link')).toHaveAttribute('href', '/login.html');
  });

  test('로그인 화면으로 자동 이동하지 않고, 알림창·팝업·모달이 뜨지 않는다 [D41 · E3]', async () => {
    let dialogFired = false;
    page.on('dialog', () => {
      dialogFired = true;
    });
    await page.goto(`/product.html?id=${EMPTY_PRODUCT}`);
    await page.waitForTimeout(300);
    expect(dialogFired).toBe(false);
    await expect(page).toHaveURL(new RegExp(`/product\\.html\\?id=${EMPTY_PRODUCT}$`));
  });

  test('작성 폼과 로그인 안내는 동시에 보이지 않는다 [28.11 · E3]', async () => {
    await page.goto(`/product.html?id=${EMPTY_PRODUCT}`);
    const formVisible = await page.getByTestId('review-form').isVisible();
    const noticeVisible = await page.getByTestId('review-login-notice').isVisible();
    expect(formVisible && noticeVisible).toBe(false);
  });

  test('로그인하지 않은 상태에서는 어떤 리뷰 줄에도 수정·삭제 버튼이 화면 구조에 아예 만들어지지 않는다 [29.11 · G15]', async () => {
    const acc = await createAccount('e3g15');
    await loginAs(context, acc.email, acc.password);
    const created = await postReviewAs(context, SECOND, 3, 'G15 게스트 확인용');
    await logout(context);

    await page.goto(`/product.html?id=${SECOND}`);
    await expect(page.getByTestId('review-item-edit')).toHaveCount(0);
    await expect(page.getByTestId('review-item-delete')).toHaveCount(0);

    await loginAs(context, acc.email, acc.password);
    await deleteReviewAs(context, created.body.reviews.find((r) => r.email === acc.email).reviewId);
    await logout(context);
  });

  test('작성자 이메일은 가리지 않고 전체가 보이며, 평점은 숫자 글자로, 작성 시각은 datetime 속성으로 들어있다 [27.7]', async () => {
    const acc = await createAccount('e3277');
    await loginAs(context, acc.email, acc.password);
    const created = await postReviewAs(context, SECOND, 4, '27.7 마스킹 미적용 확인');
    await logout(context);

    await page.goto(`/product.html?id=${SECOND}`);
    const row = page.getByTestId('review-item').first();
    await expect(row.getByTestId('review-item-email')).toHaveText(acc.email);
    await expect(row.getByTestId('review-item-rating')).toHaveText('4');
    await expect(row.getByTestId('review-item-date')).toHaveAttribute('datetime', /.+/);

    await loginAs(context, acc.email, acc.password);
    await deleteReviewAs(context, created.body.reviews.find((r) => r.email === acc.email).reviewId);
    await logout(context);
  });

  test('리뷰 식별자는 화면에 글자로 표시되지 않고 줄의 내부 속성으로만 쓰인다 [27.7 · D44]', async () => {
    const acc = await createAccount('e3d44');
    await loginAs(context, acc.email, acc.password);
    const created = await postReviewAs(context, SECOND, 2, 'D44 reviewId 비노출 확인');
    const reviewId = created.body.reviews.find((r) => r.email === acc.email).reviewId;
    await logout(context);

    await page.goto(`/product.html?id=${SECOND}`);
    const row = page.locator(`[data-testid="review-item"][data-review-id="${reviewId}"]`);
    await expect(row).toHaveCount(1);
    const text = await row.innerText();
    expect(text).not.toContain(reviewId);

    await loginAs(context, acc.email, acc.password);
    await deleteReviewAs(context, reviewId);
    await logout(context);
  });
});

// ===========================================================================
// 시나리오 5: 리뷰가 0개일 때 / 상세 화면의 다른 상태일 때
// [PRD 27.2/27.4/27.5/27.8/27.10/28.11 · E11/E13]
// ===========================================================================
test.describe('시나리오: 리뷰가 0개일 때 / 상세 화면의 다른 상태일 때', () => {
  test('리뷰가 0개면 "아직 작성된 리뷰가 없습니다" 안내가 보이고 목록 자리는 보이지 않는다 [27.8]', async () => {
    await page.goto(`/product.html?id=${EMPTY_PRODUCT}`);
    await expect(page.getByTestId('review-empty')).toBeVisible();
    await expect(page.getByTestId('review-empty')).toContainText('아직 작성된 리뷰가 없습니다');
    await expect(page.getByTestId('review-list')).toBeHidden();
  });

  test('평균 평점 자리는 사라지지 않고 "아직 평점이 없습니다"로 바뀐다 — 0/0.0/-/빈칸이면 버그다 [27.4 · E11]', async () => {
    await page.goto(`/product.html?id=${EMPTY_PRODUCT}`);
    await expect(page.getByTestId('review-average')).toBeVisible();
    const text = (await page.getByTestId('review-average').textContent()).trim();
    expect(text).toBe('아직 평점이 없습니다');
    expect(['0', '0.0', '-', '']).not.toContain(text);
  });

  test('리뷰 개수 자리에는 0이 그대로 표시된다(평균과 달리 숨기지 않는다) [27.5]', async () => {
    await page.goto(`/product.html?id=${EMPTY_PRODUCT}`);
    await expect(page.getByTestId('review-count')).toHaveText('0');
    await expect(page.getByTestId('review-count')).toBeVisible();
  });

  test('🔑 리뷰가 0개여도 작성 영역은 그대로 보인다 — 로그인 상태면 폼, 아니면 로그인 안내 [27.8/28.11]', async () => {
    await page.goto(`/product.html?id=${EMPTY_PRODUCT}`);
    await expect(page.getByTestId('review-login-notice')).toBeVisible();

    const acc = await createAccount('emptywrite');
    await loginAs(context, acc.email, acc.password);
    await page.reload();
    await expect(page.getByTestId('review-form')).toBeVisible();
    await logout(context);
  });

  test('리뷰 영역 안의 네 상태(불러오는 중/목록/빈 안내/에러)는 한 번에 하나만 보인다 — 느리게 불러오면 로딩만 보이고 요약도 숨겨진다 [27.10]', async () => {
    await page.route('**/api/products/*/reviews', async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.continue();
    });
    await page.goto(`/product.html?id=${EMPTY_PRODUCT}`);
    await expect(page.getByTestId('review-loading')).toBeVisible();
    await expect(page.getByTestId('review-summary')).toBeHidden();
    await expect(page.getByTestId('review-list')).toBeHidden();
    await expect(page.getByTestId('review-empty')).toBeHidden();
    await expect(page.getByTestId('review-error')).toBeHidden();
    await expect(page.getByTestId('review-loading')).toBeHidden({ timeout: 5000 });
    await page.unroute('**/api/products/*/reviews');
  });

  test('존재하지 않는 상품 주소로 들어가면 "상품을 찾을 수 없습니다" 화면이 뜨고 리뷰 영역 전체가 숨겨진다 [27.2 · E13]', async () => {
    await page.goto('/product.html?id=no-such-product-e13');
    await expect(page.getByTestId('detail-not-found')).toBeVisible();
    await expect(page.getByTestId('review-section')).toBeHidden();
    // ⚠ 참고: 27.3이 상품 조회와 리뷰 조회의 병렬 호출을 허용하므로 요청 자체는 한 건 나갈 수 있다.
    // 이 케이스에서는 "영역이 숨겨진다"만 확인하고 요청 개수는 단언하지 않는다 (QA 리포트 6차 M12).
  });

  test('상품 번호가 아예 없거나 빈 값인 주소로 들어가면 리뷰 조회 요청 자체가 나가지 않는다 [27.2]', async () => {
    const reviewRequests = [];
    page.on('request', (req) => {
      if (/\/api\/products\/.*\/reviews/.test(req.url())) reviewRequests.push(req.url());
    });
    await page.goto('/product.html');
    await page.waitForTimeout(300);
    await page.goto('/product.html?id=');
    await page.waitForTimeout(300);
    expect(reviewRequests).toEqual([]);
  });
});

// ===========================================================================
// 시나리오 6: 리뷰 조회가 실패해도 상품 상세 화면은 멀쩡하다
// [PRD 27.9/27.10 · E12, H11]
//
// frontend-agent가 "직접 재현하지 못했다"고 남긴 케이스다. page.route()로 리뷰 조회
// 요청만 500으로 가로채 재현한다 — `**/api/products/*/reviews` 패턴으로 좁혀야 하며
// `**/api/products/**`를 전부 막으면 상품 조회까지 죽어서 이 케이스가 성립하지 않는다.
// ===========================================================================
test.describe('시나리오: 리뷰 조회가 실패해도 상품 상세 화면은 멀쩡하다', () => {
  test('리뷰 조회만 500으로 실패시키면 리뷰 영역 안에만 에러가 뜨고, 상품 상세 본문은 정상이다 [27.9 · E12]', async () => {
    await page.route('**/api/products/*/reviews', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '리뷰 요청을 처리하지 못했습니다.' } }),
      }),
    );
    await page.goto(`/product.html?id=${SECOND}`);

    await expect(page.getByTestId('product-detail')).toBeVisible();
    await expect(page.getByTestId('detail-name')).not.toBeEmpty();
    await expect(page.getByTestId('detail-price')).not.toBeEmpty();
    await expect(page.getByTestId('detail-description')).toBeVisible();

    await expect(page.getByTestId('review-section')).toBeVisible();
    await expect(page.getByTestId('review-error')).toBeVisible();
    await expect(page.getByTestId('review-error')).toHaveText('리뷰 요청을 처리하지 못했습니다.');
    await expect(page.getByTestId('review-loading')).toBeHidden();
    await expect(page.getByTestId('review-list')).toBeHidden();
    await expect(page.getByTestId('review-empty')).toBeHidden();

    await page.unroute('**/api/products/*/reviews');
  });

  test('리뷰 조회가 실패해도 장바구니 담기가 정상 동작한다 — 성공 안내와 배지 갱신까지 확인한다 [27.9 · E12]', async () => {
    await page.route('**/api/products/*/reviews', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '리뷰 요청을 처리하지 못했습니다.' } }),
      }),
    );
    await context.request.delete('/api/cart');
    await page.goto(`/product.html?id=${SECOND}`);

    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('add-to-cart-success')).toBeVisible();
    await expect(page.getByTestId('cart-count')).toHaveText('1');

    await page.unroute('**/api/products/*/reviews');
    await context.request.delete('/api/cart');
  });

  test('리뷰 조회가 계속 실패하는 상태에서도 상세→담기→장바구니→결제→주문 확인까지 끝까지 완주한다 [27.9 · H11]', async () => {
    await page.route('**/api/products/*/reviews', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '리뷰 요청을 처리하지 못했습니다.' } }),
      }),
    );
    await context.request.delete('/api/cart');

    await page.goto(`/product.html?id=${SECOND}`);
    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('add-to-cart-success')).toBeVisible();

    await page.goto('/cart.html');
    await expect(page.getByTestId('cart-summary')).toBeVisible();
    await page.getByTestId('checkout-link').click();

    await page.waitForURL(/\/checkout\.html$/);
    await page.getByTestId('orderer-name').fill('리뷰실패완주테스트');
    await page.getByTestId('orderer-phone').fill('010-0000-0000');
    await page.getByTestId('checkout-submit').click();

    await page.waitForURL(/\/order\.html\?orderId=/);
    await expect(page.getByTestId('order-confirmation')).toBeVisible();

    await page.unroute('**/api/products/*/reviews');
    await context.request.delete('/api/cart');
  });
});
