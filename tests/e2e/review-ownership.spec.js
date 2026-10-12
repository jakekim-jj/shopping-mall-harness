'use strict';

/**
 * 리뷰 수정·삭제 화면/API — tests/test-cases.ko.md "6차 사이클 — 상품 리뷰 / 평점" 중
 *   "🔑 리뷰 수정·삭제 — 권한 경계" ~ "리뷰 수정·삭제가 실패했을 때"
 *   (PRD 29장 / 30.10~30.12 · 매트릭스 G1~G20)
 *
 * 구성 방식: BDD/시나리오 스타일. describe = 시나리오, 테스트 제목 끝 [ ]는 PRD/매트릭스
 * 각주, test-cases.ko.md 구조는 그대로 둔다.
 *
 * **이번 사이클에서 가장 중요한 묶음** — G7/G8/G9/G10이 중심이다. "없는 리뷰"(404)와
 * "남의 리뷰"(403)를 한 테스트에서 나란히 대조한다(D46) — 5차의 로그인 실패(두 응답이
 * 같아야 한다)와 정반대 방향의 확인이다.
 *
 * 상품 할당: p7 하나만 쓴다(이 파일 전용 — read/write/independence 파일과 겹치지 않는다).
 * 각 시나리오(describe) 경계에서 p7의 리뷰 개수가 0으로 복귀하도록 정리한다 — 서버가
 * 메모리에 리뷰를 누적하므로, 다음 describe가 "깨끗한 p7"을 가정하고 시작할 수 있어야 한다.
 *
 * 창 정책 예외 (SKILL.md, auth-login.spec.js의 C12와 같은 패턴): "권한 경계" 시나리오는
 * 공격자 역할이 필요하므로 공유 `page`/`context`와 별개로, API 전용 임시 컨텍스트 2개
 * (ownerCtx/attackerCtx)를 그 describe 안에서만 열고 끝나면 닫는다. 나머지 시나리오는
 * 전부 공유 `page`/`context` 하나로 진행한다.
 *
 * 연속 클릭 재현(G20/29.8): `click()`을 Playwright API로 두 번 호출하면 첫 클릭 직후
 * 버튼이 disabled로 바뀌어 두 번째 호출이 막힌다. `page.evaluate(() => { b.click(); b.click(); b.click(); })`로
 * 같은 틱에서 DOM의 click()을 직접 호출해야 한다 (review-write.spec.js F12와 같은 기법).
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'default' });

let context;
let page;

test.beforeAll(async ({ browser, baseURL, viewport }) => {
  context = await browser.newContext({ baseURL, viewport });
  page = await context.newPage();
  console.log('[review-ownership.spec] 공유 브라우저 컨텍스트 1개 생성 (테스트마다 새로 열지 않는다)');
});

test.afterAll(async () => {
  await context.close();
});

test.afterEach(async () => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  page.removeAllListeners('request');
  page.removeAllListeners('dialog');
});

const PRODUCT = 'p7';

const RATING_ERROR = '평점은 1 이상 5 이하의 정수로 입력해 주세요.';
const CONTENT_REQUIRED_ERROR = '리뷰 내용을 입력해 주세요.';
const REVIEW_NOT_FOUND_ERROR = '리뷰를 찾을 수 없습니다.';
const REVIEW_FORBIDDEN_ERROR = '본인이 작성한 리뷰만 수정하거나 삭제할 수 있습니다.';
const LOGIN_REQUIRED_ERROR = '로그인이 필요합니다.';

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

async function signup(reqCtx, prefix, password) {
  const email = uniqueEmail(prefix);
  const pw = password || 'abcd1234';
  const res = await reqCtx.post('/api/auth/signup', { data: { email, password: pw, passwordConfirm: pw } });
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

async function patchReviewRaw(reqCtx, reviewId, data) {
  const res = await reqCtx.request.patch(reviewUrl(reviewId), { data });
  const body = await res.json().catch(() => null);
  return { status: res.status(), body };
}

async function deleteReviewRaw(reqCtx, reviewId) {
  const res = await reqCtx.request.delete(reviewUrl(reviewId));
  const body = await res.json().catch(() => null);
  return { status: res.status(), body };
}

// ===========================================================================
// 시나리오 1: 권한 없는 사람이 남의 리뷰를 건드리려 한다
// [PRD 29.10/30.10/30.12/30.13/D46 · G7/G8/G9/G10/G13]
// ===========================================================================
test.describe('시나리오: 권한 없는 사람이 남의 리뷰를 건드리려 한다', () => {
  let ownerCtx;
  let attackerCtx;
  let owner;
  let attacker;
  let reviewId;
  let originalCreatedAt;

  test.beforeAll(async ({ browser }) => {
    ownerCtx = await browser.newContext({ baseURL: 'http://localhost:3000' });
    attackerCtx = await browser.newContext({ baseURL: 'http://localhost:3000' });
    console.log('[review-ownership.spec] 예외: 권한 경계 시나리오가 API 전용 컨텍스트 2개 추가 생성');

    owner = await signup(ownerCtx.request, 'g7owner');
    attacker = await signup(attackerCtx.request, 'g7attacker');

    await loginAs(ownerCtx, owner.email, owner.password);
    const created = await postReviewAs(ownerCtx, PRODUCT, 4, 'G7 권한 경계 기준 리뷰');
    reviewId = created.body.reviews.find((r) => r.email === owner.email).reviewId;
    originalCreatedAt = created.body.reviews.find((r) => r.email === owner.email).createdAt;

    await loginAs(attackerCtx, attacker.email, attacker.password);
  });

  test.afterAll(async () => {
    await loginAs(ownerCtx, owner.email, owner.password);
    await deleteReviewRaw(ownerCtx, reviewId).catch(() => {});
    await ownerCtx.close();
    await attackerCtx.close();
  });

  test('🚨 남의 리뷰를 수정·삭제하려 하면 서버가 막는다 — 수정과 삭제가 같은 문구를 쓴다 [29.10 · G7]', async () => {
    const patchRes = await patchReviewRaw(attackerCtx, reviewId, { rating: 1, content: '공격 시도 수정' });
    expect(patchRes.status).toBe(403);
    expect(errMsg(patchRes.body)).toBe(REVIEW_FORBIDDEN_ERROR);

    const deleteRes = await deleteReviewRaw(attackerCtx, reviewId);
    expect(deleteRes.status).toBe(403);
    expect(errMsg(deleteRes.body)).toBe(REVIEW_FORBIDDEN_ERROR);
    expect(errMsg(patchRes.body)).toBe(errMsg(deleteRes.body)); // 같은 문구
  });

  test('🔑🔑 "없는 리뷰"와 "남의 리뷰"를 한 테스트에서 나란히 대조한다 — 응답이 서로 달라야 한다 [D46 · G8]', async () => {
    const forbidden = await patchReviewRaw(attackerCtx, reviewId, { rating: 2, content: '남의 리뷰' });
    const notFound = await patchReviewRaw(attackerCtx, 'no-such-review-id-0000', { rating: 2, content: '없는 리뷰' });

    expect(forbidden.status).toBe(403);
    expect(notFound.status).toBe(404);
    expect(forbidden.status).not.toBe(notFound.status);
    expect(errMsg(forbidden.body)).toBe(REVIEW_FORBIDDEN_ERROR);
    expect(errMsg(notFound.body)).toBe(REVIEW_NOT_FOUND_ERROR);
    expect(errMsg(forbidden.body)).not.toBe(errMsg(notFound.body)); // 5차 로그인 실패(같아야 함)와 정반대 방향

    // 권한 오류 응답도 형태가 기존과 같다 — 안내 문구 하나만 들어있다 (30.17)
    expect(Object.keys(forbidden.body)).toEqual(['error']);
    expect(Object.keys(forbidden.body.error)).toEqual(['message']);
  });

  test('🔑 남의 리뷰에 잘못된 입력(평점 0점·빈 본문)으로 수정해도 입력 안내가 아니라 권한 없음으로 거절된다 [30.10 · G9]', async () => {
    const invalidRating = await patchReviewRaw(attackerCtx, reviewId, { rating: 0, content: '정상 본문' });
    expect(invalidRating.status).toBe(403);
    expect(errMsg(invalidRating.body)).toBe(REVIEW_FORBIDDEN_ERROR);
    expect(errMsg(invalidRating.body)).not.toBe(RATING_ERROR);

    const invalidContent = await patchReviewRaw(attackerCtx, reviewId, { rating: 3, content: '   ' });
    expect(invalidContent.status).toBe(403);
    expect(errMsg(invalidContent.body)).toBe(REVIEW_FORBIDDEN_ERROR);
    expect(errMsg(invalidContent.body)).not.toBe(CONTENT_REQUIRED_ERROR);
  });

  test('권한 없음으로 거절된 뒤 서버 상태가 전혀 바뀌지 않았다 [30.12 · G10]', async () => {
    const snap = await (await ownerCtx.request.get(reviewsUrl(PRODUCT))).json();
    const line = snap.reviews.find((r) => r.reviewId === reviewId);
    expect(line.rating).toBe(4);
    expect(line.content).toBe('G7 권한 경계 기준 리뷰');
    expect(line.createdAt).toBe(originalCreatedAt);
    expect(snap.reviewCount).toBeGreaterThan(0); // 삭제되지 않았다
  });

  test('로그인하지 않고 수정·삭제를 요청하면 둘 다 "로그인이 필요합니다."로 거절되고 리뷰는 변경되지 않는다 [30.13 · G13]', async ({
    browser,
  }) => {
    const guestCtx = await browser.newContext({ baseURL: 'http://localhost:3000' });
    try {
      const patchRes = await patchReviewRaw(guestCtx, reviewId, { rating: 1, content: '비로그인 수정 시도' });
      expect(patchRes.status).toBe(401);
      expect(errMsg(patchRes.body)).toBe(LOGIN_REQUIRED_ERROR);

      const deleteRes = await deleteReviewRaw(guestCtx, reviewId);
      expect(deleteRes.status).toBe(401);
      expect(errMsg(deleteRes.body)).toBe(LOGIN_REQUIRED_ERROR);

      const snap = await (await ownerCtx.request.get(reviewsUrl(PRODUCT))).json();
      expect(snap.reviews.find((r) => r.reviewId === reviewId).rating).toBe(4);
    } finally {
      await guestCtx.close();
    }
  });
});

// ===========================================================================
// 시나리오 2: 본인이 리뷰를 수정한다
// [PRD 30.11/D49 · G1/G4/G5/G14/G19]
// ===========================================================================
test.describe('시나리오: 본인이 리뷰를 수정한다', () => {
  let self;
  let partner;
  let selfReviewId;
  let partnerReviewId;
  let selfCreatedAt;

  test.beforeAll(async () => {
    partner = await signup(context.request, 'g4partner');
    await loginAs(context, partner.email, partner.password);
    const partnerCreated = await postReviewAs(context, PRODUCT, 4, 'G4 상대 리뷰(4점)');
    partnerReviewId = partnerCreated.body.reviews.find((r) => r.email === partner.email).reviewId;
    await logout(context);

    self = await signup(context.request, 'g1self');
    await loginAs(context, self.email, self.password);
    const selfCreated = await postReviewAs(context, PRODUCT, 5, 'G1 내 리뷰(5점)');
    const mine = selfCreated.body.reviews.find((r) => r.email === self.email);
    selfReviewId = mine.reviewId;
    selfCreatedAt = mine.createdAt;
  });

  test.afterAll(async () => {
    await deleteReviewRaw(context, selfReviewId).catch(() => {});
    await logout(context);
    await loginAs(context, partner.email, partner.password);
    await deleteReviewRaw(context, partnerReviewId).catch(() => {});
    await logout(context);
  });

  test('본인 리뷰를 고치면 평점·본문이 바뀌고, 응답은 조회와 같은 형태의 전체 목록이다 [30.11 · G1]', async () => {
    const res = await patchReviewRaw(context, selfReviewId, { rating: 3, content: 'G1 수정된 본문' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['averageRating', 'reviewCount', 'reviews']);
    const mine = res.body.reviews.find((r) => r.reviewId === selfReviewId);
    expect(mine.rating).toBe(3);
    expect(mine.content).toBe('G1 수정된 본문');
    expect(res.body.reviews.length).toBe(2); // 고친 한 줄만 돌려주지 않는다 — 상대 리뷰도 함께
  });

  test('🔑 고쳐도 작성 시각이 바뀌지 않고 목록 순서도 바뀌지 않는다 [D49 · G5]', async () => {
    const res = await patchReviewRaw(context, selfReviewId, { rating: 2, content: 'G5 재수정' });
    const mine = res.body.reviews.find((r) => r.reviewId === selfReviewId);
    expect(mine.createdAt).toBe(selfCreatedAt);
    expect(mine).not.toHaveProperty('updatedAt');
    // 더 나중에 쓴 쪽(self)이 여전히 더 위에 있다 — 수정으로 순서가 바뀌지 않는다
    expect(res.body.reviews[0].reviewId).toBe(selfReviewId);
  });

  test('평점을 5에서 1로 고치면(상대가 4점) 그 응답의 평균이 즉시 2.5가 된다 — 화면도 즉시 바뀐다 [30.4 · G4]', async () => {
    await patchReviewRaw(context, selfReviewId, { rating: 2, content: '초기화' }); // 이전 테스트 흔적 정리 — 자기 자신은 2점으로
    const resetRes = await patchReviewRaw(context, selfReviewId, { rating: 5, content: 'G4 재설정' });
    expect(resetRes.body.averageRating).toBe(4.5); // (5+4)/2

    await page.goto(`/product.html?id=${PRODUCT}`);
    const row = page.locator(`[data-testid="review-item"][data-review-id="${selfReviewId}"]`);
    await row.getByTestId('review-item-edit').click();
    const editForm = row.getByTestId('review-edit-form');
    await editForm.getByTestId('review-edit-rating').selectOption('1');
    await editForm.getByTestId('review-edit-save').click();

    await expect(page.getByTestId('review-average')).toHaveText('2.5점'); // (1+4)/2, 새로고침 없이 즉시
  });

  test('수정은 평점과 본문을 항상 함께 보낸다 — 하나만 보내면 나머지 안내로 거절되고 리뷰는 바뀌지 않는다 [30.11 · G14]', async () => {
    const before = await (await context.request.get(reviewsUrl(PRODUCT))).json();
    const beforeLine = before.reviews.find((r) => r.reviewId === selfReviewId);

    const ratingOnly = await patchReviewRaw(context, selfReviewId, { rating: 3 });
    expect(ratingOnly.status).toBe(400);
    expect(errMsg(ratingOnly.body)).toBe(CONTENT_REQUIRED_ERROR);

    const contentOnly = await patchReviewRaw(context, selfReviewId, { content: '본문만 보냄' });
    expect(contentOnly.status).toBe(400);
    expect(errMsg(contentOnly.body)).toBe(RATING_ERROR);

    const after = await (await context.request.get(reviewsUrl(PRODUCT))).json();
    const afterLine = after.reviews.find((r) => r.reviewId === selfReviewId);
    expect(afterLine.rating).toBe(beforeLine.rating);
    expect(afterLine.content).toBe(beforeLine.content);
  });

  test('수정 요청에 작성 시각·작성자 이메일·상품 식별자를 끼워 보내도 전부 무시된다 [30.11 · G19]', async () => {
    const res = await patchReviewRaw(context, selfReviewId, {
      rating: 4,
      content: 'G19 스푸핑 확인',
      createdAt: '1999-01-01T00:00:00.000Z',
      email: 'spoofed@example.com',
      productId: 'p999',
    });
    expect(res.status).toBe(200);
    const mine = res.body.reviews.find((r) => r.reviewId === selfReviewId);
    expect(mine.createdAt).toBe(selfCreatedAt);
    expect(mine.email).toBe(self.email);
    expect(mine.productId).toBe(PRODUCT);
  });
});

// ===========================================================================
// 시나리오 3: 본인이 리뷰를 지운다
// [PRD 29.6/30.11 · G3/G6/G11/G16/G17]
// ===========================================================================
test.describe('시나리오: 본인이 리뷰를 지운다', () => {
  let self;
  let reviewId;

  test.beforeAll(async () => {
    self = await signup(context.request, 'g3self');
    await loginAs(context, self.email, self.password);
    const created = await postReviewAs(context, PRODUCT, 3, 'G3/G6 삭제 대상 리뷰(유일한 리뷰)');
    reviewId = created.body.reviews.find((r) => r.email === self.email).reviewId;
  });

  test.afterAll(async () => {
    await logout(context);
  });

  test('🚨 삭제는 확인창 없이 클릭 한 번이 곧 실행이며, 마지막 리뷰라 빈 상태로 바뀌고 작성 폼이 다시 보인다 [30.11/29.6/29.7 · G3/G6/G16/G17]', async () => {
    await page.goto(`/product.html?id=${PRODUCT}`);
    await expect(page.getByTestId('review-count')).toHaveText('1');

    let dialogFired = false;
    page.on('dialog', () => {
      dialogFired = true;
    });

    const deletes = [];
    page.on('request', (req) => {
      if (req.method() === 'DELETE' && req.url().endsWith(reviewUrl(reviewId))) deletes.push(req);
    });

    const row = page.locator(`[data-testid="review-item"][data-review-id="${reviewId}"]`);
    await row.getByTestId('review-item-delete').click();

    expect(dialogFired).toBe(false); // 확인창 없음
    await expect(page.getByTestId('review-empty')).toBeVisible();
    await expect(page.getByTestId('review-list')).toBeHidden();
    await expect(page.getByTestId('review-average')).toHaveText('아직 평점이 없습니다');
    await expect(page.getByTestId('review-count')).toHaveText('0');

    await expect(page.getByTestId('review-form')).toBeVisible(); // 내 리뷰가 없어졌으므로 폼이 다시 보인다
    await expect(page.getByTestId('review-rating-select')).toHaveValue('');
    await expect(page.getByTestId('review-content-input')).toHaveValue('');
    await expect(page.getByTestId('review-login-notice')).toBeHidden();

    expect(deletes.length).toBe(1);
  });

  test('같은 리뷰를 두 번 지우면 두 번째는 "리뷰를 찾을 수 없습니다."다 (멱등하지 않다, 의도된 동작) [30.11 · G11]', async () => {
    const res = await deleteReviewRaw(context, reviewId);
    expect(res.status).toBe(404);
    expect(errMsg(res.body)).toBe(REVIEW_NOT_FOUND_ERROR);
  });
});

// ===========================================================================
// 시나리오 4: 같은 줄 안에서 리뷰를 수정한다 (인라인 편집 화면)
// [PRD 29.2~29.5/29.11 · G12/G15/G18]
// ===========================================================================
test.describe('시나리오: 같은 줄 안에서 리뷰를 수정한다', () => {
  let self;
  let other;
  let selfReviewId;
  let otherReviewId;

  test.beforeAll(async () => {
    other = await signup(context.request, 'g15other');
    await loginAs(context, other.email, other.password);
    const otherCreated = await postReviewAs(context, PRODUCT, 2, 'G15 남의 줄');
    otherReviewId = otherCreated.body.reviews.find((r) => r.email === other.email).reviewId;
    await logout(context);

    self = await signup(context.request, 'g12self');
    await loginAs(context, self.email, self.password);
    const selfCreated = await postReviewAs(context, PRODUCT, 3, 'G12 내 줄 초기값');
    selfReviewId = selfCreated.body.reviews.find((r) => r.email === self.email).reviewId;
  });

  test.afterAll(async () => {
    await deleteReviewRaw(context, selfReviewId).catch(() => {});
    await logout(context);
    await loginAs(context, other.email, other.password);
    await deleteReviewRaw(context, otherReviewId).catch(() => {});
    await logout(context);
  });

  test('로그인 상태에서 내 줄에만 수정·삭제 버튼이 하나씩 있고, 남의 줄에는 화면 구조에 아예 없다 [29.11 · G15]', async () => {
    await page.goto(`/product.html?id=${PRODUCT}`);
    const myRow = page.locator(`[data-testid="review-item"][data-review-id="${selfReviewId}"]`);
    const otherRow = page.locator(`[data-testid="review-item"][data-review-id="${otherReviewId}"]`);

    await expect(myRow.getByTestId('review-item-edit')).toHaveCount(1);
    await expect(myRow.getByTestId('review-item-delete')).toHaveCount(1);
    await expect(otherRow.getByTestId('review-item-edit')).toHaveCount(0);
    await expect(otherRow.getByTestId('review-item-delete')).toHaveCount(0);
    await expect(myRow.getByTestId('review-item-email')).toHaveText(self.email);
  });

  test('수정 버튼을 누르면 그 줄 안에서 폼이 열린다 — 이동·모달 없이, 표시는 숨겨지고 폼은 하나뿐이다 [29.2/29.3 · G12]', async () => {
    await page.goto(`/product.html?id=${PRODUCT}`);
    const row = page.locator(`[data-testid="review-item"][data-review-id="${selfReviewId}"]`);
    const urlBefore = page.url();

    await row.getByTestId('review-item-edit').click();

    await expect(page).toHaveURL(urlBefore); // 이동하지 않음
    await expect(row.getByTestId('review-edit-form')).toHaveCount(1);
    await expect(row.getByTestId('review-item-rating')).toBeHidden();
    await expect(row.getByTestId('review-item-content')).toBeHidden();

    const select = row.getByTestId('review-edit-rating');
    await expect(select.locator('option')).toHaveCount(5); // 빈 값 없음
    await expect(select).toHaveValue('3'); // 현재 저장된 평점
    await expect(row.getByTestId('review-edit-content')).toHaveValue('G12 내 줄 초기값');
    expect(await row.getByTestId('review-edit-content').evaluate((el) => el.hasAttribute('maxlength'))).toBe(false);

    await row.getByTestId('review-edit-cancel').click(); // 다음 테스트를 위해 닫아둔다
  });

  test('값을 고친 뒤 취소하면 요청이 나가지 않고 원래 표시로 돌아오며, 다시 열면 저장된 값이 들어있다 [29.5 · G18]', async () => {
    await page.goto(`/product.html?id=${PRODUCT}`);
    const row = page.locator(`[data-testid="review-item"][data-review-id="${selfReviewId}"]`);

    const patches = [];
    page.on('request', (req) => {
      if (req.method() === 'PATCH') patches.push(req);
    });

    await row.getByTestId('review-item-edit').click();
    await row.getByTestId('review-edit-rating').selectOption('5');
    await row.getByTestId('review-edit-content').fill('취소될 입력');
    await row.getByTestId('review-edit-cancel').click();

    expect(patches.length).toBe(0); // 서버 요청 없음
    await expect(row.getByTestId('review-item-rating')).toHaveText('3'); // 원래 표시로 복귀
    await expect(row.getByTestId('review-item-content')).toHaveText('G12 내 줄 초기값');

    await row.getByTestId('review-item-edit').click(); // 다시 열면
    await expect(row.getByTestId('review-edit-rating')).toHaveValue('3'); // 저장된 값(취소한 입력은 버려짐)
    await expect(row.getByTestId('review-edit-content')).toHaveValue('G12 내 줄 초기값');
    await row.getByTestId('review-edit-cancel').click();
  });
});

// ===========================================================================
// 시나리오 5: 수정·삭제가 실패했을 때 / 연속 클릭에도 요청이 1건만 나가는지
// [PRD 29.8/29.9/31.8 · G20]
// ===========================================================================
test.describe('시나리오: 수정·삭제가 실패했을 때 / 연속 클릭 방지', () => {
  let self;

  test.beforeAll(async () => {
    self = await signup(context.request, 'g20self');
    await loginAs(context, self.email, self.password);
  });

  test.afterAll(async () => {
    await logout(context);
  });

  test('삭제가 실패하면 그 줄이 사라지지 않고 목록·평균·개수가 실패 전 그대로다 [29.9 · G20]', async () => {
    const created = await postReviewAs(context, PRODUCT, 3, 'G20 삭제실패 대상');
    const reviewId = created.body.reviews.find((r) => r.email === self.email).reviewId;

    await page.goto(`/product.html?id=${PRODUCT}`);
    await page.route(reviewUrl(reviewId), (route) => {
      if (route.request().method() === 'DELETE') {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: '리뷰 요청을 처리하지 못했습니다.' } }),
        });
      }
      return route.continue();
    });

    const row = page.locator(`[data-testid="review-item"][data-review-id="${reviewId}"]`);
    await row.getByTestId('review-item-delete').click();

    await expect(page.getByTestId('review-error')).toBeVisible();
    await expect(row).toHaveCount(1); // 그 줄이 사라지지 않는다
    await expect(page.getByTestId('review-list')).toBeVisible(); // 31.8 — 실패해도 목록은 계속 보인다
    await expect(page.getByTestId('review-count')).toHaveText('1');

    await page.unroute(reviewUrl(reviewId));
    await deleteReviewRaw(context, reviewId); // 정리
  });

  test('수정이 실패하면 수정 폼이 열린 채로 남고 입력값도 유지된다 [29.9 · G20]', async () => {
    const created = await postReviewAs(context, PRODUCT, 4, 'G20 수정실패 대상');
    const reviewId = created.body.reviews.find((r) => r.email === self.email).reviewId;

    await page.goto(`/product.html?id=${PRODUCT}`);
    const row = page.locator(`[data-testid="review-item"][data-review-id="${reviewId}"]`);
    await row.getByTestId('review-item-edit').click();
    await row.getByTestId('review-edit-content').fill('   '); // 공백만 → 400

    const editForm = row.getByTestId('review-edit-form');
    await editForm.getByTestId('review-edit-save').click();

    await expect(page.getByTestId('review-error')).toHaveText(CONTENT_REQUIRED_ERROR);
    await expect(editForm).toHaveCount(1); // 폼이 열린 채로 남는다
    await expect(row.getByTestId('review-edit-content')).toHaveValue('   '); // 입력값 유지
    await expect(page.getByTestId('review-list')).toBeVisible();

    await row.getByTestId('review-edit-cancel').click();
    await deleteReviewRaw(context, reviewId); // 정리
  });

  test('삭제 버튼을 연속으로 세 번 눌러도 요청은 한 건만 나간다 [29.8]', async () => {
    const created = await postReviewAs(context, PRODUCT, 2, 'G20 연속삭제 대상');
    const reviewId = created.body.reviews.find((r) => r.email === self.email).reviewId;

    await page.goto(`/product.html?id=${PRODUCT}`);
    const row = page.locator(`[data-testid="review-item"][data-review-id="${reviewId}"]`);
    await row.getByTestId('review-item-delete').waitFor({ state: 'visible' }); // 전체 스위트 동시 실행 시 렌더 지연 대비

    const deletes = [];
    page.on('request', (req) => {
      if (req.method() === 'DELETE' && req.url().endsWith(reviewUrl(reviewId))) deletes.push(req);
    });

    await page.evaluate((rid) => {
      const row = document.querySelector(`[data-testid="review-item"][data-review-id="${rid}"]`);
      const btn = row.querySelector('[data-testid="review-item-delete"]');
      btn.click();
      btn.click();
      btn.click();
    }, reviewId);
    await page.waitForLoadState('networkidle');

    expect(deletes.length).toBe(1);
    await expect(page.getByTestId('review-empty')).toBeVisible(); // 유일한 리뷰였으므로 빈 상태로 복귀
  });

  test('저장 버튼을 연속으로 세 번 눌러도 요청은 한 건만 나간다 [29.8]', async () => {
    const created = await postReviewAs(context, PRODUCT, 3, 'G20 연속저장 대상');
    const reviewId = created.body.reviews.find((r) => r.email === self.email).reviewId;

    await page.goto(`/product.html?id=${PRODUCT}`);
    const row = page.locator(`[data-testid="review-item"][data-review-id="${reviewId}"]`);
    await row.getByTestId('review-item-edit').click();
    await row.getByTestId('review-edit-content').fill('연속저장 확인');
    await row.getByTestId('review-edit-save').waitFor({ state: 'visible' });

    const patches = [];
    page.on('request', (req) => {
      if (req.method() === 'PATCH' && req.url().endsWith(reviewUrl(reviewId))) patches.push(req);
    });

    await page.evaluate((rid) => {
      const row2 = document.querySelector(`[data-testid="review-item"][data-review-id="${rid}"]`);
      const btn = row2.querySelector('[data-testid="review-edit-save"]');
      btn.click();
      btn.click();
      btn.click();
    }, reviewId);
    await page.waitForLoadState('networkidle');

    expect(patches.length).toBe(1);
    await deleteReviewRaw(context, reviewId); // 정리
  });

  test('수정에 성공한 직후 바로 삭제해도 즉시 동작한다 — 버튼이 잠긴 채로 굳지 않는다(회귀 확인) [29.8]', async () => {
    const created = await postReviewAs(context, PRODUCT, 1, 'G20 수정 후 즉시삭제 대상');
    const reviewId = created.body.reviews.find((r) => r.email === self.email).reviewId;

    await page.goto(`/product.html?id=${PRODUCT}`);
    const row = page.locator(`[data-testid="review-item"][data-review-id="${reviewId}"]`);
    await row.getByTestId('review-item-edit').click();
    await row.getByTestId('review-edit-content').fill('수정 후 즉시 삭제 확인');
    await row.getByTestId('review-edit-save').click();

    await expect(row.getByTestId('review-edit-form')).toHaveCount(0); // 수정 성공, 표시 모드로 복귀
    await row.getByTestId('review-item-delete').click(); // 바로 삭제 — 버튼이 굳어있지 않아야 한다

    await expect(row).toHaveCount(0, { timeout: 5000 });
  });
});
