/* 하루상점 — 상품 목록 화면 로직
 *
 * 백엔드 계약(_workspace/02_backend_api-spec.md)
 *   GET /api/products
 *     200 → { "items": [ { id, name, price, imageUrl, description } ] }   ← 배열이 아니라 객체
 *     200 → { "items": [] }                                              ← 상품 0개도 200
 *     5xx → { "error": { "message": "..." } }                            ← message는 error 안에 중첩
 *
 * API shape이 바뀌면 아래 mapProductListResponse() / mapProduct() 두 함수만 고치면 된다.
 *
 * [2차 사이클 변경 — 2026-08-08]
 *   - 카드 내용을 <a href="/product.html?id={id}">로 감싸 상세 화면 링크가 됐다 (PRD 5.1, 1.6 폐기).
 *     data-testid / data-product-id 위치는 그대로 <li>에 남는다 (PRD 5.3).
 *   - 카드에 "장바구니 담기" 버튼은 여전히 두지 않는다 (PRD 5.2 / D7) — 카드의 클릭 동작은 상세 이동 하나뿐.
 *   - 헤더 장바구니 배지는 cart-badge.js가 GET /api/cart로 채운다. 그 호출이 실패해도
 *     목록 렌더링에는 영향이 없다 (PRD 5.7).
 */
(function () {
  'use strict';

  var PRODUCTS_ENDPOINT = '/api/products';

  var el = {
    list: document.getElementById('product-list'),
    loading: document.getElementById('loading-state'),
    empty: document.getElementById('empty-state'),
    error: document.getElementById('error-state'),
    count: document.getElementById('product-count')
  };

  /* ---------- 매핑 지점 (API shape ↔ 화면 모델) ---------- */

  // API item 1개 → 화면 카드가 쓰는 형태
  function mapProduct(item) {
    return {
      id: String(item.id),
      name: String(item.name),
      priceText: formatPrice(item.price),
      imageUrl: String(item.imageUrl),
      description: typeof item.description === 'string' ? item.description : ''
    };
  }

  // 성공 응답 본문 → 카드 배열. items 래핑을 벗기는 유일한 지점.
  function mapProductListResponse(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.items)) {
      // 계약상 성공 응답에는 항상 items 배열이 있다. 없으면 계약 위반이므로 에러로 취급.
      throw new Error('예상과 다른 응답 형식입니다 (items 배열 없음)');
    }
    return body.items.map(mapProduct);
  }

  // 에러 응답 본문 → 사용자에게 보여줄 문구. { error: { message } } 를 벗기는 유일한 지점.
  function readErrorMessage(body) {
    if (body && typeof body === 'object' && body.error && typeof body.error.message === 'string') {
      return body.error.message;
    }
    return '';
  }

  // price는 원 단위 정수 → "19,000원" (PRD 1.3, 소수점 없음)
  function formatPrice(price) {
    var n = Number(price);
    if (!isFinite(n)) return '가격 정보 없음';
    return Math.round(n).toLocaleString('ko-KR') + '원';
  }

  /* ---------- 상태 전환 (loading / empty / error / list 중 하나만) ---------- */

  function showOnly(name) {
    el.loading.hidden = name !== 'loading';
    el.empty.hidden = name !== 'empty';
    el.error.hidden = name !== 'error';
    el.list.hidden = name !== 'list';
    el.loading.setAttribute('aria-busy', String(name === 'loading'));
  }

  function setCount(text) {
    el.count.textContent = text;
  }

  /* ---------- 렌더링 ---------- */

  function createCard(product, index) {
    var li = document.createElement('li');
    li.className = 'card';
    li.setAttribute('data-testid', 'product-card');
    li.setAttribute('data-product-id', product.id);

    // 카드 전체가 상세로 가는 링크다 (PRD 5.1). JS onclick이 아니라 실제 <a href>라서
    // 새 탭 열기·뒤로가기가 브라우저 기본 동작으로 된다.
    var link = document.createElement('a');
    link.className = 'card__link';
    link.href = '/product.html?id=' + encodeURIComponent(product.id);

    var panel = document.createElement('div');
    panel.className = 'card__panel';
    panel.setAttribute('data-tint', String(index % 3));

    var img = document.createElement('img');
    img.className = 'card__img';
    img.setAttribute('data-testid', 'product-image');
    img.src = product.imageUrl;
    img.alt = product.name;
    img.loading = 'lazy';
    // 이미지 실패 시에도 패널이 자리를 유지한다 (PRD 1.4)
    img.addEventListener('error', function () {
      panel.classList.add('is-broken');
    });

    var fallback = document.createElement('span');
    fallback.className = 'card__fallback';
    fallback.textContent = '이미지 준비 중';

    panel.appendChild(img);
    panel.appendChild(fallback);

    var name = document.createElement('h2');
    name.className = 'card__name';
    name.setAttribute('data-testid', 'product-name');
    name.textContent = product.name;

    var priceRow = document.createElement('p');
    priceRow.className = 'card__price-row';

    var leader = document.createElement('span');
    leader.className = 'card__leader';
    leader.setAttribute('aria-hidden', 'true');

    var price = document.createElement('span');
    price.className = 'card__price';
    price.setAttribute('data-testid', 'product-price');
    price.textContent = product.priceText;

    priceRow.appendChild(leader);
    priceRow.appendChild(price);

    link.appendChild(panel);
    link.appendChild(name);

    if (product.description) {
      var desc = document.createElement('p');
      desc.className = 'card__desc';
      desc.textContent = product.description;
      link.appendChild(desc);
    }

    link.appendChild(priceRow);
    li.appendChild(link);
    return li;
  }

  function renderProducts(products) {
    var frag = document.createDocumentFragment();
    products.forEach(function (product, index) {
      frag.appendChild(createCard(product, index));
    });
    el.list.textContent = '';
    el.list.appendChild(frag);
  }

  /* ---------- 데이터 로드 ---------- */

  function loadProducts() {
    showOnly('loading');
    setCount('상품을 불러오는 중');

    fetch(PRODUCTS_ENDPOINT, { headers: { Accept: 'application/json' } })
      .then(function (res) {
        // 성공/실패는 상태 코드로 판단한다 (body 내용으로 판단하지 않음)
        if (!res.ok) {
          return res.json()
            .catch(function () { return null; })
            .then(function (body) {
              throw new Error(readErrorMessage(body) || '상품을 불러오지 못했습니다');
            });
        }
        return res.json();
      })
      .then(function (body) {
        var products = mapProductListResponse(body);

        if (products.length === 0) {
          renderProducts([]);           // 카드 0개 보장 (PRD 2.2)
          setCount('판매 중 0점');
          showOnly('empty');
          return;
        }

        renderProducts(products);
        setCount('판매 중 ' + products.length + '점');
        showOnly('list');
      })
      .catch(function (err) {
        renderProducts([]);             // 에러 화면에 이전 카드가 남지 않게 비운다
        setCount('목록 불러오기 실패');
        showOnly('error');
        console.error('[products] 목록 로드 실패:', err);
      });
  }

  loadProducts();

  // 헤더 배지 채우기 (PRD 5.4/5.7). loadProducts()와 독립적으로 돌며,
  // 실패해도 cart-badge.js 안에서 삼켜져 목록 화면이 에러 상태가 되지 않는다.
  if (window.HaruCart) {
    window.HaruCart.refreshBadge();
  }
})();
