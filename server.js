'use strict';

/**
 * 쇼핑몰 서버 (상품 목록 / 상품 상세 / 장바구니 / 모의 결제 / 회원가입·로그인).
 *
 * PRD(_workspace/01_planner_prd.md) Tech stack 확정값:
 * - Node.js 20+ / Express, 단일 서버 / 단일 포트 3000
 * - public/ 정적 서빙 + 같은 오리진에서 /api/* 제공 (CORS 불필요)
 * - 이번 범위의 API는 GET /api/products + 2차 신규 5개 + 3차 신규 1개 + 4차 신규 2개 + 5차 신규 4개
 *   + 6차 신규 4개 = 총 17개 (PRD 30.14)
 *   3차 신규: DELETE /api/cart (장바구니 전체 비우기, PRD 13.1)
 *   4차 신규: POST /api/checkout (모의 결제, PRD 18.1), GET /api/orders/:orderId (주문 조회, PRD 18.9)
 *   5차 신규: POST /api/auth/signup, POST /api/auth/login, POST /api/auth/logout, GET /api/auth/me (PRD 24장)
 *   6차 신규: GET/POST /api/products/:productId/reviews, PATCH/DELETE /api/reviews/:reviewId (PRD 30장)
 *   실제 PG 연동, 주문 목록 조회, 취소/환불, DB, 소셜 로그인, 리뷰-주문 연결 등은 여전히 만들지 않는다
 *   (PRD 24.14 / 30.14).
 * - 3차 사이클: 줄 수량 10개 이상이면 그 줄에 10% 자동 할인 (PRD 12장).
 *   할인 계산은 buildCartSnapshot() 한 곳에서만 한다 (PRD 3차 스택 보강).
 * - 4차 사이클: 결제 승인/거절은 요청의 paymentMethod 값만으로 결정론적으로 판정한다.
 *   Math.random()/시각/금액을 판정에 쓰지 않는다 (PRD 18.3 / D17).
 * - 5차 사이클: 회원가입/로그인/로그아웃은 DB 없는 인메모리 Map + crypto.scrypt 해시로 구현한다
 *   (PRD D26~D30). **`cartId`와 `sessionId`는 완전히 독립이다** — `/api/auth/*`는
 *   `ensureCartId()`를 호출하지 않고, 기존 9개 엔드포인트는 `sessionId`를 읽지 않는다 (PRD D27 / 24.13).
 *   이 분리가 docs/bug-history/2026-08-08_cart-session-race-condition.md(M4) 재발을 막는
 *   유일한 근거다 — cartId를 발급하는 코드 경로가 끝까지 하나뿐이어야 한다.
 * - 6차 사이클: 상품 리뷰/평점. 조회(`GET`)는 비로그인도 200, 쓰기(`POST`/`PATCH`/`DELETE`)만
 *   401 (PRD D40). 남의 리뷰를 건드리면 **404가 아니라 403**이다 (PRD D46 — 주문 조회가
 *   둘 다 404인 것과 일부러 다르다). 리뷰 엔드포인트도 `ensureCartId()`를 호출하지 않는다
 *   (PRD 30.15 — M4 재발 차단 원칙의 연장). 공용 500 에러 핸들러에 리뷰 분기를 추가할 때
 *   `/api/products/:productId/reviews`가 `/api/products` 접두어를 공유하므로 **분기 순서**가
 *   중요하다 — docs/bug-history/2026-08-08_generic-error-message-leak.md(M5)의 세 번째 재발
 *   지점이며, 이번엔 "경로 접두어 공유" 형태로 온다 (PRD 30.18).
 *
 * 응답 shape은 _workspace/02_backend_api-spec.md 에 문서화되어 있다.
 * shape을 바꿔야 하면 문서를 먼저 고치고 frontend-agent에게 알린다.
 */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { products } = require('./data/products');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// ---------------------------------------------------------------------------
// 정적 파일 (프론트엔드) — public/index.html, /images/* 등
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// JSON body 파싱 — POST /api/cart/items, PATCH /api/cart/items/:productId 용
// (PRD 2차 스택 보강: "요청 body 파싱 → express.json() 미들웨어 추가")
// ---------------------------------------------------------------------------
app.use(express.json());

// 깨진 JSON body가 들어오면 500이 아니라 400 + { error: { message } } 로 응답한다.
// (express.json()이 던지는 에러를 여기서 먼저 받는다. 라우트보다 위에 있어야 한다.)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    res.status(400).json({
      error: { message: '요청 본문(JSON)을 해석할 수 없습니다.' },
    });
    return;
  }
  next(err);
});

// ---------------------------------------------------------------------------
// GET /api/products — 상품 목록
//
// 200: { "items": [ { id, name, price, imageUrl, description }, ... ] }
//      * 항상 items 로 래핑한다. top-level 배열로 반환하지 않는다 (PRD 3.1)
//      * 상품이 0개여도 200 + { "items": [] } (PRD 3.2)
// 5xx: { "error": { "message": "..." } } (PRD 3.4)
//
// 테스트 훅(개발/QA 전용, 기본은 꺼져 있음):
//   ?simulate=empty  → 200 { "items": [] }   (프론트 빈 상태 2.2 검증용)
//   ?simulate=error  → 500 { "error": {...} } (프론트 에러 상태 2.3 검증용)
// 쿼리를 붙이지 않으면 언제나 시드 상품 전체를 반환한다.
// ---------------------------------------------------------------------------
app.get('/api/products', (req, res, next) => {
  try {
    const simulate = req.query.simulate;

    if (simulate === 'error') {
      throw new Error('simulated failure');
    }

    const items = simulate === 'empty' ? [] : products;

    // 필드 순서/이름을 고정해 응답한다 (프론트가 신뢰하는 계약).
    res.status(200).json({
      items: items.map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        imageUrl: p.imageUrl,
        description: p.description,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// 2차 사이클 추가분 — 상품 상세 + 장바구니 (PRD 9장)
//
// 아래 라우트들은 반드시 "/api 미정의 경로 404 핸들러"보다 위에 있어야 한다.
// 아래로 내려가면 catch-all이 먼저 잡아서 전부 404가 된다.
// ===========================================================================

// --- 장바구니 상수 (PRD 9.9 / 9.11, 데이터 모델 "세션 쿠키" 표) ----------------
const CART_COOKIE_NAME = 'cartId';
const CART_COOKIE_MAX_AGE = 604800; // 7일(초). PRD 8.4
const MIN_QUANTITY = 1;
const MAX_QUANTITY = 99; // 재고가 아니라 입력값 상한이다 (PRD Out of scope)

// --- 수량 기반 자동 할인 상수 (PRD 12.15 / 3차 스택 보강) ---------------------
// 이 두 값이 할인 규칙의 유일한 출처다. 다른 곳에 10을 하드코딩하지 않는다.
// 프론트도 숫자를 직접 쓰지 않고 응답의 discountPercent를 그대로 쓴다.
const DISCOUNT_MIN_QUANTITY = 10; // 이 수량 "이상"이면 할인 (>= 이다. > 가 아니다 — PRD 12.2)
const DISCOUNT_PERCENT = 10; // 퍼센트 정수. 0.1 같은 비율(rate)이 아니다

/**
 * 장바구니 저장소 — Map<cartId, CartItem[]>.
 *
 * PRD D6: 서버 프로세스 메모리에만 보관한다. DB 없음.
 * 서버를 재시작하면 장바구니가 비워져도 되며 그것은 버그가 아니다 (PRD 8.7).
 * 각 CartItem은 담을 때 상품 정보를 복사(비정규화)해서 들고 있는다 —
 * 그래야 장바구니 화면이 줄마다 상품 API를 다시 호출하지 않는다 (PRD CartItem 주석).
 *   내부 저장 형태: { productId, name, price, imageUrl, quantity }
 *   lineTotal·할인 필드 5개는 저장하지 않고 응답을 만들 때 계산한다 (PRD 13.7).
 *   할인은 수량에서 파생되는 값이라 저장해두면 수량 변경 시 낡은 값이 남는다.
 */
const carts = new Map();

/**
 * 주문 저장소 — Map<orderId, Order>.
 *
 * PRD D21: 승인에 성공한 결제만 주문이 된다. 402(거절)/400(검증 실패)/409(빈 장바구니)에서는
 * 저장하지 않는다. 서버 프로세스 메모리에만 보관한다 (PRD 8.7과 같은 D6 계열 결정 — DB 없음).
 *
 * 저장 형태는 응답에 나가는 9개 필드 + 서버 내부 전용 cartId 총 10개다.
 *   { orderId, status, ordererName, ordererPhone, paymentMethod,
 *     items, totalQuantity, totalPrice, createdAt, cartId }
 * cartId는 18.9의 소유자 판정(GET /api/orders/:orderId)에만 쓰이고,
 * 응답에는 절대 포함하지 않는다 — HttpOnly 쿠키로만 다뤄지는 값이다 (PRD 8.6 / 데이터 모델 주석).
 */
const orders = new Map();

/** 요청 헤더의 Cookie 문자열을 { name: value } 로 파싱한다. */
function parseCookies(cookieHeader) {
  const jar = {};
  if (!cookieHeader) {
    return jar;
  }
  for (const part of String(cookieHeader).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    if (!name) {
      continue;
    }
    jar[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return jar;
}

/**
 * 요청의 cartId를 확정한다. 쿠키가 없으면 즉시 새로 발급하고 Set-Cookie를 실어준다 (PRD 8.2 / 9.11).
 * 쿠키 속성: Path=/, HttpOnly, SameSite=Lax, Max-Age=604800.
 * Secure는 붙이지 않는다 — http://localhost에서 쿠키가 저장되지 않아 장바구니가 매 요청 초기화된다.
 */
function ensureCartId(req, res) {
  const existing = parseCookies(req.headers.cookie)[CART_COOKIE_NAME];
  if (existing) {
    return existing;
  }

  const cartId = crypto.randomUUID();
  res.append(
    'Set-Cookie',
    `${CART_COOKIE_NAME}=${cartId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${CART_COOKIE_MAX_AGE}`
  );
  return cartId;
}

/** 해당 cartId의 줄 배열을 돌려준다. 없으면 빈 배열을 만들어 등록한다. */
function getCartItems(cartId) {
  let items = carts.get(cartId);
  if (!items) {
    items = [];
    carts.set(cartId, items);
  }
  return items;
}

/**
 * 장바구니 한 줄의 응답 형태를 만든다 (PRD "CartItem" 모델 — 필드 11개).
 *
 * 3차 사이클 할인 계산 (PRD 12.5 / 13.6 / 13.7):
 *   discountApplied     = quantity >= DISCOUNT_MIN_QUANTITY   // 10 "포함"
 *   discountPercent     = 적용 시 10, 미적용 시 0
 *   lineSubtotal        = price * quantity                    // 할인 "전" 줄 금액
 *   discountedUnitPrice = 적용 시 price - floor(price * 10 / 100), 미적용 시 price
 *   lineTotal           = discountedUnitPrice * quantity      // 할인 "후" 최종 줄 금액
 *   discountAmount      = lineSubtotal - lineTotal
 *
 * ⚠️ lineTotal의 의미가 2차와 달라졌다. 2차: price * quantity(할인 전) →
 *    3차: discountedUnitPrice * quantity(할인 후). 할인 전 금액은 lineSubtotal이 담는다.
 *
 * 단가를 먼저 깎고 수량을 곱한다 (PRD D12). 줄 합계를 먼저 만든 뒤 깎으면
 * 화면의 "할인 단가 × 수량"이 화면의 "줄 합계"와 어긋나는 줄이 생긴다.
 * 1원 미만은 Math.floor로 버린다 — 모든 금액 필드는 원 단위 정수다.
 *
 * 할인 필드 5개는 미적용 줄에서도 항상 채운다 (생략·null 금지 — PRD 13.6).
 * 미적용 시: discountApplied=false, discountPercent=0, discountedUnitPrice=price,
 *           discountAmount=0, lineTotal=lineSubtotal.
 */
function buildCartLine(item) {
  const { price, quantity } = item;

  const discountApplied = quantity >= DISCOUNT_MIN_QUANTITY;
  const discountPercent = discountApplied ? DISCOUNT_PERCENT : 0;
  const lineSubtotal = price * quantity;
  const discountedUnitPrice = discountApplied
    ? price - Math.floor((price * DISCOUNT_PERCENT) / 100)
    : price;
  const lineTotal = discountedUnitPrice * quantity;
  const discountAmount = lineSubtotal - lineTotal;

  // 필드 순서는 PRD "3차 추가분" 응답 예시와 동일하게 고정한다 (프론트가 신뢰하는 계약).
  return {
    productId: item.productId,
    name: item.name,
    price,
    imageUrl: item.imageUrl,
    quantity,
    lineSubtotal,
    discountApplied,
    discountPercent,
    discountedUnitPrice,
    discountAmount,
    lineTotal,
  };
}

/**
 * 응답용 장바구니 스냅샷을 만든다 (PRD "Cart" 모델).
 * 줄 단위 6개(lineSubtotal/discountApplied/discountPercent/discountedUnitPrice/
 * discountAmount/lineTotal) + 장바구니 단위 2개(totalQuantity/totalPrice)를
 * 전부 서버가 계산한다 (PRD 13.7) — 프론트는 포맷팅만 한다.
 *
 * 장바구니를 반환하는 5개 엔드포인트(GET /api/cart, POST /api/cart/items,
 * PATCH·DELETE /api/cart/items/:productId, DELETE /api/cart)가 모두 이 함수를 쓴다 (PRD 13.5).
 * 할인 로직이 여기 한 곳에만 있으므로 엔드포인트별로 값이 어긋날 수 없다.
 *
 * totalPrice는 "할인 후" lineTotal들의 합이다 (PRD 12.6). lineSubtotal의 합이 아니다.
 * totalQuantity는 할인과 무관하게 quantity의 단순 합이다.
 * cart에는 totalDiscount / totalSubtotal 같은 할인 요약 필드를 두지 않는다 (PRD 데이터 모델).
 * 줄 순서는 처음 담은 순서를 유지한다 — 할인이 켜지고 꺼져도 줄 위치가 튀지 않는다.
 */
function buildCartSnapshot(items) {
  const lines = items.map(buildCartLine);

  return {
    cart: {
      items: lines,
      totalQuantity: lines.reduce((sum, l) => sum + l.quantity, 0),
      totalPrice: lines.reduce((sum, l) => sum + l.lineTotal, 0),
    },
  };
}

/** 에러 응답 헬퍼 — 모든 에러는 { error: { message } } 형태다 (PRD 9.13). */
function sendError(res, status, message) {
  res.status(status).json({ error: { message } });
}

/** quantity가 1 이상 99 이하의 정수인지 검사한다 (PRD 9.9). 0도 소수도 문자열 "2"도 전부 false. */
function isValidQuantity(value) {
  return Number.isInteger(value) && value >= MIN_QUANTITY && value <= MAX_QUANTITY;
}

const QUANTITY_ERROR = `수량은 ${MIN_QUANTITY} 이상 ${MAX_QUANTITY} 이하의 정수여야 합니다.`;

// --- 모의 결제 상수/검증 (PRD 18.1~18.5) --------------------------------------
const ORDERER_NAME_MIN_LENGTH = 1;
const ORDERER_NAME_MAX_LENGTH = 30;

// 확정값 (PRD 18.5 코드 블록 — 표 안의 파이프 이스케이프가 아니라 이 정규식이 기준이다).
// 하이픈이 전부 있거나(010-1234-5678) 전부 없거나(01012345678) 둘 중 하나만 허용한다.
const ORDERER_PHONE_PATTERN = /^(01\d-\d{3,4}-\d{4}|01\d\d{7,8})$/;

// 모의 결제 판정에 쓰이는 유일한 두 값 (PRD 16.7 / 18.3). Math.random()은 쓰지 않는다.
const PAYMENT_METHOD_SUCCESS = 'MOCK_SUCCESS';
const PAYMENT_METHOD_FAILURE = 'MOCK_FAILURE';
const VALID_PAYMENT_METHODS = new Set([PAYMENT_METHOD_SUCCESS, PAYMENT_METHOD_FAILURE]);

const ORDERER_NAME_ERROR = `주문자 이름을 ${ORDERER_NAME_MIN_LENGTH}자 이상 ${ORDERER_NAME_MAX_LENGTH}자 이하로 입력해 주세요.`;
const ORDERER_PHONE_ERROR = '연락처를 올바른 휴대폰 번호 형식으로 입력해 주세요.';
const PAYMENT_METHOD_ERROR = '결제 수단을 선택해 주세요.';
const CHECKOUT_DECLINED_ERROR = '결제가 승인되지 않았습니다. 다른 결제 수단으로 다시 시도해 주세요.';
const EMPTY_CART_ERROR = '장바구니가 비어 있어 결제할 수 없습니다.';
const ORDER_NOT_FOUND_ERROR = '주문을 찾을 수 없습니다.';

/** ordererName이 trim 후 1~30자인지 검사한다 (PRD 18.5). */
function isValidOrdererName(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return trimmed.length >= ORDERER_NAME_MIN_LENGTH && trimmed.length <= ORDERER_NAME_MAX_LENGTH;
}

/** ordererPhone이 trim 후 확정 정규식과 일치하는지 검사한다 (PRD 18.5). */
function isValidOrdererPhone(value) {
  if (typeof value !== 'string') {
    return false;
  }
  return ORDERER_PHONE_PATTERN.test(value.trim());
}

/** paymentMethod가 두 모의 값 중 하나인지 검사한다 (PRD 16.7). */
function isValidPaymentMethod(value) {
  return typeof value === 'string' && VALID_PAYMENT_METHODS.has(value);
}

const ORDER_ID_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** UTC 기준 YYYYMMDD 문자열을 만든다 (PRD Order.orderId 형식). */
function formatUtcDateStamp(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** 대문자 영문+숫자 6자리를 만든다 (crypto 기반 — Math.random() 아님). */
function randomOrderSuffix() {
  let suffix = '';
  for (let i = 0; i < 6; i += 1) {
    suffix += ORDER_ID_CHARSET[crypto.randomInt(ORDER_ID_CHARSET.length)];
  }
  return suffix;
}

/**
 * `ORD-YYYYMMDD-XXXXXX` 형식의 주문번호를 발급한다 (PRD Order.orderId).
 * 이미 존재하는 키와 충돌하면 접미사를 다시 뽑는다 — 판정(승인/거절)과는 무관한
 * 키 발급 로직이므로 여기서 난수를 쓰는 것은 18.3(판정에 난수 금지)과 별개다.
 */
function generateOrderId(now) {
  const datePart = formatUtcDateStamp(now);
  let orderId;
  do {
    orderId = `ORD-${datePart}-${randomOrderSuffix()}`;
  } while (orders.has(orderId));
  return orderId;
}

/** 저장된 Order에서 서버 내부 전용 cartId를 제거한 응답용 객체를 만든다 (PRD 8.6). */
function toOrderResponse(order) {
  const { cartId, ...publicOrder } = order;
  return publicOrder;
}

// ---------------------------------------------------------------------------
// GET /api/products/:id — 상품 상세 (PRD 9.1 / 9.2)
//
// 200: { "item": { id, name, price, imageUrl, description } }
//      * 상품 객체를 top-level로 그대로 반환하지 않는다. 항상 item으로 래핑 (9.1)
// 404: { "error": { "message": "상품을 찾을 수 없습니다." } }
//      * 200 + 빈 객체로 내려보내지 않는다 (9.2)
// ---------------------------------------------------------------------------
app.get('/api/products/:id', (req, res, next) => {
  try {
    const product = products.find((p) => p.id === req.params.id);

    if (!product) {
      sendError(res, 404, '상품을 찾을 수 없습니다.');
      return;
    }

    // 목록(GET /api/products)과 동일한 5개 필드만, 동일한 순서로 내려준다.
    res.status(200).json({
      item: {
        id: product.id,
        name: product.name,
        price: product.price,
        imageUrl: product.imageUrl,
        description: product.description,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/cart — 장바구니 조회 (PRD 9.3)
//
// 200: { "cart": { items, totalQuantity, totalPrice } }
//      * 항상 200이다. 비어 있어도 404가 아니라
//        200 + { "cart": { "items": [], "totalQuantity": 0, "totalPrice": 0 } }
//      * 쿠키가 없으면 이 시점에 cartId를 발급한다 (9.11)
// ---------------------------------------------------------------------------
app.get('/api/cart', (req, res, next) => {
  try {
    const cartId = ensureCartId(req, res);
    res.status(200).json(buildCartSnapshot(getCartItems(cartId)));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/cart — 장바구니 전체 비우기 (PRD 13.1, 3차 신규)
//
// 200: { "cart": { "items": [], "totalQuantity": 0, "totalPrice": 0 } }
//      * 204 No Content를 반환하지 않는다 — 프론트가 비워진 스냅샷을 그대로 다시 그려야 한다
//      * 이미 비어 있어도 200 + 빈 장바구니다 (멱등, PRD 13.2). 404도 400도 아니다
//      * cartId 쿠키가 없어도 에러가 아니다 — 쿠키를 발급하고 빈 장바구니를 준다 (PRD 13.3)
//
// ⚠️ 라우팅 주의 (PRD 13.4): 이 라우트는 아래 DELETE /api/cart/items/:productId 보다
// 반드시 "먼저" 등록한다. 경로가 정확히 '/api/cart'일 때만 매칭되므로 파라미터 라우트와
// 겹치지 않으며, 반대로 '/api/cart/items/'(뒤가 빈 요청)가 전체 비우기로 새어들지도 않는다
// (:productId가 빈 문자열을 매칭하지 않으므로 /api 미정의 경로 404 핸들러로 떨어진다).
// ---------------------------------------------------------------------------
app.delete('/api/cart', (req, res, next) => {
  try {
    const cartId = ensureCartId(req, res);

    // 줄 배열 자체를 새로 만들지 않고 비운다 —
    // Map에는 항상 같은 배열 참조가 남아 있어 다른 로직이 들고 있는 참조가 낡지 않는다.
    const items = getCartItems(cartId);
    items.length = 0;

    res.status(200).json(buildCartSnapshot(items));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/cart/items — 장바구니에 담기 (PRD 9.4)
//
// body: { "productId": string, "quantity"?: integer }  quantity 생략 시 1
// 200: 변경 후 장바구니 전체 스냅샷 (조회와 완전히 동일한 shape, 9.7)
// 400: productId 누락/비문자열, quantity가 정수가 아니거나 1~99 밖 (9.9)
// 404: 시드 상품에 없는 productId (9.10)
//
// 같은 상품을 또 담으면 새 줄을 만들지 않고 기존 줄의 수량을 합산한다 (D8 / 6.6).
// 합산 결과가 99를 넘으면 조용히 99로 깎지 않고 400으로 거절한다.
// ---------------------------------------------------------------------------
app.post('/api/cart/items', (req, res, next) => {
  try {
    const body = req.body || {};
    const { productId } = body;

    if (typeof productId !== 'string' || productId.length === 0) {
      sendError(res, 400, '상품 ID(productId)가 필요합니다.');
      return;
    }

    // quantity는 생략 가능하며 그때만 1로 간주한다.
    // 명시적으로 보낸 값이면 null/undefined 여부와 무관하게 정수 검사를 통과해야 한다.
    const quantity = body.quantity === undefined ? 1 : body.quantity;
    if (!isValidQuantity(quantity)) {
      sendError(res, 400, QUANTITY_ERROR);
      return;
    }

    const product = products.find((p) => p.id === productId);
    if (!product) {
      sendError(res, 404, '상품을 찾을 수 없습니다.');
      return;
    }

    const cartId = ensureCartId(req, res);
    const items = getCartItems(cartId);
    const existing = items.find((item) => item.productId === productId);

    if (existing) {
      const merged = existing.quantity + quantity;
      if (merged > MAX_QUANTITY) {
        sendError(res, 400, `한 상품의 수량은 ${MAX_QUANTITY}개를 넘을 수 없습니다.`);
        return;
      }
      existing.quantity = merged;
    } else {
      // 담는 시점의 상품 정보를 복사해 넣는다 (비정규화) — 장바구니 화면이 상품 API를 또 부르지 않도록.
      items.push({
        productId: product.id,
        name: product.name,
        price: product.price,
        imageUrl: product.imageUrl,
        quantity,
      });
    }

    res.status(200).json(buildCartSnapshot(items));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/cart/items/:productId — 줄 수량 변경 (PRD 9.5)
//
// body: { "quantity": integer }  ← 증감분(delta)이 아니라 "변경 후의 절대 수량"이다
// 200: 변경 후 장바구니 전체 스냅샷
// 400: quantity가 정수가 아니거나 1~99 밖. 특히 quantity: 0은 삭제가 아니라 400이다 (9.9)
// 404: 해당 productId 줄이 현재 장바구니에 없을 때 (9.10)
// ---------------------------------------------------------------------------
app.patch('/api/cart/items/:productId', (req, res, next) => {
  try {
    const { productId } = req.params;
    const quantity = (req.body || {}).quantity;

    if (!isValidQuantity(quantity)) {
      sendError(res, 400, QUANTITY_ERROR);
      return;
    }

    const cartId = ensureCartId(req, res);
    const items = getCartItems(cartId);
    const target = items.find((item) => item.productId === productId);

    if (!target) {
      sendError(res, 404, '장바구니에 해당 상품이 없습니다.');
      return;
    }

    // 절대값으로 덮어쓴다. 줄의 위치(순서)는 바뀌지 않는다.
    target.quantity = quantity;

    res.status(200).json(buildCartSnapshot(items));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/cart/items/:productId — 줄 삭제 (PRD 9.6)
//
// 200: 변경 후 장바구니 전체 스냅샷
//      * 204 No Content를 반환하지 않는다 — 프론트가 갱신된 총 수량/총액을 받아야 하기 때문
// 404: 해당 productId 줄이 현재 장바구니에 없을 때 (9.10)
//
// 장바구니에서 항목을 제거하는 경로는 이 엔드포인트 하나뿐이다 (PATCH quantity:0은 400).
// ---------------------------------------------------------------------------
app.delete('/api/cart/items/:productId', (req, res, next) => {
  try {
    const { productId } = req.params;
    const cartId = ensureCartId(req, res);
    const items = getCartItems(cartId);
    const index = items.findIndex((item) => item.productId === productId);

    if (index < 0) {
      sendError(res, 404, '장바구니에 해당 상품이 없습니다.');
      return;
    }

    items.splice(index, 1);

    res.status(200).json(buildCartSnapshot(items));
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// 4차 사이클 추가분 — 모의 결제 (PRD 18장)
//
// 아래 라우트들도 반드시 "/api 미정의 경로 404 핸들러"보다 위에 있어야 한다.
// ===========================================================================

// ---------------------------------------------------------------------------
// POST /api/checkout — 모의 결제 요청 (PRD 18.1~18.8)
//
// body: { "ordererName": string, "ordererPhone": string, "paymentMethod": string }
//       * items/totalPrice/quantity 등 상품·금액 정보는 받지 않는다. 실려 와도 무시한다 (18.1).
// 200: { "order": { ... 9개 필드 ... } }  — 승인 성공(paymentMethod === "MOCK_SUCCESS")
// 402: { "error": { "message": "..." } }  — 승인 거절(paymentMethod === "MOCK_FAILURE"). 장바구니/주문 불변
// 400: { "error": { "message": "..." } }  — 입력 검증 실패
// 409: { "error": { "message": "..." } }  — 현재 장바구니가 비어 있음
//
// 검증 순서: 입력 검증(400) → 빈 장바구니(409) → 승인 판정(402) (PRD 18.5 마지막 항목).
// 승인/거절 판정은 paymentMethod 값만으로 결정론적으로 한다 — Math.random()/시각/금액을
// 절대 쓰지 않는다 (PRD 18.3 / D17).
// ---------------------------------------------------------------------------
app.post('/api/checkout', (req, res, next) => {
  try {
    const body = req.body || {};
    const { ordererName, ordererPhone, paymentMethod } = body;

    if (!isValidOrdererName(ordererName)) {
      sendError(res, 400, ORDERER_NAME_ERROR);
      return;
    }
    if (!isValidOrdererPhone(ordererPhone)) {
      sendError(res, 400, ORDERER_PHONE_ERROR);
      return;
    }
    if (!isValidPaymentMethod(paymentMethod)) {
      sendError(res, 400, PAYMENT_METHOD_ERROR);
      return;
    }

    // 결제 대상/금액은 항상 서버가 현재 장바구니에서 직접 계산한다 (18.1) — body의 값은 이미 무시했다.
    const cartId = ensureCartId(req, res);
    const items = getCartItems(cartId);

    if (items.length === 0) {
      sendError(res, 409, EMPTY_CART_ERROR);
      return;
    }

    if (paymentMethod === PAYMENT_METHOD_FAILURE) {
      // 거절: 주문을 저장하지 않고 orderId도 발급하지 않는다. 장바구니도 비우지 않는다 (18.4).
      sendError(res, 402, CHECKOUT_DECLINED_ERROR);
      return;
    }

    // paymentMethod === PAYMENT_METHOD_SUCCESS (검증을 통과했으므로 이 시점엔 둘 중 하나뿐이다).
    // buildCartSnapshot()을 재사용해 할인 계산(12.5)이 그대로 적용된 스냅샷을 만든다.
    // .map()이 매번 새 줄 객체를 만들어 반환하므로 이 배열은 장바구니의 items 배열과
    // 참조를 공유하지 않는 복사본이다 (18.7 — 장바구니를 비워도 주문 내용이 남는다).
    const snapshot = buildCartSnapshot(items).cart;
    const now = new Date();
    const orderId = generateOrderId(now);

    const order = {
      orderId,
      status: 'PAID',
      ordererName: ordererName.trim(),
      ordererPhone: ordererPhone.trim(),
      paymentMethod,
      items: snapshot.items,
      totalQuantity: snapshot.totalQuantity,
      totalPrice: snapshot.totalPrice,
      createdAt: now.toISOString(),
      cartId, // 서버 내부 전용 — 응답에는 포함하지 않는다 (toOrderResponse가 제거)
    };

    orders.set(orderId, order);

    // 같은 요청 처리 안에서 장바구니를 비운다 (18.7 D19). 배열 참조는 유지한다(기존 패턴과 동일).
    items.length = 0;

    res.status(200).json({ order: toOrderResponse(order) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/orders/:orderId — 주문 1건 조회 (PRD 18.9~18.11)
//
// 200: { "order": { ... } }  — 존재하고, 요청의 cartId 쿠키가 주문의 cartId와 같을 때
// 404: { "error": { "message": "주문을 찾을 수 없습니다." } }
//      * orderId가 없거나 / cartId가 다르거나(쿠키가 아예 없는 경우 포함) 두 경우 모두 동일하게
//        404 + 동일 메시지다 (18.10). 403을 쓰지 않는다 — 존재 여부 자체를 남에게 알리지 않는다 (D23).
// ---------------------------------------------------------------------------
app.get('/api/orders/:orderId', (req, res, next) => {
  try {
    const { orderId } = req.params;
    // 쿠키가 없으면 여기서 새로 발급한다 (18.15가 9.11 규칙을 그대로 따르라고 명시).
    // 새로 발급된 cartId는 어떤 기존 주문과도 일치할 수 없으므로 자연스럽게 404로 이어진다.
    const cartId = ensureCartId(req, res);
    const order = orders.get(orderId);

    if (!order || order.cartId !== cartId) {
      sendError(res, 404, ORDER_NOT_FOUND_ERROR);
      return;
    }

    res.status(200).json({ order: toOrderResponse(order) });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// 5차 사이클 추가분 — 회원가입 / 로그인 / 로그아웃 (PRD 20~26장)
//
// 아래 라우트들도 반드시 "/api 미정의 경로 404 핸들러"보다 위에 있어야 한다.
//
// 🔒 쿠키 분리 규칙 (PRD D27 / 24.13, M4 재발 차단의 핵심 근거):
//   - 이 섹션의 4개 핸들러는 ensureCartId()를 호출하지 않고 cartId 쿠키를 건드리지 않는다.
//   - 반대로 위의 장바구니/결제/주문 9개 핸들러에는 sessionId라는 문자열이 등장하지 않는다.
//   두 쿠키가 서로의 코드 경로에 나타나지 않으면, 모든 화면이 로드 시 GET /api/cart와
//   GET /api/auth/me를 병렬로 호출해도(PRD 20.2/20.9) cartId를 발급하는 경로가 하나뿐이라
//   M4(쿠키 최초 발급 경쟁 조건, docs/bug-history/2026-08-08_cart-session-race-condition.md)가
//   성립할 수 없다.
// ===========================================================================

// --- 인증 상수 (PRD 24.3 / D29 / D35 / D36, 5차 스택 보강) --------------------
const SESSION_COOKIE_NAME = 'sessionId'; // cartId와 다른 이름. cartId를 재사용하지 않는다 (24.16)
const SESSION_TTL_SECONDS = Number(process.env.AUTH_SESSION_TTL_SECONDS) || 604800; // 기본 7일.
// AUTH_SESSION_TTL_SECONDS는 만료 케이스를 재현하기 위한 수단이다 — 인증 우회 백도어가 아니다 (D36).

const PASSWORD_MIN_LENGTH = 4;
const PASSWORD_MAX_LENGTH = 20;
const EMAIL_MAX_LENGTH = 254;

// 확정 정규식 (PRD 24.3 코드 블록이 기준). RFC 5322 완전 준수가 목표가 아니라
// 허용/불허 경계가 유한하고 설명 가능한 것이 목표다.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

// crypto.scrypt 확정 파라미터 (PRD D29). 새 npm 패키지(bcrypt 등)를 추가하지 않는다.
const PASSWORD_SALT_BYTES = 16; // randomBytes(16).hex → 32자
const PASSWORD_HASH_KEYLEN = 64; // scrypt(..., 64).hex → 128자
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

const EMAIL_FORMAT_ERROR = '이메일 형식이 올바르지 않습니다.';
const EMAIL_LENGTH_ERROR = '이메일은 254자 이하로 입력해 주세요.';
const PASSWORD_LENGTH_ERROR = `비밀번호는 ${PASSWORD_MIN_LENGTH}자 이상 ${PASSWORD_MAX_LENGTH}자 이하로 입력해 주세요.`;
const EMAIL_DUPLICATE_ERROR = '이미 가입된 이메일입니다.';
// passwordConfirm 불일치 전용 메시지 (PRD D39 / 24.1 / 24.3, 2026-10-06 추가).
// 누락/null/문자열 아님/빈 문자열도 전부 이 메시지로 수렴한다 — 사유별로 메시지를 나누지 않는다.
const PASSWORD_MISMATCH_ERROR = '비밀번호가 일치하지 않습니다.';
// 존재하지 않는 이메일과 틀린 비밀번호를 구별 불가능하게 만드는 단일 메시지 (D34 / 24.7).
const LOGIN_CREDENTIALS_ERROR = '이메일 또는 비밀번호가 올바르지 않습니다.';
const LOGIN_REQUIRED_ERROR = '로그인이 필요합니다.';

/**
 * 회원 저장소 — Map<normalizedEmail, User>.
 * 세션 저장소 — Map<sessionId, Session>.
 *
 * PRD D28: 서버 프로세스 메모리에만 보관한다. DB·파일 영속화 없음.
 * 서버를 재시작하면 회원·세션이 전부 사라져도 되며 그것은 버그가 아니다 — 오히려
 * qa-agent가 "세션을 결정론적으로 무효화하는 수단"으로 재시작을 쓴다 (26장 C7).
 *
 * User 레코드는 정확히 4필드다: email, passwordHash, passwordSalt, createdAt (D32).
 * Session 레코드는 email(주인) / createdAt / expiresAt 3필드다. sessionId는 필드가 아니라
 * Map의 키다 — 응답에 절대 나가지 않기 때문에 레코드 안에 둘 이유가 없다.
 */
const users = new Map();
const sessions = new Map();

// 회원이 없을 때도 해시 계산을 한 번 거치기 위한 더미 salt (PRD 24.7 구현 힌트 —
// 응답 시간 차이로 "이 이메일이 가입되어 있는가"가 드러나지 않게 한다). 필수 요구사항은
// 아니지만 비용이 거의 없으므로 반영한다.
const DUMMY_PASSWORD_SALT = crypto.randomBytes(PASSWORD_SALT_BYTES).toString('hex');

/**
 * email/password의 "형식"만 검증한다 (PRD 24.3 / 24.8 — signup·login이 완전히 같은 규칙을 쓴다).
 * 검증 순서는 email → password로 고정한다. 틀린 게 여러 개여도 메시지가 하나로 고정되어야
 * 테스트가 flaky하지 않다 (24.3 "둘 다 틀렸으면 email 메시지가 나간다").
 *
 * 반환: 에러 메시지 문자열(400으로 보낼 것) 또는 통과 시 null.
 */
function validateAuthCredentialsFormat(email, password) {
  if (typeof email !== 'string') {
    return EMAIL_FORMAT_ERROR;
  }
  const trimmedEmail = email.trim();
  if (trimmedEmail.length === 0 || !EMAIL_PATTERN.test(trimmedEmail)) {
    return EMAIL_FORMAT_ERROR;
  }
  if (trimmedEmail.length > EMAIL_MAX_LENGTH) {
    return EMAIL_LENGTH_ERROR;
  }
  // ⚠️ 비밀번호는 trim하지 않는다 — 원본 길이로만 검사한다 (D35). 공백 4자는 유효하다 (26장 A11).
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return PASSWORD_LENGTH_ERROR;
  }
  return null;
}

/** 이메일을 계정 정체성 형태로 정규화한다 — trim + 소문자 (PRD D33). */
function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

/**
 * 평문 비밀번호를 scrypt로 해시한다 (PRD D29). 호출 지점은 signup 하나뿐이다 —
 * crypto 해시 호출이 이 함수와 verifyPassword() 밖에 나타나지 않게 한다 (5차 스택 보강).
 */
function hashPassword(plainPassword) {
  const passwordSalt = crypto.randomBytes(PASSWORD_SALT_BYTES).toString('hex');
  const passwordHash = crypto
    .scryptSync(plainPassword, passwordSalt, PASSWORD_HASH_KEYLEN, SCRYPT_PARAMS)
    .toString('hex');
  return { passwordSalt, passwordHash };
}

/**
 * 평문 비밀번호가 저장된 User의 해시와 일치하는지 검사한다.
 * 타이밍 공격 방지를 위해 crypto.timingSafeEqual을 쓴다 (D29) — === 문자열 비교를 쓰지 않는다.
 */
function verifyPassword(plainPassword, user) {
  const candidateHash = crypto.scryptSync(
    plainPassword,
    user.passwordSalt,
    PASSWORD_HASH_KEYLEN,
    SCRYPT_PARAMS
  );
  const storedHash = Buffer.from(user.passwordHash, 'hex');
  if (candidateHash.length !== storedHash.length) {
    return false;
  }
  return crypto.timingSafeEqual(candidateHash, storedHash);
}

/**
 * User 레코드를 응답용으로 변환하는 유일한 지점 (PRD D30 / 24.19).
 * signup·login·me 3개 응답이 전부 이 함수만 거친다 — 엔드포인트마다 객체를 직접
 * 조립하면 그중 하나에서 passwordHash/passwordSalt가 새어나간다.
 * 키는 정확히 email, createdAt 2개다.
 */
function toUserResponse(user) {
  return { email: user.email, createdAt: user.createdAt };
}

/** Set-Cookie로 새 세션 쿠키를 발급한다 (PRD 24.16). */
function setSessionCookie(res, sessionId) {
  res.append(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`
  );
}

/** Set-Cookie로 세션 쿠키를 폐기한다 (Max-Age=0) — 로그아웃 성공, 무효/만료 세션 응답에 싣는다 (D36). */
function clearSessionCookie(res) {
  res.append('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * 새 세션을 발급해 저장소에 등록한다. sessionId는 필드가 아니라 Map 키이므로
 * 반환값은 sessionId 문자열 하나뿐이다.
 */
function createSession(email) {
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, {
    email,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
  });
  return sessionId;
}

/**
 * 요청의 sessionId 쿠키를 "부작용 없이" 조회한다 (쿠키 Set-Cookie 여부는 호출자가 결정한다 —
 * logout과 me가 "쿠키를 폐기할지"를 서로 다른 조건으로 판단하기 때문이다. 24.10 vs 24.11).
 * 쿠키 파싱 → Map 조회 → expiresAt 검사까지 하고, 무효/만료였다면 Map에서는 지운다
 * (세션 레코드 정리는 두 엔드포인트가 공통으로 원하는 동작이다 — D36 lazy 정리).
 *
 * ⚠️ 이 함수는 ensureCartId()와 짝이 아니다 — 쿠키가 없을 때 새로 발급하지 않는다.
 * sessionId는 로그인 성공 시에만 발급된다 (24.16).
 *
 * 반환: { sessionId, session, hadCookie }
 *   - hadCookie=false: 쿠키 자체가 없었다. sessionId/session 모두 null.
 *   - hadCookie=true, session=null: 쿠키는 있었지만 Map에 없거나(위조/재시작) 만료됐다
 *     (이미 Map에서 삭제했다).
 *   - session이 있으면: 유효한 세션.
 */
function findSession(req) {
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
  if (!sessionId) {
    return { sessionId: null, session: null, hadCookie: false };
  }

  const session = sessions.get(sessionId);
  if (!session || Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    return { sessionId, session: null, hadCookie: true };
  }

  return { sessionId, session, hadCookie: true };
}

/**
 * GET /api/auth/me가 쓰는 조회 함수. 유효하면 { sessionId, session }, 아니면 null.
 * 쿠키가 있었지만 무효/만료였던 경우에만 쿠키 폐기를 싣는다 — 쿠키가 아예 없었다면
 * 지울 것이 없으므로 Set-Cookie를 보내지 않는다 (24.11 / C10).
 */
function resolveSession(req, res) {
  const found = findSession(req);
  if (!found.session) {
    if (found.hadCookie) {
      clearSessionCookie(res);
    }
    return null;
  }
  return { sessionId: found.sessionId, session: found.session };
}

// ---------------------------------------------------------------------------
// POST /api/auth/signup — 회원가입 (PRD 24.1~24.4, 2026-10-06 D39 개정)
//
// body: { "email": string, "password": string, "passwordConfirm": string }  3필드.
//       그 외 필드는 전부 무시한다 (24.1).
// 201: { "user": { "email", "createdAt" } }  — Set-Cookie 없음 (가입은 자동 로그인이 아니다, D31)
// 400: { "error": { "message": "..." } }  — 검증 순서: email 형식/길이 → password 길이 →
//      passwordConfirm 일치 (D39 / 24.3). 셋 다 같은 400 shape이며, 가장 먼저 걸린 것의
//      메시지만 나간다.
// 409: { "error": { "message": "이미 가입된 이메일입니다." } }  — 정규화된 이메일 기준 중복 (D33)
//      * 409일 때 비밀번호 해시를 계산하지 않고 기존 계정을 덮어쓰지 않는다 (24.4 마지막 항).
//      * passwordConfirm 불일치(400)는 중복 검사(409)보다 먼저 검사한다 — 이미 가입된
//        이메일 + 불일치 비밀번호는 400이 나가고 409는 나가지 않는다 (24.3/24.4, 26장 A25).
//
// passwordConfirm은 password와 "원본 문자열 엄격 비교"만 한다 — trim·대소문자 변환 없음
// (D35). 누락/null/문자열 아님/빈 문자열은 전부 불일치로 취급한다 (24.1). 저장하지 않고
// 응답에도 나가지 않는다 — User는 4필드(email/passwordHash/passwordSalt/createdAt) 그대로
// (D32). 불일치로 400이 나갈 때는 해시 계산도, 계정 생성도, 기존 계정 변경도 하지 않는다 —
// 이 지점 이전에는 서버 상태(users Map)를 전혀 건드리지 않는다 (24.3 마지막 항).
//
// ⚠️ ensureCartId()를 호출하지 않는다 — cartId 쿠키를 전혀 건드리지 않는다 (24.13 / D27).
// ---------------------------------------------------------------------------
app.post('/api/auth/signup', (req, res, next) => {
  try {
    const body = req.body || {};
    const { email, password, passwordConfirm } = body;

    const formatError = validateAuthCredentialsFormat(email, password);
    if (formatError) {
      sendError(res, 400, formatError);
      return;
    }

    // passwordConfirm 일치 검증 (D39) — 길이 검사 다음, 중복(409) 검사 이전 (24.3).
    // 엄격 비교(===)만 한다: trim/대소문자 변환 없음 (D35). 문자열이 아니거나 누락/null이면
    // password와 같을 수 없으므로 자연히 불일치로 처리된다 — 별도 타입 분기를 두지 않는다.
    if (passwordConfirm !== password) {
      sendError(res, 400, PASSWORD_MISMATCH_ERROR);
      return;
    }

    const normalizedEmail = normalizeEmail(email);
    if (users.has(normalizedEmail)) {
      // 중복 — 비밀번호 해시를 계산하지 않는다. 기존 계정은 그대로 둔다 (24.4).
      sendError(res, 409, EMAIL_DUPLICATE_ERROR);
      return;
    }

    const { passwordSalt, passwordHash } = hashPassword(password);
    const user = {
      email: normalizedEmail,
      passwordHash,
      passwordSalt,
      createdAt: new Date().toISOString(),
    };
    users.set(normalizedEmail, user);

    res.status(201).json({ user: toUserResponse(user) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/login — 로그인 (PRD 24.5~24.9)
//
// body: { "email": string, "password": string }
// 200: { "user": { "email", "createdAt" } } + Set-Cookie: sessionId=... (24.16)
// 400: 형식 검증 실패 — email → password 순서, 24.3과 동일한 메시지 (24.8, 401보다 먼저 검사)
// 401: { "error": { "message": "이메일 또는 비밀번호가 올바르지 않습니다." } }
//      * 이메일 없음 / 비밀번호 불일치 — 두 경우를 완전히 동일하게 (D34, user enumeration 방지)
//
// 요청에 유효하든 무효하든 sessionId 쿠키가 실려 있으면 그 세션을 Map에서 지우고 새로
// 발급한다 (24.9 — 같은 브라우저 재로그인 시 고아 세션을 남기지 않는다, D37).
// ⚠️ ensureCartId()를 호출하지 않는다 (24.13 / D27).
// ---------------------------------------------------------------------------
app.post('/api/auth/login', (req, res, next) => {
  try {
    const body = req.body || {};
    const { email, password } = body;

    const formatError = validateAuthCredentialsFormat(email, password);
    if (formatError) {
      sendError(res, 400, formatError);
      return;
    }

    const normalizedEmail = normalizeEmail(email);
    const user = users.get(normalizedEmail);

    let passwordMatches = false;
    if (user) {
      passwordMatches = verifyPassword(password, user);
    } else {
      // 회원이 없어도 더미 salt로 해시를 한 번 계산해 응답 시간 차이를 줄인다 (24.7 구현 힌트).
      crypto.scryptSync(password, DUMMY_PASSWORD_SALT, PASSWORD_HASH_KEYLEN, SCRYPT_PARAMS);
    }

    if (!user || !passwordMatches) {
      sendError(res, 401, LOGIN_CREDENTIALS_ERROR);
      return;
    }

    // 같은 브라우저의 기존 세션을 교체한다 (24.9). 유효성과 무관하게 해당 sessionId만
    // Map에서 지운다 — 없는 키를 지우는 것은 no-op이라 안전하다. 다른 브라우저의
    // 세션(다른 sessionId)은 건드리지 않는다 (23.8).
    const existingSessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
    if (existingSessionId) {
      sessions.delete(existingSessionId);
    }

    const sessionId = createSession(normalizedEmail);
    setSessionCookie(res, sessionId);

    res.status(200).json({ user: toUserResponse(user) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout — 로그아웃 (PRD 24.10)
//
// body 없음.
// 200: { "user": null } + Set-Cookie: sessionId=;...;Max-Age=0  — 세션을 Map에서 삭제
// 401: { "error": { "message": "로그인이 필요합니다." } } + 같은 쿠키 폐기 헤더
//      * 쿠키 없음 / Map에 없음(위조·재시작) / 만료 — 세 경우 모두 401 (D36)
//      * 멱등하지 않다 — 연속 두 번 호출하면 200 → 401 (의도된 동작, 18.16과 같은 패턴)
//
// ⚠️ ensureCartId()를 호출하지 않는다 (24.13 / D27). 이번 사이클에 로그인을 요구하는
// 유일한 엔드포인트다 (24.12).
// ---------------------------------------------------------------------------
app.post('/api/auth/logout', (req, res, next) => {
  try {
    const found = findSession(req);

    // 쿠키 없음 / Map에 없음(위조·재시작) / 만료 — 세 경우 모두 401 + 쿠키 폐기 (D36).
    // me와 달리 "쿠키가 아예 없었어도" 폐기 헤더를 싣는다 — logout은 상태 조회가 아니라
    // "세션을 변경하는 조작"이므로 실패해도 결과(로그인 아님)를 쿠키로 확정해준다.
    if (!found.session) {
      clearSessionCookie(res);
      sendError(res, 401, LOGIN_REQUIRED_ERROR);
      return;
    }

    sessions.delete(found.sessionId);
    clearSessionCookie(res);

    res.status(200).json({ user: null });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/auth/me — 현재 로그인 상태 조회 (PRD 24.11)
//
// 항상 200. 401을 절대 반환하지 않는다 (D36 — 상태 조회는 에러가 아니다).
// 200: 로그인 상태 → { "user": { "email", "createdAt" } }
// 200: 비로그인/무효/만료 → { "user": null }  (user 키는 항상 존재, 생략·{} 금지)
//
// 무효·만료 세션이었을 때만 Map에서 삭제 + 쿠키 폐기를 싣는다. 쿠키가 아예 없었으면
// Set-Cookie를 싣지 않는다 (지울 게 없음 — C10). 슬라이딩 만료를 하지 않는다 — 이
// 호출이 expiresAt을 갱신하지 않는다 (24.11 / C11).
// ⚠️ ensureCartId()를 호출하지 않는다 (24.13 / D27).
// ---------------------------------------------------------------------------
app.get('/api/auth/me', (req, res, next) => {
  try {
    const resolved = resolveSession(req, res);
    if (!resolved) {
      res.status(200).json({ user: null });
      return;
    }

    const user = users.get(resolved.session.email);
    if (!user) {
      // 세션은 유효했지만 회원이 사라진 방어적 경우(이번 범위에는 탈퇴가 없어 정상적으로는
      // 발생하지 않는다) — 비로그인과 동일하게 처리한다.
      sessions.delete(resolved.sessionId);
      clearSessionCookie(res);
      res.status(200).json({ user: null });
      return;
    }

    res.status(200).json({ user: toUserResponse(user) });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// 6차 사이클 추가분 — 상품 리뷰 / 평점 (PRD 27~32장)
//
// 아래 라우트들도 반드시 "/api 미정의 경로 404 핸들러"보다 위에 있어야 한다.
//
// 🔒 쿠키 분리 규칙 (PRD 30.15 / D27, M4 재발 차단 원칙의 연장):
//   - 이 섹션의 4개 핸들러는 ensureCartId()를 호출하지 않고 cartId 쿠키를 건드리지 않는다.
//   - `/api/products/:productId/reviews`가 상품 경로 접두어를 공유한다고 해서 상품/장바구니
//     쪽의 공용 전처리(있다면)를 함께 타면 안 된다 — 이 서버는 전처리를 라우트 핸들러
//     단위로만 두므로(경로 단위 미들웨어 없음) 애초에 그 위험이 없다.
//   - sessionId 조회는 findSession()/resolveSession()을 그대로 재사용한다(5차와 동일 패턴) —
//     세션 Map·쿠키 파싱 로직이 두 곳에 따로 생기면 그 자체가 새 버그 자리가 된다.
//
// ⚠️ 메서드별 인증 분기 (PRD D40 / 30.13): GET은 세션이 없어도 200, POST/PATCH/DELETE는
// 401이다. 같은 경로(`/api/products/:productId/reviews`)에 걸리는 GET과 POST가 서로 다른
// 인증 요구를 가지므로, 경로 단위 미들웨어로 뭉개지 않고 각 app.get/app.post 핸들러 내부에서
// 개별적으로 검사한다.
// ===========================================================================

// --- 리뷰 상수 (PRD 30.7 / D44 / D48) ----------------------------------------
const RATING_MIN = 1;
const RATING_MAX = 5;
const CONTENT_MAX_LENGTH = 500; // trim 후 기준

const RATING_ERROR = '평점은 1 이상 5 이하의 정수로 입력해 주세요.';
const CONTENT_REQUIRED_ERROR = '리뷰 내용을 입력해 주세요.';
const CONTENT_LENGTH_ERROR = '리뷰 내용은 500자 이하로 입력해 주세요.';
const REVIEW_DUPLICATE_ERROR = '이미 이 상품에 리뷰를 작성했습니다.';
const REVIEW_NOT_FOUND_ERROR = '리뷰를 찾을 수 없습니다.';
const REVIEW_FORBIDDEN_ERROR = '본인이 작성한 리뷰만 수정하거나 삭제할 수 있습니다.';
// PRD 9.2와 글자 그대로 같은 문구를 재사용한다 (같은 의미의 실패에 새 문구를 만들지 않는다).
const PRODUCT_NOT_FOUND_ERROR = '상품을 찾을 수 없습니다.';

/**
 * 리뷰 저장소 — Map<reviewId, Review> 단일 Map (PRD D44).
 *
 * `Map<productId, Review[]>`로 두지 않는다 — 수정·삭제가 reviewId 하나만 들고 들어오므로
 * (30.11), 상품별 배열 구조면 모든 상품의 배열을 훑어야 하고 그 순회가 곧 "남의 리뷰를
 * 잘못 집는" 버그 자리가 된다.
 *
 * PRD D42: 서버 프로세스 메모리에만 보관한다. DB·파일 영속화 없음. 서버를 재시작하면
 * 리뷰가 전부 사라져도 되며 그것은 버그가 아니다 — D6·D21·D28과 완전히 같은 판단이다.
 *
 * Review 레코드는 정확히 6필드다: reviewId, productId, email, rating, content, createdAt.
 * isMine은 저장 필드가 아니라 응답을 만들 때 계산한다 (D50 / 30.3) — toReviewSnapshot()이
 * 그 유일한 계산 지점이다.
 */
const reviews = new Map();

/** rating이 1~5 정수인지 검사한다 (PRD 30.7). 0도 6도 4.5도 문자열 "5"도 전부 false. */
function isValidRating(value) {
  return Number.isInteger(value) && value >= RATING_MIN && value <= RATING_MAX;
}

/**
 * POST/PATCH 공용 입력 검증 (PRD 30.7 — rating → content 누락 → content 길이 순서).
 * 반환: 에러 메시지 문자열(400으로 보낼 것) 또는 통과 시 null.
 *
 * ⚠️ content는 여기서 trim하지 않고 "검사만" 한다 — 실제 저장용 trim은 호출자가
 * body.content.trim()으로 한 번 더 한다. 검사와 저장을 분리해야 "trim 후 길이"라는
 * 조건을 검증 함수 하나에서 정확히 반영할 수 있다.
 */
function validateReviewInput(body) {
  const { rating, content } = body;

  if (!isValidRating(rating)) {
    return RATING_ERROR;
  }
  if (typeof content !== 'string') {
    return CONTENT_REQUIRED_ERROR;
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return CONTENT_REQUIRED_ERROR;
  }
  if (trimmed.length > CONTENT_MAX_LENGTH) {
    return CONTENT_LENGTH_ERROR;
  }
  return null;
}

/** 같은 (productId, email) 쌍의 리뷰가 이미 있는지 검사한다 (PRD D45 — 중복 판정 키). */
function hasReviewByEmail(productId, email) {
  return [...reviews.values()].some((r) => r.productId === productId && r.email === email);
}

/**
 * 응답 변환을 담당하는 유일한 지점 (PRD 30.19 / D50 — toUserResponse()와 같은 규칙).
 * 필터 → 정렬 → isMine 계산 → averageRating·reviewCount 계산을 전부 여기서 한다.
 * 4개 엔드포인트(GET/POST 목록, PATCH, DELETE)가 전부 이 함수만 사용한다 — 엔드포인트마다
 * 스냅샷을 직접 조립하면 그중 하나에서 정렬이 빠지거나 평균이 옛값으로 나간다.
 *
 * viewerEmail이 null이면(비로그인/무효 세션) 모든 줄의 isMine이 false다 (30.3).
 *
 * top-level 키는 정확히 3개(reviews/averageRating/reviewCount)이고 항상 존재한다.
 * 리뷰가 0개면 { reviews: [], averageRating: null, reviewCount: 0 } — reviewCount는 0,
 * averageRating은 null이다. 두 필드의 "없을 때" 규칙이 서로 다르고 그게 의도다 (D50 / 32장 E7).
 */
function toReviewSnapshot(productId, viewerEmail) {
  const forProduct = [...reviews.values()]
    .filter((r) => r.productId === productId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // createdAt 내림차순 = 최신순 (D51)

  const reviewLines = forProduct.map((r) => ({
    reviewId: r.reviewId,
    productId: r.productId,
    email: r.email,
    rating: r.rating,
    content: r.content,
    createdAt: r.createdAt,
    isMine: viewerEmail !== null && r.email === viewerEmail,
  }));

  const reviewCount = reviewLines.length;
  const averageRating =
    reviewCount === 0
      ? null
      : Math.round((reviewLines.reduce((sum, r) => sum + r.rating, 0) / reviewCount) * 10) / 10;

  return { reviews: reviewLines, averageRating, reviewCount };
}

// ---------------------------------------------------------------------------
// GET /api/products/:productId/reviews — 리뷰 목록 + 평균 평점 조회 (PRD 30.5)
//
// 비로그인도 200이다 (D40). 상품이 존재하면 리뷰가 0개여도 200 + 빈 스냅샷(9.3과 같은 판단,
// 404가 아니다). :productId가 시드 상품에 없으면 404.
// 세션을 읽긴 하지만 없거나 무효해도 401이 아니다 — 그 줄들의 isMine만 전부 false가 된다.
// 정렬·필터·페이지네이션 쿼리 파라미터는 전부 무시한다 (D51).
// ---------------------------------------------------------------------------
app.get('/api/products/:productId/reviews', (req, res, next) => {
  try {
    const { productId } = req.params;
    const product = products.find((p) => p.id === productId);
    if (!product) {
      sendError(res, 404, PRODUCT_NOT_FOUND_ERROR);
      return;
    }

    // resolveSession()은 무효/만료 세션을 만나면 Map 삭제 + 쿠키 폐기까지 하지만 응답
    // 상태는 여전히 200이다 — 여기서는 그 반환값(null 가능)을 그대로 isMine 판정에 쓴다.
    const resolved = resolveSession(req, res);
    const viewerEmail = resolved ? resolved.session.email : null;

    res.status(200).json(toReviewSnapshot(productId, viewerEmail));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/products/:productId/reviews — 리뷰 작성 (PRD 30.6~30.9)
//
// body: { "rating": integer, "content": string }  2개 필드만. email/productId/createdAt/
//       reviewId 등이 실려 와도 전부 무시한다 — 작성자는 세션, 대상 상품은 URL 경로로 정한다.
// 201: 갱신된 스냅샷(방금 쓴 리뷰가 맨 앞, isMine: true). Set-Cookie 없음 (cartId도
//      sessionId도 발급하지 않는다 — 30.15).
//
// 검증 순서: 세션(401) → 상품 존재(404) → 입력 검증(400) → 중복(409) — 30.8.
// 409일 때 기존 리뷰를 덮어쓰지 않는다 — rating/content/createdAt 어느 것도 바뀌지 않는다.
// ---------------------------------------------------------------------------
app.post('/api/products/:productId/reviews', (req, res, next) => {
  try {
    const resolved = resolveSession(req, res);
    if (!resolved) {
      sendError(res, 401, LOGIN_REQUIRED_ERROR);
      return;
    }

    const { productId } = req.params;
    const product = products.find((p) => p.id === productId);
    if (!product) {
      sendError(res, 404, PRODUCT_NOT_FOUND_ERROR);
      return;
    }

    const body = req.body || {};
    const validationError = validateReviewInput(body);
    if (validationError) {
      sendError(res, 400, validationError);
      return;
    }

    const viewerEmail = resolved.session.email;
    if (hasReviewByEmail(productId, viewerEmail)) {
      // 중복 — 기존 리뷰를 덮어쓰지 않는다. 여기서 리턴하므로 아래 reviews.set()에 닿지 않는다.
      sendError(res, 409, REVIEW_DUPLICATE_ERROR);
      return;
    }

    const review = {
      reviewId: crypto.randomUUID(),
      productId,
      email: viewerEmail,
      rating: body.rating,
      content: body.content.trim(),
      createdAt: new Date().toISOString(),
    };
    reviews.set(review.reviewId, review);

    res.status(201).json(toReviewSnapshot(productId, viewerEmail));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/reviews/:reviewId — 리뷰 수정, 본인만 (PRD 30.10~30.11)
// DELETE /api/reviews/:reviewId — 리뷰 삭제, 본인만 (PRD 30.10~30.11)
//
// 둘 다 reviewId가 전역에서 유일하므로(D44) 상품 경로를 반복하지 않는다.
//
// 검증 순서 (⚠️ 이번 사이클의 핵심 조항 — 30.10):
//   1. 세션(401) → 2. reviewId 존재(404) → 3. 소유권(403) → 4. (PATCH만) 입력(400)
// 🔑 존재하지 않는 리뷰 = 404, 존재하지만 남의 리뷰 = 403 — 둘을 섞지 않는다 (D46).
// 이것은 주문 조회(D23, 남의 주문도 404)와 "일부러" 다르다 — 리뷰는 GET으로 전원에게
// 공개되어 reviewId가 이미 노출되어 있으므로 숨길 것이 없다.
//
// PATCH 성공: createdAt을 바꾸지 않는다. updatedAt을 만들지 않는다 (D49) — 목록 순서가
// 수정으로 변하지 않는다.
// DELETE 성공: 204가 아니라 200 + 갱신된 스냅샷(9.6/30.11과 같은 판단). 같은 reviewId로
// 다시 호출하면 404다 — 멱등하지 않으며 의도된 동작이다 (24.10/18.16과 같은 패턴).
// ---------------------------------------------------------------------------
app.patch('/api/reviews/:reviewId', (req, res, next) => {
  try {
    const resolved = resolveSession(req, res);
    if (!resolved) {
      sendError(res, 401, LOGIN_REQUIRED_ERROR);
      return;
    }

    const { reviewId } = req.params;
    const review = reviews.get(reviewId);
    if (!review) {
      sendError(res, 404, REVIEW_NOT_FOUND_ERROR);
      return;
    }

    if (review.email !== resolved.session.email) {
      sendError(res, 403, REVIEW_FORBIDDEN_ERROR);
      return;
    }

    const body = req.body || {};
    const validationError = validateReviewInput(body);
    if (validationError) {
      sendError(res, 400, validationError);
      return;
    }

    // 교체(덮어쓰기)만 한다 — reviewId/productId/email/createdAt은 하나도 바뀌지 않는다 (D49).
    review.rating = body.rating;
    review.content = body.content.trim();

    res.status(200).json(toReviewSnapshot(review.productId, resolved.session.email));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/reviews/:reviewId', (req, res, next) => {
  try {
    const resolved = resolveSession(req, res);
    if (!resolved) {
      sendError(res, 401, LOGIN_REQUIRED_ERROR);
      return;
    }

    const { reviewId } = req.params;
    const review = reviews.get(reviewId);
    if (!review) {
      sendError(res, 404, REVIEW_NOT_FOUND_ERROR);
      return;
    }

    if (review.email !== resolved.session.email) {
      sendError(res, 403, REVIEW_FORBIDDEN_ERROR);
      return;
    }

    // DELETE는 body를 받지 않으므로 4순위(입력 검증)가 없다 — 소유권 확인 후 바로 삭제한다.
    reviews.delete(reviewId);

    res.status(200).json(toReviewSnapshot(review.productId, resolved.session.email));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// /api/* 미정의 경로 — 이번 범위 밖 엔드포인트는 존재하지 않음을 JSON으로 알린다.
// ---------------------------------------------------------------------------
app.use('/api', (req, res) => {
  res.status(404).json({
    error: { message: '존재하지 않는 API 경로입니다.' },
  });
});

// ---------------------------------------------------------------------------
// 에러 핸들러 — /api/* 는 항상 { error: { message } } JSON (PRD 3.4 / 9.13)
//
// docs/bug-history/2026-08-08_generic-error-message-leak.md (BUG-2026-08-08-02, M5) 반영:
// 예전에는 어느 API에서 터지든 "상품 목록을 불러오지 못했습니다."라는 고정 문구가 나갔다.
// 3차에서 DELETE /api/cart가 이 공용 핸들러를 그대로 물려받으므로, 장바구니 요청에서
// 500이 나면 "상품 목록을..."이라는 엉뚱한 문구가 나가게 된다 — M5가 예고한 재발 지점이다.
// 경로별로 문구를 분기하고(수정 방향 1), 그 외에는 기능명이 없는 중립 문구를 쓴다(수정 방향 2).
// 응답 shape({ error: { message } })과 상태 코드는 바뀌지 않으므로 기존 검증에 영향이 없다.
//
// 4차 추가: PRD 18.12가 결제 API를 이름으로 지목해 M5 재발을 예고했다. /api/checkout,
// /api/orders도 분기를 추가하지 않으면 결제 실패 화면에 "상품 목록을 불러오지 못했습니다."가
// 그대로 뜬다 — 그래서 두 분기를 추가한다 (18.12 권장 문구 그대로).
//
// 5차 추가: PRD 24.17이 같은 패턴을 다시 예고했다 — 분기를 추가하지 않으면 로그인/가입
// 실패 화면에도 "상품 목록을 불러오지 못했습니다."가 뜬다. 새 핸들러를 만들지 않고
// 기존 4개 분기에 5번째로 이어 붙인다.
//
// 6차 추가: PRD 30.18이 M5의 세 번째 재발 지점을 예고했다 — 이번엔 "경로 접두어 공유"
// 형태다. 리뷰 경로 중 하나(`/api/products/:productId/reviews`)가 `/api/products` 접두어를
// 그대로 공유하므로, 아래에서 `startsWith('/api/products')`를 먼저 검사하면 리뷰 요청의
// 500도 "상품 목록을 불러오지 못했습니다."를 물려받는다. 그래서 🚨 리뷰 분기를 상품 분기
// "보다 먼저" 검사한다(분기 순서 자체가 요구사항 — 30.18). `/api/reviews/:reviewId`는
// 접두어가 겹치지 않지만 같은 분기 함수로 묶어 한 곳에서만 판단한다.
// ---------------------------------------------------------------------------

/**
 * 요청 경로가 리뷰 엔드포인트(둘 중 하나)에 해당하는지 판정한다 (PRD 30.18).
 * `/api/products` 분기보다 반드시 먼저 호출해야 한다 — 그래야 접두어 공유로 인한
 * M5 재발(상품 문구가 리뷰 요청에 새어나가는 것)을 막을 수 있다.
 */
function isReviewRequestPath(path) {
  return path.startsWith('/api/reviews') || /^\/api\/products\/[^/]+\/reviews(?:\/|$)/.test(path);
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, err);

  if (res.headersSent) {
    return;
  }

  if (req.path.startsWith('/api')) {
    let message = '요청을 처리하지 못했습니다.';
    if (isReviewRequestPath(req.path)) {
      // 🚨 반드시 '/api/products' 분기보다 먼저 검사한다 — 30.18 / M5 세 번째 재발 지점.
      message = '리뷰 요청을 처리하지 못했습니다.';
    } else if (req.path.startsWith('/api/products')) {
      // 1차부터 문서화된 문구다. PRD 데이터 모델의 "서버 오류 → 500" 예시와 일치시킨다.
      message = '상품 목록을 불러오지 못했습니다.';
    } else if (req.path.startsWith('/api/cart')) {
      message = '장바구니 요청을 처리하지 못했습니다.';
    } else if (req.path.startsWith('/api/checkout')) {
      message = '결제 요청을 처리하지 못했습니다.';
    } else if (req.path.startsWith('/api/orders')) {
      message = '주문 정보를 불러오지 못했습니다.';
    } else if (req.path.startsWith('/api/auth')) {
      message = '인증 요청을 처리하지 못했습니다.';
    }
    res.status(500).json({ error: { message } });
    return;
  }

  res.status(500).type('text/plain; charset=utf-8').send('Internal Server Error');
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
    console.log(`[server] products API: http://localhost:${PORT}/api/products`);
  });
}

module.exports = app;
