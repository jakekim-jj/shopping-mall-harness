'use strict';

/**
 * 쇼핑몰 서버 (상품 목록 / 상품 상세 / 장바구니 / 모의 결제).
 *
 * PRD(_workspace/01_planner_prd.md) Tech stack 확정값:
 * - Node.js 20+ / Express, 단일 서버 / 단일 포트 3000
 * - public/ 정적 서빙 + 같은 오리진에서 /api/* 제공 (CORS 불필요)
 * - 이번 범위의 API는 GET /api/products + 2차 신규 5개 + 3차 신규 1개 + 4차 신규 2개
 *   = 총 9개 (PRD 18.13)
 *   3차 신규: DELETE /api/cart (장바구니 전체 비우기, PRD 13.1)
 *   4차 신규: POST /api/checkout (모의 결제, PRD 18.1), GET /api/orders/:orderId (주문 조회, PRD 18.9)
 *   실제 PG 연동, 주문 목록 조회, 취소/환불 등은 여전히 만들지 않는다 (PRD 18.13).
 * - 3차 사이클: 줄 수량 10개 이상이면 그 줄에 10% 자동 할인 (PRD 12장).
 *   할인 계산은 buildCartSnapshot() 한 곳에서만 한다 (PRD 3차 스택 보강).
 * - 4차 사이클: 결제 승인/거절은 요청의 paymentMethod 값만으로 결정론적으로 판정한다.
 *   Math.random()/시각/금액을 판정에 쓰지 않는다 (PRD 18.3 / D17).
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
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, err);

  if (res.headersSent) {
    return;
  }

  if (req.path.startsWith('/api')) {
    let message = '요청을 처리하지 못했습니다.';
    if (req.path.startsWith('/api/products')) {
      // 1차부터 문서화된 문구다. PRD 데이터 모델의 "서버 오류 → 500" 예시와 일치시킨다.
      message = '상품 목록을 불러오지 못했습니다.';
    } else if (req.path.startsWith('/api/cart')) {
      message = '장바구니 요청을 처리하지 못했습니다.';
    } else if (req.path.startsWith('/api/checkout')) {
      message = '결제 요청을 처리하지 못했습니다.';
    } else if (req.path.startsWith('/api/orders')) {
      message = '주문 정보를 불러오지 못했습니다.';
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
