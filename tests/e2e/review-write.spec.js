'use strict';

/**
 * 리뷰 작성 화면/API — tests/test-cases.ko.md "6차 사이클 — 상품 리뷰 / 평점" 중
 *   "리뷰 작성 — 로그인한 사람만" ~ "리뷰 작성 화면 — 성공했을 때/실패했을 때"
 *   (PRD 28장 / 30.6~30.9/30.13 · 매트릭스 F1~F19, H5, H9)
 *
 * 구성 방식: BDD/시나리오 스타일. describe = 시나리오, 테스트 제목 끝 [ ]는 PRD/매트릭스
 * 각주, test-cases.ko.md 구조는 그대로 둔다.
 *
 * 제외 (test-cases.ko.md "6차 자동화 계획"에서 합의):
 *   - 진짜 동시 쓰기(같은 계정이 같은 상품에 동시에 작성) — 타이밍 기반이라 flaky해진다.
 *     F12(연속 클릭 방지)로 같은 위험(중복 요청)을 덮는다.
 *   - 핸들러 내부에서 터지는 진짜 서버 예외 — 결정론적으로 일으킬 수단이 요청 본문 크기
 *     초과뿐이고, 그 수단은 review-independence.spec.js의 30.18(H8) 검증이 담당한다.
 *
 * 상품 할당: p4 = PRIMARY(쓰기·정리 반복용), p5 = SECOND(F7 "다른 상품에는 쓸 수 있다" 전용).
 * (review-read.spec.js는 p1~p3, review-ownership.spec.js는 p7, review-independence.spec.js는
 *  p8을 쓴다 — 서로 겹치지 않아 파일 단위 병렬 실행에도 리뷰 데이터가 오염되지 않는다.)
 *
 * 연속 클릭(F12) 재현: `click()`을 Playwright API로 두 번 호출하면 첫 클릭 직후 버튼이
 * disabled로 바뀌어 두 번째 호출이 "활성화 대기"로 멈추거나 에러가 난다. 그래서
 * `page.evaluate(() => { b.click(); b.click(); b.click(); })`로 같은 틱에서 DOM의
 * click()을 직접 호출한다 — disabled 버튼에 대한 네이티브 click()은 이벤트를 내지 않으므로
 * 실제로는 핸들러가 1번만 실행된다(요청 1건으로 귀결).
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'default' });

let context;
let page;

test.beforeAll(async ({ browser, baseURL, viewport }) => {
  context = await browser.newContext({ baseURL, viewport });
  page = await context.newPage();
  console.log('[review-write.spec] 공유 브라우저 컨텍스트 1개 생성 (테스트마다 새로 열지 않는다)');
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

const PRIMARY = 'p4';
const SECOND = 'p5';

const RATING_ERROR = '평점은 1 이상 5 이하의 정수로 입력해 주세요.';
const CONTENT_REQUIRED_ERROR = '리뷰 내용을 입력해 주세요.';
const CONTENT_LENGTH_ERROR = '리뷰 내용은 500자 이하로 입력해 주세요.';
const REVIEW_DUPLICATE_ERROR = '이미 이 상품에 리뷰를 작성했습니다.';
const PRODUCT_NOT_FOUND_ERROR = '상품을 찾을 수 없습니다.';
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

async function postReviewRaw(reqCtx, productId, data) {
  const res = await reqCtx.request.post(reviewsUrl(productId), { data });
  const body = await res.json().catch(() => null);
  return { status: res.status(), body, res };
}

async function postReviewAs(reqCtx, productId, rating, content) {
  return postReviewRaw(reqCtx, productId, { rating, content });
}

async function deleteReviewAs(reqCtx, reviewId) {
  const res = await reqCtx.request.delete(reviewUrl(reviewId));
  expect(res.status()).toBe(200);
  return res;
}

/** PRIMARY 상품을 완전히 비워 둔다 (이전 테스트가 실패로 중간에 끊겼을 때를 대비). */
async function ensureEmpty(reqCtx, productId) {
  const snap = await (await reqCtx.request.get(reviewsUrl(productId))).json();
  for (const r of snap.reviews) {
    // 삭제는 작성자 로그인이 필요하다 — 여기서는 테스트 데이터만 다루므로 실패해도 무시한다.
    // (테스트 자신이 만든 리뷰만 지우는 것이 원칙이라, 이 헬퍼는 "혹시 남아있다면"의 안전망이다)
    await reqCtx.request.delete(reviewUrl(r.reviewId)).catch(() => {});
  }
}

test.beforeAll(async () => {
  // no-op placeholder kept for readability of setup phases
});

// ===========================================================================
// 시나리오 1: 로그인한 사람만 리뷰를 쓸 수 있다
// [PRD 30.9/30.13/30.6/30.5/30.8/30.15 · F1/F2/F3/F13/F14/F15/H5]
// ===========================================================================
test.describe('시나리오: 로그인한 사람만 리뷰를 쓸 수 있다', () => {
  test('로그인 상태로 정상 작성하면 "새로 만들어졌다(201)"로 응답하고 갱신된 전체 목록을 돌려준다 [30.9 · F1]', async () => {
    const acc = await createAccount('f1');
    await loginAs(context, acc.email, acc.password);
    const res = await postReviewAs(context, PRIMARY, 4, 'F1 정상 작성 확인');
    expect(res.status).toBe(201);

    const mine = res.body.reviews.find((r) => r.email === acc.email);
    expect(mine).toBeTruthy();
    expect(res.body.reviews[0].reviewId).toBe(mine.reviewId); // 방금 쓴 리뷰가 맨 앞
    expect(mine.isMine).toBe(true);
    expect(mine.email).toBe(acc.email); // 작성자는 로그인한 계정의 이메일
    expect(mine.reviewId).toMatch(/^[0-9a-f-]{36}$/i); // 서버가 만든 무작위 값(UUID)

    await deleteReviewAs(context, mine.reviewId);
    await logout(context);
  });

  test('로그인하지 않고 작성을 요청하면 "로그인이 필요합니다."로 거절되고, 리뷰가 하나도 만들어지지 않는다 [30.13 · F2]', async () => {
    // 절대값(0)이 아니라 시도 전후의 변화로 확인한다 — PRIMARY는 이 파일의 다른 테스트와 공유되므로
    // 반복 실행 시 이미 리뷰가 쌓여 있을 수 있다 (6차 자동화 1차 시도에서 실제로 걸린 지점).
    const before = await (await context.request.get(reviewsUrl(PRIMARY))).json();

    const res = await postReviewAs(context, PRIMARY, 5, 'F2 비로그인 작성 시도');
    expect(res.status).toBe(401);
    expect(errMsg(res.body)).toBe(LOGIN_REQUIRED_ERROR);

    const after = await (await context.request.get(reviewsUrl(PRIMARY))).json();
    expect(after.reviewCount).toBe(before.reviewCount); // 거절됐으므로 개수가 바뀌지 않아야 한다
  });

  test('가짜·만료된 로그인 쿠키로 작성을 요청하면 거절되고, 그 쿠키를 지우라는 헤더가 함께 온다 [D36 · F3]', async ({
    browser,
  }) => {
    const probe = await browser.newContext({ baseURL: 'http://localhost:3000' });
    try {
      await probe.addCookies([{ name: 'sessionId', value: 'bogus-session-f3', domain: 'localhost', path: '/' }]);
      const res = await probe.request.post(reviewsUrl(PRIMARY), { data: { rating: 3, content: 'F3 가짜 쿠키' } });
      expect(res.status()).toBe(401);
      const setCookies = res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
      expect(setCookies.some((h) => h.value.startsWith('sessionId=') && h.value.includes('Max-Age=0'))).toBe(true);
    } finally {
      await probe.close();
    }
  });

  test('🚨 남의 이메일·리뷰 식별자·작성 시각을 끼워 보내도 전부 서버 값으로 덮인다(사칭 불가) [30.6 · F13]', async () => {
    const acc = await createAccount('f13');
    const victimEmail = 'victim-f13@example.com';
    await loginAs(context, acc.email, acc.password);

    const spoofed = await postReviewRaw(context, PRIMARY, {
      rating: 5,
      content: 'F13 사칭 시도',
      email: victimEmail,
      reviewId: 'fake-review-id-0000',
      createdAt: '2000-01-01T00:00:00.000Z',
      productId: 'p999',
      nickname: '닉네임시도',
    });
    expect(spoofed.status).toBe(201);

    const mine = spoofed.body.reviews.find((r) => r.content === 'F13 사칭 시도');
    expect(mine.email).toBe(acc.email); // 세션의 이메일로 고정
    expect(mine.email).not.toBe(victimEmail);
    expect(mine.reviewId).not.toBe('fake-review-id-0000');
    expect(mine.createdAt).not.toBe('2000-01-01T00:00:00.000Z');
    expect(mine.productId).toBe(PRIMARY); // URL 경로가 대상 상품
    expect(mine).not.toHaveProperty('nickname');

    await deleteReviewAs(context, mine.reviewId);
    await logout(context);
  });

  test('로그인 상태로 존재하지 않는 상품에 작성하면 "상품을 찾을 수 없습니다."로 거절된다 [30.5 · F14]', async () => {
    const acc = await createAccount('f14');
    await loginAs(context, acc.email, acc.password);
    const res = await postReviewAs(context, 'no-such-product-f14', 3, 'F14 존재하지 않는 상품');
    expect(res.status).toBe(404);
    expect(errMsg(res.body)).toBe(PRODUCT_NOT_FOUND_ERROR);
    await logout(context);
  });

  test('🔑 로그인하지 않고 존재하지 않는 상품에 작성하면 "로그인이 필요합니다."가 먼저 나온다 [30.8 · F15]', async () => {
    const res = await postReviewAs(context, 'no-such-product-f15', 3, 'F15 비로그인+존재하지 않는 상품');
    expect(res.status).toBe(401);
    expect(errMsg(res.body)).toBe(LOGIN_REQUIRED_ERROR);
    expect(errMsg(res.body)).not.toBe(PRODUCT_NOT_FOUND_ERROR);
  });

  test('리뷰 작성 응답에는 장바구니 쿠키가 절대 실리지 않는다 [30.9 · H5]', async () => {
    const acc = await createAccount('h5');
    await loginAs(context, acc.email, acc.password);
    const res = await context.request.post(reviewsUrl(PRIMARY), { data: { rating: 2, content: 'H5 쿠키 확인' } });
    const setCookies = res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
    expect(setCookies.some((h) => h.value.startsWith('cartId='))).toBe(false);

    const body = await res.json();
    const mine = body.reviews.find((r) => r.email === acc.email);
    await deleteReviewAs(context, mine.reviewId);
    await logout(context);
  });
});

// ===========================================================================
// 시나리오 2: 평점이 잘못된 입력으로 작성을 시도하는 사람
// [PRD 30.7 · F4/F18]
// ===========================================================================
test.describe('시나리오: 평점이 잘못된 입력으로 작성을 시도하는 사람', () => {
  test('평점 경계: 0점은 거절, 1점은 통과, 5점은 통과, 6점은 거절된다 [30.7 · F4]', async () => {
    const acc = await createAccount('f4bound');
    await loginAs(context, acc.email, acc.password);

    const zero = await postReviewAs(context, PRIMARY, 0, 'F4 경계 0점');
    expect(zero.status).toBe(400);
    expect(errMsg(zero.body)).toBe(RATING_ERROR);

    const six = await postReviewAs(context, PRIMARY, 6, 'F4 경계 6점');
    expect(six.status).toBe(400);
    expect(errMsg(six.body)).toBe(RATING_ERROR);

    const one = await postReviewAs(context, PRIMARY, 1, 'F4 경계 1점');
    expect(one.status).toBe(201);
    const mine1 = one.body.reviews.find((r) => r.email === acc.email);
    await deleteReviewAs(context, mine1.reviewId);

    const five = await postReviewAs(context, PRIMARY, 5, 'F4 경계 5점');
    expect(five.status).toBe(201);
    const mine5 = five.body.reviews.find((r) => r.email === acc.email);
    await deleteReviewAs(context, mine5.reviewId);

    await logout(context);
  });

  test('소수·문자열 숫자·참거짓·null·누락 — 다섯 경우 모두 똑같은 평점 안내로 거절된다 [30.7 · F4]', async () => {
    const acc = await createAccount('f4types');
    await loginAs(context, acc.email, acc.password);
    // 절대값(0)이 아니라 시도 전후의 변화로 확인한다 (F2와 같은 이유).
    const before = await (await context.request.get(reviewsUrl(PRIMARY))).json();

    const decimal = await postReviewAs(context, PRIMARY, 4.5, 'F4 소수');
    const asString = await postReviewAs(context, PRIMARY, '5', 'F4 문자열');
    const asBoolean = await postReviewAs(context, PRIMARY, true, 'F4 불리언');
    const asNull = await postReviewAs(context, PRIMARY, null, 'F4 널');
    const missing = await postReviewRaw(context, PRIMARY, { content: 'F4 누락' });

    for (const res of [decimal, asString, asBoolean, asNull, missing]) {
      expect(res.status).toBe(400);
      expect(errMsg(res.body)).toBe(RATING_ERROR);
    }

    const after = await (await context.request.get(reviewsUrl(PRIMARY))).json();
    expect(after.reviewCount).toBe(before.reviewCount);
    await logout(context);
  });

  test('🔑 평점과 본문이 둘 다 잘못됐으면 평점 안내가 나온다(평점을 먼저 검사한다) [30.7 · F18]', async () => {
    const acc = await createAccount('f18');
    await loginAs(context, acc.email, acc.password);
    const res1 = await postReviewAs(context, PRIMARY, 0, '');
    expect(errMsg(res1.body)).toBe(RATING_ERROR);
    const res2 = await postReviewAs(context, PRIMARY, 0, '');
    expect(errMsg(res2.body)).toBe(RATING_ERROR); // 같은 입력에 매번 같은 안내
    await logout(context);
  });
});

// ===========================================================================
// 시나리오 3: 본문이 잘못된 입력으로 작성을 시도하는 사람
// [PRD 30.7/D48 · F5/F10/F19]
// ===========================================================================
test.describe('시나리오: 본문이 잘못된 입력으로 작성을 시도하는 사람', () => {
  test('본문 누락·null·숫자·빈 문자열·공백만·개행탭만 — 여섯 경우 모두 똑같은 안내로 거절된다 [30.7/D48 · F5]', async () => {
    const acc = await createAccount('f5');
    await loginAs(context, acc.email, acc.password);
    // 절대값(0)이 아니라 시도 전후의 변화로 확인한다 (F2와 같은 이유).
    const before = await (await context.request.get(reviewsUrl(PRIMARY))).json();

    const missing = await postReviewRaw(context, PRIMARY, { rating: 3 });
    const asNull = await postReviewAs(context, PRIMARY, 3, null);
    const asNumber = await postReviewAs(context, PRIMARY, 3, 12345);
    const empty = await postReviewAs(context, PRIMARY, 3, '');
    const onlySpaces = await postReviewAs(context, PRIMARY, 3, '    ');
    const onlyNewlineTab = await postReviewAs(context, PRIMARY, 3, '\n\t\n');

    for (const res of [missing, asNull, asNumber, empty, onlySpaces, onlyNewlineTab]) {
      expect(res.status).toBe(400);
      expect(errMsg(res.body)).toBe(CONTENT_REQUIRED_ERROR);
    }

    const after = await (await context.request.get(reviewsUrl(PRIMARY))).json();
    expect(after.reviewCount).toBe(before.reviewCount);
    await logout(context);
  });

  test('길이 경계는 trim 후 기준이다: 1자 통과, 500자 통과, 501자는 길이 전용 안내로 거절된다 [30.7 · F10]', async () => {
    const acc = await createAccount('f10');
    await loginAs(context, acc.email, acc.password);

    const one = await postReviewAs(context, PRIMARY, 3, 'a');
    expect(one.status).toBe(201);
    const mineOne = one.body.reviews.find((r) => r.email === acc.email);
    await deleteReviewAs(context, mineOne.reviewId);

    const five00 = await postReviewAs(context, PRIMARY, 3, 'b'.repeat(500));
    expect(five00.status).toBe(201);
    const mine500 = five00.body.reviews.find((r) => r.email === acc.email);
    expect(mine500.content.length).toBe(500);
    await deleteReviewAs(context, mine500.reviewId);

    const five01 = await postReviewAs(context, PRIMARY, 3, 'c'.repeat(501));
    expect(five01.status).toBe(400);
    expect(errMsg(five01.body)).toBe(CONTENT_LENGTH_ERROR);

    await logout(context);
  });

  test('⚠️ 앞에 공백 600개 + 글자 1개(trim 전 601자)는 통과한다 — trim 후 1자이기 때문이다 [30.7 · F10]', async () => {
    const acc = await createAccount('f10edge');
    await loginAs(context, acc.email, acc.password);
    const padded = ' '.repeat(600) + 'x';
    const res = await postReviewAs(context, PRIMARY, 3, padded);
    expect(res.status).toBe(201);
    const mine = res.body.reviews.find((r) => r.email === acc.email);
    expect(mine.content).toBe('x'); // 저장된 본문도 공백이 떨어진 1자다
    await deleteReviewAs(context, mine.reviewId);
    await logout(context);
  });

  test('본문의 앞뒤 공백만 제거되고 가운데 개행·탭은 그대로 보존된다 [30.7 · F19]', async () => {
    const acc = await createAccount('f19');
    await loginAs(context, acc.email, acc.password);
    const raw = '  좋아요\n  정말\t좋아요  ';
    const res = await postReviewAs(context, PRIMARY, 4, raw);
    expect(res.status).toBe(201);
    const mine = res.body.reviews.find((r) => r.email === acc.email);
    expect(mine.content).toBe('좋아요\n  정말\t좋아요');
    await deleteReviewAs(context, mine.reviewId);
    await logout(context);
  });
});

// ===========================================================================
// 시나리오 4: 같은 상품에 두 번 쓰려는 사람
// [PRD 30.8/D45 · F6/F7/F8]
// ===========================================================================
test.describe('시나리오: 같은 상품에 두 번 쓰려는 사람', () => {
  test('같은 상품에 두 번째 리뷰를 쓰면 거절되고, 기존 리뷰가 덮어써지지 않는다 [D45/30.8 · F6]', async () => {
    const acc = await createAccount('f6');
    await loginAs(context, acc.email, acc.password);
    const first = await postReviewAs(context, PRIMARY, 3, 'F6 최초 작성');
    const mine = first.body.reviews.find((r) => r.email === acc.email);
    const countAfterFirst = first.body.reviewCount; // 절대값(1)이 아니라 "이 시점의 개수"를 기준으로 삼는다

    const dup = await postReviewAs(context, PRIMARY, 5, 'F6 덮어쓰기 시도');
    expect(dup.status).toBe(409);
    expect(errMsg(dup.body)).toBe(REVIEW_DUPLICATE_ERROR);

    const after = await (await context.request.get(reviewsUrl(PRIMARY))).json();
    const stillMine = after.reviews.find((r) => r.reviewId === mine.reviewId);
    expect(stillMine.rating).toBe(3);
    expect(stillMine.content).toBe('F6 최초 작성');
    expect(stillMine.createdAt).toBe(mine.createdAt);
    expect(after.reviewCount).toBe(countAfterFirst); // 중복 시도가 거절돼 개수가 늘지 않았다

    await deleteReviewAs(context, mine.reviewId);
    await logout(context);
  });

  test('같은 계정이 다른 상품에는 쓸 수 있다 — 중복 판정은 (상품, 계정) 짝이다 [D45 · F7]', async () => {
    const acc = await createAccount('f7');
    await loginAs(context, acc.email, acc.password);
    const onPrimary = await postReviewAs(context, PRIMARY, 4, 'F7 상품A');
    const onSecond = await postReviewAs(context, SECOND, 2, 'F7 상품B');
    expect(onPrimary.status).toBe(201);
    expect(onSecond.status).toBe(201);

    const minePrimary = onPrimary.body.reviews.find((r) => r.email === acc.email);
    const mineSecond = onSecond.body.reviews.find((r) => r.email === acc.email);
    await deleteReviewAs(context, minePrimary.reviewId);
    await deleteReviewAs(context, mineSecond.reviewId);
    await logout(context);
  });

  test('🔑 이미 쓴 상품에 평점 0점으로 다시 시도하면 "이미 작성했습니다"가 아니라 평점 안내가 나온다 [30.8 · F8]', async () => {
    const acc = await createAccount('f8');
    await loginAs(context, acc.email, acc.password);
    const first = await postReviewAs(context, PRIMARY, 3, 'F8 최초 작성');
    const mine = first.body.reviews.find((r) => r.email === acc.email);

    const invalidDup = await postReviewAs(context, PRIMARY, 0, 'F8 잘못된 평점으로 재시도');
    expect(invalidDup.status).toBe(400);
    expect(errMsg(invalidDup.body)).toBe(RATING_ERROR);
    expect(errMsg(invalidDup.body)).not.toBe(REVIEW_DUPLICATE_ERROR);

    await deleteReviewAs(context, mine.reviewId);
    await logout(context);
  });
});

// ===========================================================================
// 시나리오 5: 작성 화면에서 브라우저가 전송을 막지 않는지 확인하는 QA
// [PRD 28.4/28.6/28.7/28.10 · F9/F11/F12]
// ===========================================================================
test.describe('시나리오: 작성 화면에서 브라우저가 전송을 막지 않는지 확인하는 QA', () => {
  test('로그인 상태이고 내 리뷰가 없으면 폼이 보이고, 입력 요소는 평점 선택 상자와 본문 입력란 두 개뿐이다 [28.4]', async () => {
    const acc = await createAccount('f94');
    await loginAs(context, acc.email, acc.password);
    await page.goto(`/product.html?id=${PRIMARY}`);
    await expect(page.getByTestId('review-form')).toBeVisible();

    const form = page.getByTestId('review-form');
    await expect(form.locator('select, textarea, input')).toHaveCount(2);
    await expect(page.getByTestId('review-rating-select')).toHaveCount(1);
    await expect(page.getByTestId('review-content-input')).toHaveCount(1);
    await logout(context);
  });

  test('평점 선택 상자는 선택지 6개(빈 값 포함)이고 처음엔 빈 값, 본문은 비어 있고 안내 글씨가 없다 [28.4]', async () => {
    const acc = await createAccount('f94b');
    await loginAs(context, acc.email, acc.password);
    await page.goto(`/product.html?id=${PRIMARY}`);

    const select = page.getByTestId('review-rating-select');
    await expect(select.locator('option')).toHaveCount(6);
    await expect(select).toHaveValue('');

    const content = page.getByTestId('review-content-input');
    await expect(content).toHaveValue('');
    await expect(content).not.toHaveAttribute('placeholder', /.+/);
    await logout(context);
  });

  test('별점 아이콘 위젯·슬라이더·평점 분포 그래프가 없다 — 평점 입력은 선택 상자 하나다 [28.4]', async () => {
    const acc = await createAccount('f94c');
    await loginAs(context, acc.email, acc.password);
    await page.goto(`/product.html?id=${PRIMARY}`);
    const form = page.getByTestId('review-form');
    await expect(form.locator('input[type="range"]')).toHaveCount(0);
    await expect(page.locator('[data-testid*="star" i]')).toHaveCount(0);
    await expect(page.locator('[data-testid*="distribution" i]')).toHaveCount(0);
    await logout(context);
  });

  test('🚨 본문 입력란에 글자 수 제한·필수 입력·형식 검사 속성이 하나도 붙어있지 않다 [28.7 · F11]', async () => {
    const acc = await createAccount('f11a');
    await loginAs(context, acc.email, acc.password);
    await page.goto(`/product.html?id=${PRIMARY}`);

    const content = page.getByTestId('review-content-input');
    expect(await content.evaluate((el) => el.hasAttribute('maxlength'))).toBe(false);
    expect(await content.evaluate((el) => el.hasAttribute('required'))).toBe(false);
    expect(await content.evaluate((el) => el.hasAttribute('pattern'))).toBe(false);

    const select = page.getByTestId('review-rating-select');
    expect(await select.evaluate((el) => el.hasAttribute('required'))).toBe(false);
    await logout(context);
  });

  test('평점을 고르지 않고 제출하면 요청이 실제로 서버까지 나가고, 평점 안내가 화면에 뜬다 [28.6 · F9]', async () => {
    const acc = await createAccount('f9');
    await loginAs(context, acc.email, acc.password);
    await page.goto(`/product.html?id=${PRIMARY}`);

    const posts = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith(reviewsUrl(PRIMARY))) posts.push(req);
    });

    await page.getByTestId('review-content-input').fill('F9 평점 미선택 제출');
    await page.getByTestId('review-submit').click();

    await expect(page.getByTestId('review-error')).toBeVisible();
    await expect(page.getByTestId('review-error')).toHaveText(RATING_ERROR);
    expect(posts.length).toBe(1);
    await expect(page.getByTestId('review-submit')).toBeEnabled(); // 영구히 잠기지 않는다
    await logout(context);
  });

  test('본문에 501자를 실제로 입력할 수 있고, 제출하면 길이 안내가 뜬다 [28.7 · F11]', async () => {
    const acc = await createAccount('f11b');
    await loginAs(context, acc.email, acc.password);
    await page.goto(`/product.html?id=${PRIMARY}`);

    await page.getByTestId('review-rating-select').selectOption('3');
    const longText = 'd'.repeat(501);
    await page.getByTestId('review-content-input').fill(longText);
    expect(await page.getByTestId('review-content-input').inputValue()).toHaveLength(501);

    await page.getByTestId('review-submit').click();
    await expect(page.getByTestId('review-error')).toHaveText(CONTENT_LENGTH_ERROR);
    await logout(context);
  });

  test('제출 버튼을 연속으로 세 번 눌러도 요청은 한 건만 나간다 [28.10 · F12]', async () => {
    const acc = await createAccount('f12');
    await loginAs(context, acc.email, acc.password);
    await page.goto(`/product.html?id=${PRIMARY}`);

    await page.getByTestId('review-rating-select').selectOption('5');
    await page.getByTestId('review-content-input').fill('F12 연속 클릭 방지 확인');

    const posts = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith(reviewsUrl(PRIMARY))) posts.push(req);
    });

    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="review-submit"]');
      b.click();
      b.click();
      b.click();
    });
    await page.waitForLoadState('networkidle');

    expect(posts.length).toBe(1);

    const snap = await (await context.request.get(reviewsUrl(PRIMARY))).json();
    const mine = snap.reviews.find((r) => r.email === acc.email);
    await deleteReviewAs(context, mine.reviewId);
    await logout(context);
  });
});

// ===========================================================================
// 시나리오 6: 작성 화면에서 성공/실패를 겪는 사람
// [PRD 28.8/28.9/28.12/27.12/31.8 · F16/F17/H9]
// ===========================================================================
test.describe('시나리오: 작성 화면에서 성공/실패를 겪는 사람', () => {
  test('작성 성공 시 화면이 이동하지 않고 전체 목록으로 즉시 다시 그려지며, 조회를 다시 하지 않는다 [28.8/27.3 · F16]', async () => {
    const acc = await createAccount('f16');
    await loginAs(context, acc.email, acc.password);

    const gets = [];
    page.on('request', (req) => {
      if (req.method() === 'GET' && req.url().endsWith(reviewsUrl(PRIMARY))) gets.push(req);
    });

    await page.goto(`/product.html?id=${PRIMARY}`); // 이 goto의 로드 1건이 gets[0]이 된다

    await page.getByTestId('review-rating-select').selectOption('4');
    await page.getByTestId('review-content-input').fill('F16 성공 흐름 확인');
    await page.getByTestId('review-submit').click();

    await expect(page.getByTestId('review-form')).toBeHidden(); // 내 리뷰가 생겨 폼이 사라진다
    await expect(page).toHaveURL(new RegExp(`/product\\.html\\?id=${PRIMARY}$`)); // 이동하지 않음

    const row = page.getByTestId('review-item').filter({ hasText: 'F16 성공 흐름 확인' });
    await expect(row.getByTestId('review-item-edit')).toHaveCount(1);
    await expect(row.getByTestId('review-item-delete')).toHaveCount(1);

    expect(gets.length).toBe(1); // 처음 한 건뿐 — 작성 후 재조회하지 않는다

    const snap = await (await context.request.get(reviewsUrl(PRIMARY))).json();
    const mine = snap.reviews.find((r) => r.email === acc.email);
    await deleteReviewAs(context, mine.reviewId);
    await logout(context);
  });

  test('작성 성공 후 평균·개수가 즉시 바뀌고, 입력했던 평점·본문은 초기 상태로 되돌아간다 [28.8 · F16]', async () => {
    const acc = await createAccount('f16b');
    await loginAs(context, acc.email, acc.password);
    // 절대값(0개 → 1개, 2점)이 아니라, 지금 상태를 기준으로 "내 평점 2가 더해지면 어떻게 되는지"를
    // 직접 계산해서 기대값을 만든다 — PRIMARY가 이미 다른 리뷰를 갖고 있어도 안전하다 (F2와 같은 이유).
    const before = await (await context.request.get(reviewsUrl(PRIMARY))).json();
    const expectedCount = before.reviewCount + 1;
    const priorSum = before.reviews.reduce((sum, r) => sum + r.rating, 0);
    const expectedAverage = Math.round(((priorSum + 2) / expectedCount) * 10) / 10;

    await page.goto(`/product.html?id=${PRIMARY}`);
    await expect(page.getByTestId('review-count')).toHaveText(String(before.reviewCount));
    await page.getByTestId('review-rating-select').selectOption('2');
    await page.getByTestId('review-content-input').fill('F16b 평균 갱신 확인');
    await page.getByTestId('review-submit').click();

    await expect(page.getByTestId('review-count')).toHaveText(String(expectedCount));
    await expect(page.getByTestId('review-average')).toHaveText(`${expectedAverage}점`);

    // 내 리뷰를 지우면 폼이 다시 보이는데, 그때 입력이 비어있어야 한다
    const snap = await (await context.request.get(reviewsUrl(PRIMARY))).json();
    const mine = snap.reviews.find((r) => r.email === acc.email);
    await deleteReviewAs(context, mine.reviewId);
    await page.reload();
    await expect(page.getByTestId('review-rating-select')).toHaveValue('');
    await expect(page.getByTestId('review-content-input')).toHaveValue('');
    await logout(context);
  });

  test('작성이 실패하면 서버 안내가 그대로 표시되고 입력값은 지워지지 않으며, 목록·평균·개수는 실패 전 그대로다 [28.9 · F17]', async () => {
    const author = await createAccount('f17author');
    await loginAs(context, author.email, author.password);
    const seed = await postReviewAs(context, PRIMARY, 5, 'F17 기준 리뷰');
    const seedId = seed.body.reviews.find((r) => r.email === author.email).reviewId;
    // 절대값('1', '5점')이 아니라 "기준 리뷰를 심은 직후 서버가 돌려준 실제 값"을 기대값으로 쓴다
    // (F2와 같은 이유 — PRIMARY에 이미 다른 리뷰가 있어도 안전하다).
    const countAfterSeed = seed.body.reviewCount;
    const averageAfterSeed = seed.body.averageRating;
    await logout(context);

    const acc = await createAccount('f17');
    await loginAs(context, acc.email, acc.password);
    await page.goto(`/product.html?id=${PRIMARY}`);
    await expect(page.getByTestId('review-count')).toHaveText(String(countAfterSeed));

    await page.getByTestId('review-content-input').fill('F17 실패해도 유지되는 입력값');
    await page.getByTestId('review-submit').click(); // 평점 미선택 → 400 실패

    await expect(page.getByTestId('review-error')).toHaveText(RATING_ERROR);
    await expect(page.getByTestId('review-content-input')).toHaveValue('F17 실패해도 유지되는 입력값');
    await expect(page.getByTestId('review-form')).toBeVisible();
    await expect(page.getByTestId('review-count')).toHaveText(String(countAfterSeed)); // 담기지 않았으므로 그대로
    await expect(page.getByTestId('review-average')).toHaveText(`${averageAfterSeed}점`);

    await logout(context);
    await loginAs(context, author.email, author.password);
    await deleteReviewAs(context, seedId);
    await logout(context);
  });

  test('쓰는 사이 세션이 끊겨 거절되면 작성 영역이 로그인 안내로 바뀌지만, 헤더의 로그인 영역은 건드리지 않는다 [28.9]', async () => {
    const acc = await createAccount('f179');
    await loginAs(context, acc.email, acc.password);
    await page.goto(`/product.html?id=${PRIMARY}`);
    await expect(page.getByTestId('auth-user-email')).toHaveText(acc.email);

    // 화면은 로그인된 것처럼 보이지만, 리뷰 작성 요청만 401로 가로채 "쓰는 사이 세션 만료"를 재현한다.
    await page.route(reviewsUrl(PRIMARY), (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: LOGIN_REQUIRED_ERROR } }),
        });
      }
      return route.continue();
    });

    await page.getByTestId('review-rating-select').selectOption('3');
    await page.getByTestId('review-content-input').fill('세션 끊김 시뮬레이션');
    await page.getByTestId('review-submit').click();

    await expect(page.getByTestId('review-login-notice')).toBeVisible();
    await expect(page.getByTestId('review-form')).toBeHidden();
    // 헤더는 리뷰 영역 책임이 아니므로 그대로 로그인 상태를 유지한다
    await expect(page.getByTestId('auth-user-email')).toHaveText(acc.email);
    await expect(page.getByTestId('auth-guest')).toBeHidden();

    await page.unroute(reviewsUrl(PRIMARY));
    await logout(context);
  });

  test('모든 실패(400·401·403·404·409·500)가 에러 안내 자리 하나를 공유한다 [28.9/31.8]', async () => {
    const acc = await createAccount('f3118');
    await loginAs(context, acc.email, acc.password);
    const first = await postReviewAs(context, PRIMARY, 5, 'F31.8 중복 유발용');
    const mine = first.body.reviews.find((r) => r.email === acc.email);

    await page.goto(`/product.html?id=${PRIMARY}`);
    await expect(page.getByTestId('review-error')).toHaveCount(1); // 자리는 하나뿐

    await deleteReviewAs(context, mine.reviewId);
    await logout(context);
  });

  test('작성에 확인 단계가 없다 — 확인창이나 모달이 뜨지 않는다 [28.12]', async () => {
    const acc = await createAccount('f2812');
    await loginAs(context, acc.email, acc.password);
    await page.goto(`/product.html?id=${PRIMARY}`);

    let dialogFired = false;
    page.on('dialog', () => {
      dialogFired = true;
    });
    await page.getByTestId('review-rating-select').selectOption('1');
    await page.getByTestId('review-content-input').fill('확인 단계 없음 확인');
    await page.getByTestId('review-submit').click();
    await expect(page.getByTestId('review-form')).toBeHidden();
    expect(dialogFired).toBe(false);

    const snap = await (await context.request.get(reviewsUrl(PRIMARY))).json();
    const mine = snap.reviews.find((r) => r.email === acc.email);
    await deleteReviewAs(context, mine.reviewId);
    await logout(context);
  });

  test('리뷰를 쓰는 동안 주변(상품명·가격·설명·장바구니 배지·헤더 이메일)이 하나도 바뀌지 않는다 [27.12 · H9]', async () => {
    const acc = await createAccount('h9');
    await loginAs(context, acc.email, acc.password);
    await context.request.delete('/api/cart');
    await context.request.post('/api/cart/items', { data: { productId: PRIMARY, quantity: 2 } });

    await page.goto(`/product.html?id=${PRIMARY}`);
    await expect(page.getByTestId('product-detail')).toBeVisible();
    const nameBefore = await page.getByTestId('detail-name').textContent();
    const priceBefore = await page.getByTestId('detail-price').textContent();
    const descBefore = await page.getByTestId('detail-description').textContent();
    const badgeBefore = await page.getByTestId('cart-count').textContent();
    const emailBefore = await page.getByTestId('auth-user-email').textContent();
    const urlBefore = page.url();

    await page.getByTestId('review-rating-select').selectOption('5');
    await page.getByTestId('review-content-input').fill('H9 주변 불변 확인');
    await page.getByTestId('review-submit').click();
    await expect(page.getByTestId('review-form')).toBeHidden();

    expect(await page.getByTestId('detail-name').textContent()).toBe(nameBefore);
    expect(await page.getByTestId('detail-price').textContent()).toBe(priceBefore);
    expect(await page.getByTestId('detail-description').textContent()).toBe(descBefore);
    expect(await page.getByTestId('cart-count').textContent()).toBe(badgeBefore);
    expect(await page.getByTestId('auth-user-email').textContent()).toBe(emailBefore);
    expect(page.url()).toBe(urlBefore);

    const snap = await (await context.request.get(reviewsUrl(PRIMARY))).json();
    const mine = snap.reviews.find((r) => r.email === acc.email);
    await deleteReviewAs(context, mine.reviewId);
    await context.request.delete('/api/cart');
    await logout(context);
  });
});
