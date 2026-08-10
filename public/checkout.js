/* 하루상점 — 결제 화면 로직 (/checkout.html)
 *
 * 백엔드 계약(_workspace/02_backend_api-spec.md §2J)
 *   GET  /api/cart               (기존 엔드포인트 재사용 — 결제 화면 전용 요약 API는 없다, PRD 16.1)
 *   POST /api/checkout   body { ordererName, ordererPhone, paymentMethod }  ← 딱 3개 필드만
 *     200 → { "order": { orderId, status, ordererName, ordererPhone, paymentMethod,
 *                          items(CartItem 11개 필드), totalQuantity, totalPrice, createdAt } }
 *     402 → { "error": { "message": "결제가 승인되지 않았습니다. ..." } }   승인 거절, 장바구니 불변
 *     400 → { "error": { "message": "..." } }   입력 검증 실패 (이름/연락처/결제수단 중 하나)
 *     409 → { "error": { "message": "장바구니가 비어 있어 결제할 수 없습니다." } }
 *
 * ⚠ 이 화면은 GET /api/cart를 "한 번"만 호출해 주문 요약과 헤더 배지를 동시에 채운다 (PRD 16.1).
 *   배지 갱신을 위한 별도 호출(HaruCart.refreshBadge())을 추가하지 않는다 — 페이지 로드 시
 *   장바구니 관련 API를 병렬로 여러 번 부르는 패턴은
 *   docs/bug-history/2026-08-08_cart-session-race-condition.md(M4, 쿠키 최초 발급 경쟁 조건)가
 *   재발 조건으로 직접 지목한 패턴이다. 이 파일은 getCart() 결과 하나로 요약(renderSummary)과
 *   배지(updateBadge)를 모두 채운다.
 *
 * ⚠ paymentMethod === 'MOCK_FAILURE'라고 프론트가 미리 판정해 요청 없이 실패 화면을 그리지 않는다
 *   (PRD 16.9). 항상 서버에 POST /api/checkout을 보내고, 응답 상태 코드로만 성공/실패를 가른다.
 *
 * 매핑 지점: 장바구니 응답은 cart-badge.js의 HaruCart.getCart()(= mapCartResponse())를 그대로
 *   재사용한다 — cart.js와 완전히 동일한 필드(name/quantity/lineTotalText 등)가 이미 매핑되어
 *   있으므로 이 파일에는 금액을 계산하는 산술이 없다 (PRD 16.4 — 서버 값을 포맷팅만 해서 출력).
 */
(function () {
  'use strict';

  var el = {
    loading: document.getElementById('checkout-loading'),
    empty: document.getElementById('checkout-empty'),
    ready: document.getElementById('checkout-ready'),
    error: document.getElementById('checkout-error'),
    errorMessage: document.getElementById('checkout-error-message'),
    errorAction: document.getElementById('checkout-error-action'),
    itemList: document.getElementById('checkout-item-list'),
    totalQuantity: document.getElementById('checkout-total-quantity'),
    totalPrice: document.getElementById('checkout-total-price'),
    form: document.getElementById('checkout-form'),
    name: document.getElementById('orderer-name'),
    phone: document.getElementById('orderer-phone'),
    submit: document.getElementById('checkout-submit')
  };

  var submitting = false;   // 결제 요청 진행 중 중복 클릭 방지 (PRD 16.10)

  /* ---------- 상태 전환 (loading / ready / empty / load-error — PRD 16.17) ---------- */
  //
  // checkout-error는 이 함수가 관리하는 3상태(loading/empty/ready)와 다른 축으로 토글된다.
  //   - 초기 GET /api/cart 자체가 실패하면 'load-error' phase로 단독 표시된다("화면 전체 에러 상태").
  //   - ready 진입 이후 결제 요청(POST /api/checkout)이 실패하면 showSubmitError()가
  //     checkout-ready 위에 겹쳐서 보여준다 — 이는 16.12~16.14가 명시한 예외 규정이며,
  //     이 함수를 다시 호출하지 않고 el.error만 별도로 토글해서 구현한다.
  function showPhase(phase) {
    el.loading.hidden = phase !== 'loading';
    el.empty.hidden = phase !== 'empty';
    el.ready.hidden = phase !== 'ready';
    el.error.hidden = phase !== 'load-error';
    el.errorAction.hidden = true;
    el.loading.setAttribute('aria-busy', String(phase === 'loading'));
  }

  function showSubmitError(message, withProductLink) {
    el.errorMessage.textContent = message;
    el.errorAction.hidden = !withProductLink;
    el.error.hidden = false;
  }

  function hideSubmitError() {
    el.error.hidden = true;
  }

  /* ---------- 렌더링 (읽기 전용 요약 — PRD 16.2) ---------- */

  function createSummaryLine(item) {
    var li = document.createElement('li');
    li.className = 'summary-line';
    li.setAttribute('data-testid', 'checkout-item');
    li.setAttribute('data-product-id', item.productId);

    var name = document.createElement('span');
    name.className = 'summary-line__name';
    name.setAttribute('data-testid', 'checkout-item-name');
    name.textContent = item.name;

    var qty = document.createElement('span');
    qty.className = 'summary-line__qty';
    qty.setAttribute('data-testid', 'checkout-item-quantity');
    qty.textContent = String(item.quantity);

    // 줄 합계 = 서버의 lineTotal(할인 후 최종 금액) 그대로. 프론트가 재계산하지 않는다 (PRD 16.4).
    var total = document.createElement('span');
    total.className = 'summary-line__total';
    total.setAttribute('data-testid', 'checkout-item-total');
    total.textContent = item.lineTotalText;

    li.appendChild(name);
    li.appendChild(qty);
    li.appendChild(total);
    return li;
  }

  function renderSummary(cart) {
    var frag = document.createDocumentFragment();
    cart.items.forEach(function (item) { frag.appendChild(createSummaryLine(item)); });
    el.itemList.textContent = '';
    el.itemList.appendChild(frag);

    // 서버 계산값을 그대로 표시만 한다 — 프론트에서 다시 합산하지 않는다 (PRD 16.4 / D12).
    el.totalQuantity.textContent = String(cart.totalQuantity);
    el.totalPrice.textContent = cart.totalPriceText;
  }

  /* ---------- 초기 로드 (PRD 16.1 — GET /api/cart 한 번으로 요약+배지 동시 채움) ---------- */

  function loadCheckout() {
    showPhase('loading');
    window.HaruCart.getCart()
      .then(function (cart) {
        // 배지도 같은 응답으로 채운다. 별도의 refreshBadge()(추가 GET /api/cart) 호출은 하지 않는다
        // (PRD 16.1/16.19, bug-history M4 회피).
        window.HaruCart.updateBadge(cart.totalQuantity);

        if (cart.items.length === 0) {
          // 빈 장바구니로 직접 접속 — 폼 자체를 그리지 않는다 (PRD 16.16)
          showPhase('empty');
          return;
        }
        renderSummary(cart);
        showPhase('ready');
      })
      .catch(function (err) {
        window.HaruCart.hideBadge();
        showPhase('load-error');
        el.errorMessage.textContent = (err && err.message) ||
          '장바구니 정보를 불러오지 못했습니다. 페이지를 새로고침해 주세요.';
        console.error('[checkout] 장바구니 로드 실패:', err);
      });
  }

  /* ---------- 결제 요청 (PRD 16.8~16.16) ---------- */

  function readSelectedPaymentMethod() {
    var checked = el.form.querySelector('input[name="payment-method"]:checked');
    return checked ? checked.value : '';
  }

  function submitCheckout(payload) {
    return fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json()
        .catch(function () { return null; })
        .then(function (body) { return { status: res.status, body: body }; });
    });
  }

  function setSubmitting(value) {
    submitting = value;
    // 이중 클릭 방지. 응답이 도착하면(성공/실패/에러 모두) 다시 활성화된다 (PRD 16.10).
    el.submit.disabled = value;
  }

  function onSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    hideSubmitError();
    setSubmitting(true);

    // 서버는 이 3개 필드만 받는다 — 금액/상품 목록/수량을 body에 담지 않는다 (PRD 16.8 / D12).
    // 결제 대상과 금액은 서버가 cartId 쿠키의 현재 장바구니에서 직접 계산한다.
    // paymentMethod가 MOCK_FAILURE라도 여기서 미리 실패로 판정하지 않고 그대로 서버에 보낸다 (PRD 16.9).
    var payload = {
      ordererName: el.name.value,
      ordererPhone: el.phone.value,
      paymentMethod: readSelectedPaymentMethod()
    };

    submitCheckout(payload)
      .then(function (result) {
        if (result.status === 200) {
          var orderId = result.body && result.body.order && result.body.order.orderId;
          if (!orderId) {
            throw new Error('결제 응답에서 주문번호를 찾을 수 없습니다');
          }
          // 성공 메시지를 이 화면에 띄우고 머무르지 않는다 — 곧바로 주문 확인 화면으로 이동한다 (PRD 16.11).
          window.location.href = '/order.html?orderId=' + encodeURIComponent(orderId);
          return;
        }

        var message = window.HaruCart.readErrorMessage(result.body);
        if (result.status === 409) {
          // 빈 장바구니 — 상품 목록으로 가는 링크를 함께 보여준다. 화면 이동은 하지 않는다 (PRD 16.14).
          showSubmitError(message || '장바구니가 비어 있어 결제할 수 없습니다.', true);
        } else if (result.status === 402) {
          // 승인 거절 — 입력값·요약은 그대로 유지하고 화면에 머무른다 (PRD 16.12).
          // 장바구니는 서버가 비우지 않았으므로(18.4) 이 화면도 별도로 다시 조회하지 않는다.
          showSubmitError(message || '결제가 승인되지 않았습니다.', false);
        } else if (result.status === 400) {
          // 입력 검증 실패 — 화면 이동 없음 (PRD 16.13)
          showSubmitError(message || '입력값을 확인해 주세요.', false);
        } else {
          // 예상치 못한 상태 코드(5xx 등) (PRD 16.20)
          showSubmitError(message || '결제 요청을 처리하지 못했습니다.', false);
        }
      })
      .catch(function (err) {
        // 네트워크 오류 (PRD 16.20). 장바구니는 건드리지 않는다 — 요청을 보내자마자
        // 미리 비우거나 배지를 0으로 만드는 낙관적 갱신을 하지 않는다 (PRD 16.15).
        showSubmitError(
          (err && err.message) || '결제 요청을 처리하지 못했습니다. 네트워크 상태를 확인해 주세요.',
          false
        );
        console.error('[checkout] 결제 요청 실패:', err);
      })
      .then(function () {
        // 성공(이동)·실패·에러 모두 재활성화한다 (PRD 16.10). 성공 시에는 곧 페이지가 이동하므로
        // 실질적인 영향은 없지만, 규칙을 예외 없이 지킨다.
        setSubmitting(false);
      });
  }

  el.form.addEventListener('submit', onSubmit);
  loadCheckout();
})();
