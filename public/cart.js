/* 하루상점 — 장바구니 화면 로직 (/cart.html)
 *
 * 백엔드 계약(_workspace/02_backend_api-spec.md §2B~§2I)
 *   GET    /api/cart
 *   PATCH  /api/cart/items/:productId   body { quantity }   ← 변경 후 "절대 수량" (delta 아님)
 *   DELETE /api/cart/items/:productId
 *   DELETE /api/cart                    ← 3차 신규: 전체 비우기 (한 번만 호출, PRD 11.1)
 *
 *   네 엔드포인트 모두 200 → { "cart": { items, totalQuantity, totalPrice } } (두 겹)
 *   → 조회/변경/삭제/비우기 어느 쪽이든 renderCart() 하나로 화면을 다시 그린다 (PRD 9.7 / 13.5).
 *
 * 계산은 전부 서버가 한다. 이 파일에는 lineTotal/totalQuantity/totalPrice/할인 금액을 만드는
 * 산술이 없다 — 응답의 값을 표시 포맷만 입혀 그대로 그린다 (PRD 7.6 / 9.8 / D12).
 *
 * ⚠ 3차: lineTotal의 "의미"만 바뀌었고(할인 후 최종 금액) 줄 합계에 그릴 필드는 그대로다.
 *   따라서 cart-item-total을 그리는 코드는 2차에서 한 글자도 고치지 않았다 (PRD 12.12 / 스펙 배너).
 *
 * 응답을 벗기는 지점은 cart-badge.js의 mapCartResponse() 한 곳뿐이다.
 */
(function () {
  'use strict';

  var MIN_QTY = 1;
  var MAX_QTY = 99;

  // 안내 문구의 접두사. 할인율 숫자는 응답의 discountPercent를 쓰고 하드코딩하지 않는다 (PRD 12.15).
  // 기준 수량은 응답에 실려오지 않으므로 문구용 상수로만 둔다 — 이 값을 조건 분기에 쓰지 않는다.
  // 할인 여부 판정은 오직 서버의 discountApplied다 (PRD 12.11).
  var DISCOUNT_NOTICE_PREFIX = '10개 이상 ';

  var el = {
    loading: document.getElementById('cart-loading'),
    empty: document.getElementById('cart-empty'),
    error: document.getElementById('cart-error'),
    errorTitle: document.getElementById('cart-error-title'),
    errorBody: document.getElementById('cart-error-body'),
    retry: document.getElementById('cart-retry'),
    list: document.getElementById('cart-list'),
    clear: document.getElementById('cart-clear'),
    summary: document.getElementById('cart-summary'),
    totalQuantity: document.getElementById('cart-total-quantity'),
    totalPrice: document.getElementById('cart-total-price')
  };

  var busy = false;   // 요청 진행 중 중복 클릭 방지 (연타로 stale 수량이 날아가는 것을 막는다)

  /* ---------- 상태 전환 (loading / list / empty / error 중 하나만 — PRD 7.9) ---------- */

  function showOnly(name) {
    el.loading.hidden = name !== 'loading';
    el.list.hidden = name !== 'list';
    el.empty.hidden = name !== 'empty';
    el.error.hidden = name !== 'error';
    // 합계 요약은 목록이 있을 때만 보인다 (PRD 7.7)
    el.summary.hidden = name !== 'list';
    // 비우기 버튼도 담긴 항목이 있을 때만 보인다. 요소는 지우지 않고 hidden만 토글한다
    // (PRD 11.5 / 14.1 — cart-count와 같은 규칙. styles.css의 [hidden]{display:none!important}가 이를 보장한다)
    el.clear.hidden = name !== 'list';
    el.loading.setAttribute('aria-busy', String(name === 'loading'));
  }

  function showError(title, message) {
    el.errorTitle.textContent = title;
    el.errorBody.textContent = message || '잠시 후 다시 시도해 주세요.';
    showOnly('error');
  }

  /* ---------- 렌더링 ---------- */

  function createLine(item) {
    var li = document.createElement('li');
    li.className = 'line';
    li.setAttribute('data-testid', 'cart-item');
    li.setAttribute('data-product-id', item.productId);   // 줄 식별자는 productId 하나뿐 (D8)

    var panel = document.createElement('div');
    panel.className = 'line__panel';

    var img = document.createElement('img');
    img.className = 'line__img';
    img.src = item.imageUrl;
    img.alt = item.name;
    img.loading = 'lazy';
    img.addEventListener('error', function () { panel.classList.add('is-broken'); });

    var fallback = document.createElement('span');
    fallback.className = 'line__fallback';
    fallback.textContent = '이미지 준비 중';

    panel.appendChild(img);
    panel.appendChild(fallback);

    var body = document.createElement('div');
    body.className = 'line__body';

    var name = document.createElement('h2');
    name.className = 'line__name';
    name.setAttribute('data-testid', 'cart-item-name');
    name.textContent = item.name;

    // 단가 자리. 할인 여부와 무관하게 언제나 "원래 단가(price)"다 — 값도 선택자도 2차 그대로 (PRD 10.10).
    // 할인 줄에서는 여기에 취소선 스타일만 붙는다 (PRD 12.9-1 / 14.5).
    var price = document.createElement('p');
    price.className = 'line__price';
    price.setAttribute('data-testid', 'cart-item-price');   // 단가(원가)
    price.textContent = item.priceText;

    var controls = document.createElement('div');
    controls.className = 'line__controls';

    var dec = document.createElement('button');
    dec.type = 'button';
    dec.className = 'qty__btn';
    dec.setAttribute('data-testid', 'cart-item-decrease');
    dec.setAttribute('aria-label', item.name + ' 수량 1 감소');
    dec.textContent = '−';
    // 수량 1에서는 감소가 동작하지 않는다 (PRD 7.4).
    // quantity 0은 서버가 400으로 거절하므로 "0을 보내 삭제"하는 경로 자체를 만들지 않는다.
    dec.disabled = item.quantity <= MIN_QTY;

    var qty = document.createElement('span');
    qty.className = 'qty__value';
    qty.setAttribute('data-testid', 'cart-item-quantity');
    qty.textContent = String(item.quantity);

    var inc = document.createElement('button');
    inc.type = 'button';
    inc.className = 'qty__btn';
    inc.setAttribute('data-testid', 'cart-item-increase');
    inc.setAttribute('aria-label', item.name + ' 수량 1 증가');
    inc.textContent = '+';
    inc.disabled = item.quantity >= MAX_QTY;

    controls.appendChild(dec);
    controls.appendChild(qty);
    controls.appendChild(inc);

    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'line__remove';
    remove.setAttribute('data-testid', 'cart-item-remove');
    remove.setAttribute('aria-label', item.name + ' 삭제');
    remove.textContent = '삭제';

    // 줄 합계 = 서버가 준 lineTotal. 3차에서 이 값의 의미가 "할인 후 최종 금액"으로 바뀌었지만
    // 참조하는 필드는 그대로이므로 이 두 줄은 2차에서 고치지 않았다 (PRD 12.12 / 스펙 §2H).
    var total = document.createElement('p');
    total.className = 'line__total';
    total.setAttribute('data-testid', 'cart-item-total');
    total.textContent = item.lineTotalText;

    body.appendChild(name);
    body.appendChild(price);

    // ---- 할인 UI (3차) ----
    // 그릴지 말지는 서버의 discountApplied 하나로만 판정한다 (PRD 12.11).
    // 프론트가 quantity >= 10을 다시 판정하지 않는다 — 경계 판정이 두 벌이 되는 순간
    // 서버의 실제 판정과 화면이 조용히 어긋난다 (수량 9와 10의 lineTotal이 같아지는 구간이 있어
    // 금액만으로는 눈에 띄지도 않는다 — 스펙 §2H의 경계값 표).
    if (item.discountApplied) {
      price.classList.add('line__price--struck');   // 원래 단가에 취소선 (PRD 14.5)

      var discounted = document.createElement('p');
      discounted.className = 'line__price-discounted';
      discounted.setAttribute('data-testid', 'cart-item-discounted-price');
      discounted.textContent = item.discountedUnitPriceText;   // 서버의 discountedUnitPrice 그대로
      body.appendChild(discounted);

      var notice = document.createElement('p');
      notice.className = 'line__discount-notice';
      notice.setAttribute('data-testid', 'cart-item-discount-notice');
      notice.textContent = DISCOUNT_NOTICE_PREFIX + item.discountPercent + '% 할인 적용';
      body.appendChild(notice);
    }
    // 할인 미적용 줄에서는 위 두 요소를 hidden으로 두는 것이 아니라 아예 만들지 않는다
    // (PRD 12.10 / 14.4 — qa-agent가 "요소 개수"로 할인 줄 수를 세기 때문).

    body.appendChild(controls);
    body.appendChild(remove);

    li.appendChild(panel);
    li.appendChild(body);
    li.appendChild(total);
    return li;
  }

  // 조회·변경·삭제 응답 전부 이 함수 하나로 그린다 (PRD 9.7).
  function renderCart(cart) {
    var frag = document.createDocumentFragment();
    cart.items.forEach(function (item) { frag.appendChild(createLine(item)); });
    el.list.textContent = '';
    el.list.appendChild(frag);

    // 서버 계산값을 그대로 표시만 한다 (프론트에서 재합산 없음 — PRD 7.6)
    el.totalQuantity.textContent = String(cart.totalQuantity);
    el.totalPrice.textContent = cart.totalPriceText;

    // 배지도 같은 응답에서 갱신 (PRD 5.6 / 11.3 — 비우기 성공 시 0이 되어 숨겨진다).
    // 별도의 GET /api/cart를 추가로 쏘지 않는다 (요청 병렬화를 늘리지 않기 위함 — bug-history M4).
    window.HaruCart.updateBadge(cart.totalQuantity);

    el.clear.disabled = false;

    // 마지막 줄을 지우면 새로고침 없이 곧바로 빈 상태로 전환된다 (PRD 7.8)
    showOnly(cart.items.length === 0 ? 'empty' : 'list');
  }

  /* ---------- 조작 ---------- */

  function setBusy(value) {
    busy = value;
    var buttons = el.list.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      if (value) {
        buttons[i].disabled = true;
      }
      // 해제는 하지 않는다 — 성공/실패 후 renderCart()가 목록을 다시 그리며
      // 각 버튼의 disabled를 수량 경계에 맞춰 새로 계산한다.
    }
    // 비우기 버튼은 목록 바깥에 있어 위 루프에 포함되지 않는다. 요청 중 연타를 막는다
    // (해제는 renderCart()에서 — 목록 버튼들과 같은 규칙).
    if (value) {
      el.clear.disabled = true;
    }
  }

  function runMutation(promise, failTitle) {
    setBusy(true);
    promise
      .then(function (cart) {
        setBusy(false);
        renderCart(cart);
      })
      .catch(function (err) {
        setBusy(false);
        // 실패 시 배지는 건드리지 않는다 (서버 상태가 안 바뀌었으므로)
        showError(failTitle, err && err.message);
        console.error('[cart] ' + failTitle + ':', err);
      });
  }

  function currentQuantity(lineEl) {
    var node = lineEl.querySelector('[data-testid="cart-item-quantity"]');
    var n = parseInt(node ? node.textContent : '', 10);
    return isFinite(n) ? n : MIN_QTY;
  }

  function onListClick(event) {
    var button = event.target.closest ? event.target.closest('button') : null;
    if (!button || busy) return;

    var lineEl = button.closest('[data-testid="cart-item"]');
    if (!lineEl) return;

    var productId = lineEl.getAttribute('data-product-id');
    var testid = button.getAttribute('data-testid');
    var quantity = currentQuantity(lineEl);

    if (testid === 'cart-item-remove') {
      // 항목을 제거하는 경로는 DELETE 하나뿐이다 (PRD 7.5)
      runMutation(window.HaruCart.removeItem(productId), '항목을 삭제하지 못했습니다');
      return;
    }

    if (testid === 'cart-item-increase') {
      if (quantity >= MAX_QTY) return;
      // 보내는 값은 delta(+1)가 아니라 "변경 후 절대 수량"이다 (스펙 §2E)
      runMutation(window.HaruCart.setQuantity(productId, quantity + 1), '수량을 변경하지 못했습니다');
      return;
    }

    if (testid === 'cart-item-decrease') {
      if (quantity <= MIN_QTY) return;   // 1에서 감소는 동작하지 않는다 (PATCH 0을 보내지 않는다)
      runMutation(window.HaruCart.setQuantity(productId, quantity - 1), '수량을 변경하지 못했습니다');
    }
  }

  function onClearClick() {
    if (busy) return;
    // 확인 단계 없이 클릭 한 번이 곧 실행이다 (PRD D10 / 11.4).
    // window.confirm / window.alert / 커스텀 확인 모달을 만들지 않는다 —
    // 네이티브 다이얼로그는 qa-agent의 브라우저 자동화를 그 자리에서 멈춰 세운다.
    //
    // DELETE /api/cart 한 번만 호출한다 (PRD 11.1 — 줄 수만큼 반복 DELETE 금지).
    // 요청을 보내자마자 화면을 미리 비우는 낙관적 갱신도 하지 않는다 (PRD 11.6):
    // 화면은 응답으로 받은 스냅샷을 renderCart()로 다시 그릴 때만 바뀐다.
    runMutation(window.HaruCart.clearCart(), '장바구니를 비우지 못했습니다');
  }

  /* ---------- 데이터 로드 ---------- */

  function loadCart() {
    showOnly('loading');
    window.HaruCart.getCart()
      .then(renderCart)
      .catch(function (err) {
        window.HaruCart.hideBadge();
        showError('장바구니를 불러오지 못했습니다', err && err.message);
        console.error('[cart] 조회 실패:', err);
      });
  }

  el.list.addEventListener('click', onListClick);
  el.clear.addEventListener('click', onClearClick);
  el.retry.addEventListener('click', loadCart);
  loadCart();
})();
