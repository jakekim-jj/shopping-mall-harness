/* 하루상점 — 장바구니 공용 모듈 (세 화면 공통 헤더 배지 + 장바구니 API 호출기)
 *
 * 백엔드 계약(_workspace/02_backend_api-spec.md §2B~§2I)
 *   GET    /api/cart
 *   POST   /api/cart/items                 body { productId, quantity }
 *   PATCH  /api/cart/items/:productId      body { quantity }   ← delta 아님, "변경 후 절대 수량"
 *   DELETE /api/cart/items/:productId      (body 없음, 응답은 200 + body — 204 아님)
 *   DELETE /api/cart                       (3차 신규 — 전체 비우기. 200 + 빈 스냅샷, 멱등 §2I)
 *
 *   다섯 엔드포인트 모두 성공 시 동일 shape:
 *     200 → { "cart": { "items": [ CartItem(필드 11개) ], "totalQuantity": N, "totalPrice": N } }
 *                                                                       ← 두 겹이다
 *     4xx → { "error": { "message": "..." } }
 *
 * ⚠ 3차 파괴적 변경(스펙 최상단 배너 / §2H): `lineTotal`의 의미가 "price × quantity"에서
 *   "discountedUnitPrice × quantity (할인 후 최종)"으로 바뀌었다. 이름이 같아 에러 없이 조용히
 *   값만 달라진다. 화면의 줄 합계에 그릴 값은 3차에도 계속 `lineTotal`이므로(PRD 10.10 / 12.12)
 *   이 파일의 lineTotal 매핑은 2차 그대로 두는 것이 정답이다 — 고치면 오히려 틀린다.
 *   할인 전 금액 `lineSubtotal`은 화면에 그릴 자리가 없다(취소선은 단가 자리 한 곳뿐).
 *
 * ⚠ 상품 목록의 { items }(한 겹)와 다르다. app.js의 mapProductListResponse()를 재사용하지 않는다.
 * 두 겹을 벗기는 지점은 이 파일의 mapCartResponse() 한 곳뿐이다 — shape이 바뀌면 여기만 고친다.
 *
 * 쿠키(cartId)는 서버가 HttpOnly로 발급/식별한다. 프론트는 document.cookie를 읽지도 쓰지도 않고
 * credentials 옵션도 쓰지 않는다 (같은 오리진 fetch의 기본 동작 — PRD 8.6 / 스펙 §2B).
 */
(function () {
  'use strict';

  var CART_ENDPOINT = '/api/cart';
  var CART_ITEMS_ENDPOINT = '/api/cart/items';
  var JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

  /* ---------- 표시 포맷 (PRD 1.3 / 6.2 / 7.6) ---------- */

  // price는 원 단위 정수 → "19,000원". 소수점 없음.
  function formatPrice(price) {
    var n = Number(price);
    if (!isFinite(n)) return '가격 정보 없음';
    return Math.round(n).toLocaleString('ko-KR') + '원';
  }

  /* ---------- 매핑 지점 (API shape ↔ 화면 모델) ---------- */

  // { error: { message } } 중첩을 벗기는 유일한 지점
  function readErrorMessage(body) {
    if (body && typeof body === 'object' && body.error && typeof body.error.message === 'string') {
      return body.error.message;
    }
    return '';
  }

  // 장바구니 줄 1개 → 화면 모델.
  // 이 함수에는 산술이 하나도 없다 — 서버 값을 옮겨 담고 표시 포맷만 입힌다 (PRD 7.6 / D12).
  // price * quantity, price * 0.9 같은 계산을 여기(또는 어디에도) 쓰지 않는다.
  function mapCartItem(item) {
    return {
      productId: String(item.productId),
      name: String(item.name),
      imageUrl: String(item.imageUrl),
      price: Number(item.price),                 // 언제나 "원래 단가" — 할인이 걸려도 깎이지 않는다
      priceText: formatPrice(item.price),
      quantity: Number(item.quantity),
      // 3차 할인 필드 5개. 할인 미적용 줄에서도 항상 존재한다 (스펙 §2H / PRD 13.6)
      // → undefined 방어 코드가 필요 없다.
      lineSubtotal: Number(item.lineSubtotal),               // 할인 전 줄 금액 (화면에 그릴 자리 없음)
      discountApplied: item.discountApplied === true,        // 할인 UI 표시 여부의 유일한 판정 근거 (PRD 12.11)
      discountPercent: Number(item.discountPercent),         // 안내 문구의 숫자 (하드코딩 금지 — PRD 12.15)
      discountedUnitPrice: Number(item.discountedUnitPrice), // 실제 적용 단가 (미적용 시 price와 같음)
      discountedUnitPriceText: formatPrice(item.discountedUnitPrice),
      discountAmount: Number(item.discountAmount),           // 전용 선택자 없음 — 현재 화면에는 표시하지 않는다
      // ⚠ 3차부터 lineTotal = 할인 후 최종 금액. 줄 합계 자리에 그릴 값은 계속 이 필드다.
      lineTotal: Number(item.lineTotal),
      lineTotalText: formatPrice(item.lineTotal)
    };
  }

  // { cart: { items, totalQuantity, totalPrice } } 두 겹을 벗기는 유일한 지점.
  // totalQuantity/totalPrice도 서버 계산값 그대로 — 프론트에서 다시 합산하지 않는다 (PRD 7.6 / 9.8).
  function mapCartResponse(body) {
    if (!body || typeof body !== 'object' || !body.cart || typeof body.cart !== 'object' ||
        !Array.isArray(body.cart.items)) {
      throw new Error('예상과 다른 응답 형식입니다 (cart.items 배열 없음)');
    }
    var cart = body.cart;
    return {
      items: cart.items.map(mapCartItem),
      totalQuantity: Number(cart.totalQuantity),
      totalPrice: Number(cart.totalPrice),
      totalPriceText: formatPrice(cart.totalPrice)
    };
  }

  /* ---------- 장바구니 API 호출기 (4개 엔드포인트 공용) ---------- */

  function callCart(url, options) {
    return fetch(url, options).then(function (res) {
      return res.json()
        .catch(function () { return null; })
        .then(function (body) {
          // 성공/실패는 상태 코드로 판단한다 (body 내용으로 판단하지 않음)
          if (!res.ok) {
            var err = new Error(readErrorMessage(body) || '장바구니 요청에 실패했습니다');
            err.status = res.status;
            throw err;
          }
          return mapCartResponse(body);
        });
    });
  }

  function getCart() {
    return callCart(CART_ENDPOINT, { headers: { Accept: 'application/json' } });
  }

  // quantity는 "담을 개수". 서버가 기존 줄에 합산한다 (PRD 6.6 / D8).
  function addItem(productId, quantity) {
    return callCart(CART_ITEMS_ENDPOINT, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ productId: productId, quantity: quantity })
    });
  }

  // quantity는 변경 후 절대 수량이다 (delta 아님 — 스펙 §2E).
  // quantity 0은 서버가 400으로 거절한다. 삭제는 removeItem()뿐이다.
  function setQuantity(productId, quantity) {
    return callCart(CART_ITEMS_ENDPOINT + '/' + encodeURIComponent(productId), {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ quantity: quantity })
    });
  }

  function removeItem(productId) {
    return callCart(CART_ITEMS_ENDPOINT + '/' + encodeURIComponent(productId), {
      method: 'DELETE',
      headers: { Accept: 'application/json' }
    });
  }

  // 장바구니 전체 비우기 (3차 신규 — 스펙 §2I / PRD 11.1).
  // DELETE /api/cart를 "한 번"만 호출한다. 줄 개수만큼 removeItem()을 반복 호출하지 않는다
  // — 요청이 N개로 늘고 중간에 하나가 실패하면 절반만 비워진 상태가 된다.
  // 응답은 다른 4개와 완전히 같은 { cart } shape이라 렌더 함수가 그대로 재사용된다 (PRD 13.5).
  function clearCart() {
    return callCart(CART_ENDPOINT, {
      method: 'DELETE',
      headers: { Accept: 'application/json' }
    });
  }

  /* ---------- 공통 헤더 수량 배지 (PRD 5.4~5.6, 10.2) ---------- */

  function badgeEl() {
    return document.querySelector('[data-testid="cart-count"]');
  }

  // 값은 항상 서버 응답의 cart.totalQuantity를 그대로 쓴다.
  // 0이면 요소를 제거하지 않고 hidden 처리만 한다 (PRD 5.5 / 10.2).
  function updateBadge(totalQuantity) {
    var badge = badgeEl();
    if (!badge) return;
    var n = Number(totalQuantity);
    if (!isFinite(n) || n <= 0) {
      badge.textContent = '0';
      badge.hidden = true;
      return;
    }
    badge.textContent = String(n);
    badge.hidden = false;
  }

  function hideBadge() {
    var badge = badgeEl();
    if (!badge) return;
    badge.textContent = '0';
    badge.hidden = true;
  }

  // 화면 진입 시 배지를 채운다. 실패해도 예외를 밖으로 던지지 않는다 —
  // 장바구니 조회 실패가 상품 목록 렌더링을 막으면 안 되기 때문 (PRD 5.7).
  function refreshBadge() {
    return getCart()
      .then(function (cart) {
        updateBadge(cart.totalQuantity);
        return cart;
      })
      .catch(function (err) {
        hideBadge();
        console.warn('[cart] 배지 갱신 실패 (화면 렌더는 계속 진행):', err);
        return null;
      });
  }

  window.HaruCart = {
    formatPrice: formatPrice,
    readErrorMessage: readErrorMessage,
    getCart: getCart,
    addItem: addItem,
    setQuantity: setQuantity,
    removeItem: removeItem,
    clearCart: clearCart,
    updateBadge: updateBadge,
    hideBadge: hideBadge,
    refreshBadge: refreshBadge,
    // 4차 추가: CartItem(11개 필드) → 화면 모델 매핑을 결제/주문 확인 화면과 공유한다.
    // order.items는 CartItem과 완전히 동일한 shape이므로(스펙 §2J 데이터 모델 확정 사항),
    // order.js가 이 함수를 그대로 재사용해 별도의 매핑 함수를 새로 만들지 않는다.
    mapLineItem: mapCartItem
  };
})();
