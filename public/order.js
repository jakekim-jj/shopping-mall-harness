/* 하루상점 — 주문 확인 화면 로직 (/order.html?orderId={orderId})
 *
 * 백엔드 계약(_workspace/02_backend_api-spec.md §2K)
 *   GET /api/orders/:orderId
 *     200 → { "order": { orderId, status, ordererName, ordererPhone, paymentMethod,
 *                          items(CartItem 11개 필드 그대로), totalQuantity, totalPrice, createdAt } }
 *     404 → { "error": { "message": "주문을 찾을 수 없습니다." } }
 *            (주문 없음 / 남의 주문(cartId 불일치) / 쿠키 없음 — 세 경우 모두 상태 코드·메시지가
 *             완전히 같다. 403이 아니다. 프론트도 셋을 구분하지 않고 전부 order-not-found로
 *             처리한다 — PRD 17.7 / 17.8 / D23)
 *
 * order.items는 CartItem과 완전히 동일한 shape이므로(스펙 §2J 데이터 모델 확정 사항),
 * cart-badge.js가 이미 만든 HaruCart.mapLineItem()을 그대로 재사용한다 — 이 화면 전용
 * 매핑 함수를 새로 만들지 않는다.
 *
 * 모든 금액/수량은 응답 값을 그대로 포맷팅만 해서 출력한다. 프론트가 재계산·재합산하지
 * 않는다 (PRD 17.3, 16.4와 같은 규칙).
 */
(function () {
  'use strict';

  var el = {
    loading: document.getElementById('order-loading'),
    notFound: document.getElementById('order-not-found'),
    error: document.getElementById('order-error'),
    confirmation: document.getElementById('order-confirmation'),
    orderId: document.getElementById('order-id'),
    status: document.getElementById('order-status'),
    createdAt: document.getElementById('order-created-at'),
    ordererName: document.getElementById('order-orderer-name'),
    ordererPhone: document.getElementById('order-orderer-phone'),
    list: document.getElementById('order-list'),
    totalQuantity: document.getElementById('order-total-quantity'),
    totalPrice: document.getElementById('order-total-price')
  };

  /* ---------- 매핑 지점 (API shape ↔ 화면 모델) ---------- */

  // { order: {...} } 한 겹을 벗기는 유일한 지점.
  function mapOrderResponse(body) {
    if (!body || typeof body !== 'object' || !body.order || typeof body.order !== 'object' ||
        !Array.isArray(body.order.items)) {
      throw new Error('예상과 다른 응답 형식입니다 (order 객체 없음)');
    }
    var order = body.order;
    return {
      orderId: String(order.orderId),
      // "결제 완료" 표시의 근거는 응답의 status 값이다. "여기까지 왔으면 성공"이라고
      // 하드코딩하지 않는다 (PRD 17.2).
      statusText: order.status === 'PAID' ? '결제 완료' : String(order.status),
      ordererName: String(order.ordererName),
      ordererPhone: String(order.ordererPhone),
      createdAt: String(order.createdAt),
      items: order.items.map(window.HaruCart.mapLineItem),   // CartItem과 동일 shape 재사용
      totalQuantity: Number(order.totalQuantity),
      totalPrice: Number(order.totalPrice),
      totalPriceText: window.HaruCart.formatPrice(order.totalPrice)
    };
  }

  /* ---------- 상태 전환 (loading / 정상 / not-found / error — PRD 17.11) ---------- */

  function showOnly(name) {
    el.loading.hidden = name !== 'loading';
    el.confirmation.hidden = name !== 'confirmation';
    el.notFound.hidden = name !== 'not-found';
    el.error.hidden = name !== 'error';
    el.loading.setAttribute('aria-busy', String(name === 'loading'));
  }

  /* ---------- 렌더링 ---------- */

  function createOrderLine(item) {
    var li = document.createElement('li');
    li.className = 'summary-line';
    li.setAttribute('data-testid', 'order-item');
    li.setAttribute('data-product-id', item.productId);

    var name = document.createElement('span');
    name.className = 'summary-line__name';
    name.setAttribute('data-testid', 'order-item-name');
    name.textContent = item.name;

    var qty = document.createElement('span');
    qty.className = 'summary-line__qty';
    qty.setAttribute('data-testid', 'order-item-quantity');
    qty.textContent = String(item.quantity);

    var total = document.createElement('span');
    total.className = 'summary-line__total';
    total.setAttribute('data-testid', 'order-item-total');
    total.textContent = item.lineTotalText;

    li.appendChild(name);
    li.appendChild(qty);
    li.appendChild(total);
    return li;
  }

  // 표시용 텍스트 형식은 재량이다 (PRD 19.13) — datetime 속성(ISO 원본)이 실제 단언 대상이다.
  function formatDateTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function renderOrder(order) {
    el.confirmation.setAttribute('data-order-id', order.orderId);

    el.orderId.textContent = order.orderId;
    el.status.textContent = order.statusText;

    el.createdAt.setAttribute('datetime', order.createdAt);   // ISO 8601 원본 그대로 (PRD 19.13)
    el.createdAt.textContent = formatDateTime(order.createdAt);

    el.ordererName.textContent = order.ordererName;
    el.ordererPhone.textContent = order.ordererPhone;

    var frag = document.createDocumentFragment();
    order.items.forEach(function (item) { frag.appendChild(createOrderLine(item)); });
    el.list.textContent = '';
    el.list.appendChild(frag);

    // 서버 계산값을 그대로 표시만 한다 (PRD 17.3 / 17.4 — 장바구니 총액과 정확히 같아야 함).
    el.totalQuantity.textContent = String(order.totalQuantity);
    el.totalPrice.textContent = order.totalPriceText;

    document.title = '주문 확인 — 하루상점';
    showOnly('confirmation');
  }

  /* ---------- 데이터 로드 ---------- */

  function readOrderIdFromUrl() {
    var raw = new URLSearchParams(window.location.search).get('orderId');
    return raw === null ? '' : raw.trim();
  }

  function loadOrder() {
    var orderId = readOrderIdFromUrl();

    // orderId가 없거나 빈 문자열이면 API를 호출하지 않고 바로 not-found (PRD 17.6, 6.9와 같은 규칙)
    if (!orderId) {
      showOnly('not-found');
      return;
    }

    showOnly('loading');

    fetch('/api/orders/' + encodeURIComponent(orderId), { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (res.status === 404) {
          // 없는 주문 / 남의 주문 / 쿠키 없음 — 서버가 이미 동일하게 합쳐 보내므로
          // 프론트도 구분 없이 전부 not-found로 처리한다 (PRD 17.7 / 17.8).
          showOnly('not-found');
          return null;
        }
        if (!res.ok) {
          return res.json()
            .catch(function () { return null; })
            .then(function (body) {
              throw new Error(window.HaruCart.readErrorMessage(body) || '주문 정보를 불러오지 못했습니다');
            });
        }
        return res.json().then(function (body) {
          renderOrder(mapOrderResponse(body));
          return null;
        });
      })
      .catch(function (err) {
        showOnly('error');
        console.error('[order] 주문 조회 실패:', err);
      });
  }

  loadOrder();

  // 배지 갱신용 GET /api/cart. 결제 성공 직후라면 장바구니가 비워졌으므로 배지는 0이 되어
  // 숨겨진다 (PRD 17.10). 이 호출이 실패해도 주문 렌더링에는 영향이 없다 — refreshBadge()는
  // 실패를 내부에서 삼키고 배지만 숨긴다 (cart-badge.js 참고).
  //
  // bug-history M4(쿠키 최초 발급 경쟁 조건)는 "쿠키가 아예 없는 첫 방문에서 장바구니 관련
  // 요청이 병렬로 여러 번 나가는 경우"에만 재발한다. 이 화면에 도달하는 경로(결제 성공 직후
  // 이동 / 기존 주문 URL 재방문)는 이미 cartId 쿠키가 존재하는 상태이거나, 쿠키가 없더라도
  // GET /api/orders/:orderId가 어차피 항상 not-found로 떨어지므로(17.8) 이 병렬 호출이
  // 주문 조회 결과에 영향을 주지 않는다 — PRD 17.10이 이 병렬 호출을 명시적으로 허용한 이유다.
  window.HaruCart.refreshBadge();
})();
