/* 하루상점 — 주문 내역 화면 로직 (/orders.html, 7차 PRD 35장)
 *
 * 백엔드 계약(_workspace/02_backend_api-spec.md 7차 섹션)
 *   GET /api/me/orders
 *     200 → { "orders": [ Order(9필드) ] }  최신 결제순, 빈 목록은 []
 *     401 → { "error": { "message": "로그인이 필요합니다." } }
 *     500 → { "error": { "message": "주문 내역을 불러오지 못했습니다." } }
 *
 * - 본문 5상태(loading/login-required/list/empty/error)는 DOM 상주 + hidden 토글, 항상 하나만 visible.
 * - 상태 판정 근거는 목록 API 응답 하나다 (D60). 헤더 로그인 상태로 판정하지 않는다.
 *   예외: 로그아웃 전이(D62) — HaruAuth 구독이 '게스트 확정'을 알리면 카드를 DOM에서 제거하고
 *   로그인 필요 상태로 전환한다(재호출 없음). 게스트 신호는 단조 — 한 번 오면 되돌아가지 않는다.
 * - GET /api/auth/me는 부르지 않는다(auth-header.js 담당). 구독만 한다.
 *
 * M4(docs/bug-history 쿠키 경쟁 조건): GET /api/me/orders는 cartId를 읽지도 쓰지도 않는다(D63).
 * 이 화면의 cart 배지·auth/me·목록 3요청 병렬은 안전하다. 이 파일은 document.cookie를 건드리지 않는다.
 * M1(서버 에러 문구 노출): 에러 상태 문구는 고정 문자열이며 서버 error.message를 화면에 흘리지 않는다.
 * M2(숨김 vs 부재): 5상태 요소는 hidden 토글, 주문 카드(history-order)·줄·링크는 데이터 없으면 DOM에 없음.
 *
 * 주문자 정보·결제 수단·할인 UI는 표시하지 않는다(35.7). 재정렬·재계산 없음. textContent만 사용.
 */
(function () {
  'use strict';

  var el = {
    loading: document.getElementById('history-loading'),
    loginRequired: document.getElementById('history-login-required'),
    list: document.getElementById('history-list'),
    empty: document.getElementById('history-empty'),
    error: document.getElementById('history-error')
  };

  var guestLatched = false;   // 게스트 신호가 한 번이라도 오면 true (단조 전이)

  function showOnly(name) {
    el.loading.hidden = name !== 'loading';
    el.loginRequired.hidden = name !== 'login-required';
    el.list.hidden = name !== 'list';
    el.empty.hidden = name !== 'empty';
    el.error.hidden = name !== 'error';
    el.loading.setAttribute('aria-busy', String(name === 'loading'));
  }

  /* ---------- 매핑 지점 ---------- */

  function mapOrdersResponse(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.orders)) {
      throw new Error('예상과 다른 응답 형식입니다 (orders 배열 없음)');
    }
    return body.orders.map(function (order) {
      if (!order || typeof order !== 'object' || !Array.isArray(order.items)) {
        throw new Error('예상과 다른 주문 형식입니다');
      }
      return {
        orderId: String(order.orderId),
        statusText: order.status === 'PAID' ? '결제 완료' : String(order.status),
        createdAt: String(order.createdAt),
        items: order.items.map(window.HaruCart.mapLineItem),
        totalQuantity: Number(order.totalQuantity),
        totalPriceText: window.HaruCart.formatPrice(order.totalPrice)
      };
    });
  }

  /* ---------- 렌더링 ---------- */

  function formatDateTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function span(testid, cls, text) {
    var s = document.createElement('span');
    s.className = cls;
    s.setAttribute('data-testid', testid);
    s.textContent = text;
    return s;
  }

  function createLine(item) {
    var li = document.createElement('li');
    li.className = 'summary-line';
    li.setAttribute('data-testid', 'history-line');
    li.setAttribute('data-product-id', item.productId);
    li.appendChild(span('history-line-name', 'summary-line__name', item.name));
    li.appendChild(span('history-line-quantity', 'summary-line__qty', String(item.quantity)));
    li.appendChild(span('history-line-total', 'summary-line__total', item.lineTotalText));
    return li;
  }

  function createCard(order) {
    var card = document.createElement('li');
    card.className = 'history-order';
    card.setAttribute('data-testid', 'history-order');
    card.setAttribute('data-order-id', order.orderId);

    var head = document.createElement('p');
    head.className = 'history-order__head';
    head.appendChild(span('history-order-id', 'history-order__id', order.orderId));
    head.appendChild(span('history-order-status', 'history-order__status', order.statusText));
    var time = document.createElement('time');
    time.className = 'history-order__time';
    time.setAttribute('data-testid', 'history-order-created-at');
    time.setAttribute('datetime', order.createdAt);   // ISO 원본 (19.13)
    time.textContent = formatDateTime(order.createdAt);
    head.appendChild(time);
    card.appendChild(head);

    var lines = document.createElement('ul');
    lines.className = 'summary-lines';
    order.items.forEach(function (item) { lines.appendChild(createLine(item)); });
    card.appendChild(lines);

    var totals = document.createElement('p');
    totals.className = 'history-order__head';
    totals.appendChild(document.createTextNode('총 수량 '));
    totals.appendChild(span('history-order-total-quantity', '', String(order.totalQuantity)));
    totals.appendChild(document.createTextNode(' · 총 금액 '));
    totals.appendChild(span('history-order-total-price', '', order.totalPriceText));
    card.appendChild(totals);

    var link = document.createElement('a');
    link.className = 'history-order__link';
    link.setAttribute('data-testid', 'history-order-link');
    link.setAttribute('href', '/order.html?orderId=' + encodeURIComponent(order.orderId));
    link.textContent = '주문 상세 보기';
    card.appendChild(link);
    return card;
  }

  function renderOrders(orders) {
    el.list.textContent = '';
    if (orders.length === 0) {
      showOnly('empty');
      return;
    }
    var frag = document.createDocumentFragment();
    orders.forEach(function (o) { frag.appendChild(createCard(o)); });   // 서버 순서 그대로
    el.list.appendChild(frag);
    showOnly('list');
  }

  /* ---------- 게스트 확정 (목록 401 / 로그아웃 전이 — 단조) ---------- */

  function latchGuest() {
    guestLatched = true;
    el.list.textContent = '';        // 카드는 hidden이 아니라 DOM에서 제거 (D62)
    showOnly('login-required');
  }

  if (window.HaruAuth && typeof window.HaruAuth.subscribe === 'function') {
    window.HaruAuth.subscribe(function (state) {
      // '확정 전'과 '로그인 확정'은 본문에 영향을 주지 않는다. 게스트 확정만 반응한다.
      if (state && state.status === 'guest') latchGuest();
    });
  }

  /* ---------- 데이터 로드 (1회) ---------- */

  showOnly(guestLatched ? 'login-required' : 'loading');

  fetch('/api/me/orders', { headers: { Accept: 'application/json' } })
    .then(function (res) {
      if (res.status === 401) {
        latchGuest();
        return null;
      }
      if (!res.ok) {
        throw new Error('주문 내역 조회 실패 (상태코드 ' + res.status + ')');
      }
      return res.json().then(function (body) {
        var orders = mapOrdersResponse(body);
        if (guestLatched) return null;   // 이미 게스트 확정 — 목록으로 되돌아가지 않는다
        renderOrders(orders);
        return null;
      });
    })
    .catch(function (err) {
      console.error('[orders] 주문 내역 조회 실패:', err);
      if (!guestLatched) {
        el.list.textContent = '';
        showOnly('error');
      }
    });

  window.HaruCart.refreshBadge();
})();
