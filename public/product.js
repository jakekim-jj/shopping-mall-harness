/* 하루상점 — 상품 상세 화면 로직 (/product.html?id={productId})
 *
 * 백엔드 계약(_workspace/02_backend_api-spec.md §2A, §2D)
 *   GET /api/products/:id
 *     200 → { "item": { id, name, price, imageUrl, description } }   ← 단수 "item", 한 겹
 *     404 → { "error": { "message": "..." } }                        ← not-found 상태
 *   POST /api/cart/items   body { productId, quantity }
 *     200 → { "cart": { items, totalQuantity, totalPrice } }         ← 두 겹, cart-badge.js가 처리
 *     400/404 → { "error": { "message": "..." } }
 *
 * shape이 바뀌면 mapDetailResponse() / mapProduct() 두 함수만 고치면 된다.
 * 장바구니 응답을 벗기는 코드는 이 파일에 없다 — 전부 cart-badge.js의 callCart()가 담당한다.
 */
(function () {
  'use strict';

  var MIN_QTY = 1;
  var MAX_QTY = 99;
  var SUCCESS_VISIBLE_MS = 5000;

  var el = {
    loading: document.getElementById('detail-loading'),
    notFound: document.getElementById('detail-not-found'),
    error: document.getElementById('detail-error'),
    detail: document.getElementById('product-detail'),
    panel: document.getElementById('detail-panel'),
    image: document.getElementById('detail-image'),
    name: document.getElementById('detail-name'),
    price: document.getElementById('detail-price'),
    description: document.getElementById('detail-description'),
    qtyInput: document.getElementById('quantity-input'),
    qtyDec: document.getElementById('quantity-decrease'),
    qtyInc: document.getElementById('quantity-increase'),
    addBtn: document.getElementById('add-to-cart'),
    okMsg: document.getElementById('add-to-cart-success'),
    errMsg: document.getElementById('add-to-cart-error')
  };

  var currentProductId = '';
  var adding = false;
  var successTimer = null;

  /* ---------- 매핑 지점 (API shape ↔ 화면 모델) ---------- */

  function mapProduct(item) {
    return {
      id: String(item.id),
      name: String(item.name),
      priceText: window.HaruCart.formatPrice(item.price),
      imageUrl: String(item.imageUrl),
      description: typeof item.description === 'string' ? item.description : ''
    };
  }

  // { item: {...} } 한 겹을 벗기는 유일한 지점. (장바구니의 { cart: { items } } 두 겹과 다르다)
  function mapDetailResponse(body) {
    if (!body || typeof body !== 'object' || !body.item || typeof body.item !== 'object') {
      throw new Error('예상과 다른 응답 형식입니다 (item 객체 없음)');
    }
    return mapProduct(body.item);
  }

  /* ---------- 상태 전환 (loading / detail / not-found / error 중 하나만 — PRD 6.10) ---------- */

  function showOnly(name) {
    el.loading.hidden = name !== 'loading';
    el.detail.hidden = name !== 'detail';
    el.notFound.hidden = name !== 'not-found';
    el.error.hidden = name !== 'error';
    el.loading.setAttribute('aria-busy', String(name === 'loading'));
  }

  /* ---------- 수량 UI (PRD 6.3 — 1 이상 99 이하 정수) ---------- */

  function readQuantity() {
    var n = parseInt(el.qtyInput.value, 10);
    if (!isFinite(n)) return MIN_QTY;
    return n;
  }

  function clamp(n) {
    if (!isFinite(n)) return MIN_QTY;
    return Math.min(MAX_QTY, Math.max(MIN_QTY, Math.trunc(n)));
  }

  // 값이 경계면 해당 버튼을 disabled로 만든다. 핸들러 안에서도 한 번 더 막는다(이중 방어).
  function setQuantity(n) {
    var q = clamp(n);
    el.qtyInput.value = String(q);
    el.qtyDec.disabled = q <= MIN_QTY;
    el.qtyInc.disabled = q >= MAX_QTY;
    return q;
  }

  function bindQuantity() {
    el.qtyDec.addEventListener('click', function () {
      var q = clamp(readQuantity());
      if (q <= MIN_QTY) return;      // 1에서 감소는 아무 일도 하지 않는다 (0/음수 불가)
      setQuantity(q - 1);
    });

    el.qtyInc.addEventListener('click', function () {
      var q = clamp(readQuantity());
      if (q >= MAX_QTY) return;      // 99에서 증가는 아무 일도 하지 않는다
      setQuantity(q + 1);
    });

    // 직접 타이핑/붙여넣기도 같은 범위로 정규화한다 (빈 값·소수·음수·100 이상)
    el.qtyInput.addEventListener('change', function () { setQuantity(readQuantity()); });
    el.qtyInput.addEventListener('blur', function () { setQuantity(readQuantity()); });
  }

  /* ---------- 담기 피드백 ---------- */

  function clearFeedback() {
    if (successTimer) { clearTimeout(successTimer); successTimer = null; }
    el.okMsg.hidden = true;
    el.errMsg.hidden = true;
    el.errMsg.textContent = '';
  }

  function showSuccess() {
    clearFeedback();
    el.okMsg.hidden = false;
    successTimer = setTimeout(function () {
      el.okMsg.hidden = true;
      successTimer = null;
    }, SUCCESS_VISIBLE_MS);
  }

  function showAddError(message) {
    clearFeedback();
    el.errMsg.textContent = message || '장바구니에 담지 못했습니다';
    el.errMsg.hidden = false;
  }

  /* ---------- 렌더링 ---------- */

  function renderDetail(product) {
    currentProductId = product.id;
    el.detail.setAttribute('data-product-id', product.id);

    el.panel.classList.remove('is-broken');
    el.image.src = product.imageUrl;
    el.image.alt = product.name;

    el.name.textContent = product.name;
    el.price.textContent = product.priceText;
    el.description.textContent = product.description;

    document.title = product.name + ' — 하루상점';
    setQuantity(MIN_QTY);
    clearFeedback();
    showOnly('detail');
  }

  // 이미지 로드 실패 시에도 패널이 자리를 유지한다 (PRD 1.4와 같은 처리)
  el.image.addEventListener('error', function () {
    el.panel.classList.add('is-broken');
  });

  /* ---------- 장바구니 담기 (PRD 6.4~6.7) ---------- */

  function addToCart() {
    if (adding || !currentProductId) return;
    var quantity = setQuantity(readQuantity());   // 보내기 직전에 한 번 더 정규화

    adding = true;
    el.addBtn.disabled = true;
    clearFeedback();

    window.HaruCart.addItem(currentProductId, quantity)
      .then(function (cart) {
        // 성공 시에만 배지를 갱신한다. 값은 서버가 계산한 totalQuantity 그대로 (PRD 5.6).
        window.HaruCart.updateBadge(cart.totalQuantity);
        showSuccess();
        // 장바구니 화면으로 자동 이동하지 않는다 (PRD 6.5) — 사용자는 상세에 머문다.
      })
      .catch(function (err) {
        // 실패했으면 배지를 건드리지 않는다 (PRD 6.7) — 담기지도 않았는데 담긴 것처럼 보이면 안 된다.
        showAddError(err && err.message);
        console.error('[cart] 담기 실패:', err);
      })
      .then(function () {
        adding = false;
        el.addBtn.disabled = false;
      });
  }

  /* ---------- 데이터 로드 ---------- */

  function readProductIdFromUrl() {
    var raw = new URLSearchParams(window.location.search).get('id');
    return raw === null ? '' : raw.trim();
  }

  function loadProduct() {
    var id = readProductIdFromUrl();

    // id가 없거나 빈 문자열이면 API를 호출하지 않고 바로 not-found (PRD 6.9)
    if (!id) {
      showOnly('not-found');
      return;
    }

    showOnly('loading');

    fetch('/api/products/' + encodeURIComponent(id), { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (res.status === 404) {
          showOnly('not-found');           // 404는 에러가 아니라 not-found 상태다 (PRD 6.8)
          return null;
        }
        if (!res.ok) {
          return res.json()
            .catch(function () { return null; })
            .then(function (body) {
              throw new Error(window.HaruCart.readErrorMessage(body) || '상품 정보를 불러오지 못했습니다');
            });
        }
        return res.json().then(function (body) {
          renderDetail(mapDetailResponse(body));
          return null;
        });
      })
      .catch(function (err) {
        showOnly('error');
        console.error('[product] 상세 로드 실패:', err);
      });
  }

  bindQuantity();
  el.addBtn.addEventListener('click', addToCart);
  loadProduct();
  window.HaruCart.refreshBadge();
})();
