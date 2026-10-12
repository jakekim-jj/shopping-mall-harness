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
 *
 * ---------------------------------------------------------------------------------------------
 * 6차 추가 — 리뷰 영역 (PRD 27~29장 / 스펙 §2P~§2R)
 *
 * 백엔드 계약 (4개 엔드포인트가 전부 같은 스냅샷을 돌려준다 — D50 / 30.2)
 *   GET    /api/products/:productId/reviews         (세션 없어도 200)
 *   POST   /api/products/:productId/reviews   body { rating, content }       (세션 없으면 401)
 *   PATCH  /api/reviews/:reviewId             body { rating, content }       (세션 없으면 401)
 *   DELETE /api/reviews/:reviewId                                            (세션 없으면 401)
 *     200/201 → { "reviews": [ {reviewId,productId,email,rating,content,createdAt,isMine} ],
 *                 "averageRating": number|null, "reviewCount": number }
 *     4xx     → { "error": { "message": "..." } }
 *
 * 쓰기(작성/수정/삭제) 응답은 항상 전체 스냅샷이라 GET을 다시 호출하지 않는다 (27.3/28.8/29.7).
 * 응답을 벗기는 유일한 지점은 mapReviewSnapshot()이다 — shape이 바뀌면 여기만 고친다.
 *
 * 로그인 상태는 auth-header.js가 이미 받은 결과를 subscribe()로 구독해서 쓴다 — 이 파일은
 * GET /api/auth/me를 직접 호출하지 않는다 (D52 / 28.2, 화면당 호출 1회 유지).
 * "내 리뷰인가"는 서버가 계산해 준 review.isMine을 그대로 쓴다 — 이메일을 직접 비교하지 않는다.
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

  /* ---------- 리뷰 영역 요소 (6차 — PRD 27~29장) ---------- */

  var rv = {
    section: document.getElementById('review-section'),
    summary: document.getElementById('review-summary'),
    average: document.getElementById('review-average'),
    count: document.getElementById('review-count'),
    loading: document.getElementById('review-loading'),
    list: document.getElementById('review-list'),
    empty: document.getElementById('review-empty'),
    error: document.getElementById('review-error'),
    form: document.getElementById('review-form'),
    ratingSelect: document.getElementById('review-rating-select'),
    contentInput: document.getElementById('review-content-input'),
    contentCounter: document.getElementById('review-content-counter'),
    submitBtn: document.getElementById('review-submit'),
    loginNotice: document.getElementById('review-login-notice')
  };

  var JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

  var reviewProductId = '';          // GET /api/products/:id와 독립적으로, id가 확인되는 즉시 저장한다 (27.3)
  var reviewState = {
    snapshot: null,                 // 마지막으로 받은 { reviews, averageRating, reviewCount }
    editingReviewId: null,          // 인라인 수정 폼이 열려 있는 reviewId (한 번에 하나뿐 — D45)
    authStatus: 'unresolved',       // 'unresolved' | 'guest' | 'user' (auth-header.js 구독 — D52)
    submitting: false,              // 작성 제출 중 (이중 클릭 방지 — 28.10)
    rowBusy: {}                     // reviewId → true (수정 저장/삭제 요청 중 — 29.8)
  };

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
    // 리뷰 영역은 상세 화면의 다섯 번째 상태가 아니라 "정상" 상태의 하위 영역이다 (PRD 27.2).
    // 로딩/not-found/에러에서는 리뷰 영역 전체를 숨긴다 — 내부 상태(27.10)는 건드리지 않는다.
    rv.section.hidden = name !== 'detail';
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
    // 리뷰 조회 API도 호출하지 않는다 (PRD 27.2 마지막 bullet / 32장 E13).
    if (!id) {
      showOnly('not-found');
      return;
    }

    showOnly('loading');

    // 리뷰 조회는 상품 조회와 병렬로 나간다 — 상품 조회 결과를 기다리지 않는다 (PRD 27.3).
    // 상품이 404로 끝나도 리뷰 응답이 먼저 도착할 수 있지만, showOnly()가 리뷰 영역을 숨겨두므로
    // 화면에는 그려지지 않는다 (27.2).
    loadReviews(id);

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

  /* ===========================================================================================
   * 리뷰 영역 (6차 — PRD 27~29장 / 스펙 §2P~§2R)
   * =========================================================================================== */

  function reviewsCollectionUrl(productId) {
    return '/api/products/' + encodeURIComponent(productId) + '/reviews';
  }

  function reviewItemUrl(reviewId) {
    return '/api/reviews/' + encodeURIComponent(reviewId);
  }

  /* ---------- 매핑 지점 (API shape ↔ 화면 모델) — mapReviewSnapshot() 한 곳만 고치면 된다 ---------- */

  function mapReviewItem(raw) {
    return {
      reviewId: String(raw.reviewId),
      productId: String(raw.productId),
      email: String(raw.email),
      rating: Number(raw.rating),
      content: String(raw.content),
      createdAt: String(raw.createdAt),
      isMine: raw.isMine === true   // 서버가 판정한 값 그대로 — 이메일을 직접 비교하지 않는다 (D50/28.2)
    };
  }

  // top-level 키 3개({reviews, averageRating, reviewCount}) + 줄 7개를 그대로 옮긴다 (30.2).
  function mapReviewSnapshot(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.reviews)) {
      throw new Error('예상과 다른 응답 형식입니다 (reviews 배열 없음)');
    }
    return {
      reviews: body.reviews.map(mapReviewItem),
      // averageRating은 0개일 때 null — "0"으로 바뀌면 안 된다 (D50 / 27.4). falsy 검사 금지.
      averageRating: body.averageRating === null || body.averageRating === undefined
        ? null : Number(body.averageRating),
      reviewCount: Number(body.reviewCount)
    };
  }

  function parseReviewResponse(res) {
    return res.json()
      .catch(function () { return null; })
      .then(function (body) {
        if (!res.ok) {
          var err = new Error(window.HaruCart.readErrorMessage(body) || '리뷰 요청을 처리하지 못했습니다');
          err.status = res.status;
          throw err;
        }
        return mapReviewSnapshot(body);
      });
  }

  // 표시용 텍스트 형식은 재량이다 (PRD 27.7) — datetime 속성(ISO 원본)이 실제 단언 대상이다.
  function formatReviewDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
  }

  /* ---------- 내부 상태 전환 — 로딩/목록/빈 상태 3자 배타 + 에러는 독립 토글 ----------
   *
   * review-error는 조회 실패뿐 아니라 작성/수정/삭제 실패도 공유하는 단일 요소다 (31.8).
   * 작성/수정/삭제가 실패했을 때는 "목록·평균·개수가 실패 전 값 그대로" 보여야 하므로(28.9/29.9),
   * review-error는 로딩/목록/빈 상태와 동시에 보일 수 있다 — 오직 "조회 자체"가 실패했을 때만
   * setReviewDataState('none')으로 셋을 전부 숨기고 error만 보이게 한다 (27.9).
   */

  function setReviewDataState(name) {   // 'loading' | 'list' | 'empty' | 'none'
    rv.loading.hidden = name !== 'loading';
    rv.list.hidden = name !== 'list';
    rv.empty.hidden = name !== 'empty';
    // 요약(평균·개수)은 데이터가 있을 때(목록/빈 상태)만 보인다 (27.8 — 빈 상태에도 null 안내가 보인다).
    rv.summary.hidden = (name !== 'list' && name !== 'empty');
    rv.loading.setAttribute('aria-busy', String(name === 'loading'));
  }

  function showReviewError(message) {
    rv.error.textContent = message || '리뷰 요청을 처리하지 못했습니다';
    rv.error.hidden = false;
  }

  function clearReviewError() {
    rv.error.hidden = true;
    rv.error.textContent = '';
  }

  /* ---------- 작성 영역 (폼 / 비로그인 안내) — 28.11의 4상태 표를 그대로 코드로 옮긴다 ---------- */

  function hasMyReview() {
    return !!(reviewState.snapshot && reviewState.snapshot.reviews.some(function (r) { return r.isMine; }));
  }

  function updateWriteAreaVisibility() {
    if (reviewState.authStatus === 'unresolved') {
      rv.form.hidden = true;
      rv.loginNotice.hidden = true;
    } else if (reviewState.authStatus === 'guest') {
      rv.form.hidden = true;
      rv.loginNotice.hidden = false;
    } else {   // 'user'
      var mine = hasMyReview();
      rv.form.hidden = mine;          // 내 리뷰가 있으면 폼이 사라진다 (D45 / 28.8)
      rv.loginNotice.hidden = true;
    }
  }

  /* ---------- 요약 렌더 ---------- */

  function renderReviewSummary(snapshot) {
    rv.count.textContent = String(snapshot.reviewCount);   // reviews.length로 세지 않는다 (27.5)
    if (snapshot.averageRating === null) {
      rv.average.textContent = '아직 평점이 없습니다';       // 0·0.0·-·빈 문자열로 그리지 않는다 (27.4)
    } else {
      rv.average.textContent = String(snapshot.averageRating) + '점';   // 숫자 부분은 응답 값 그대로
    }
  }

  /* ---------- 목록 렌더 ---------- */

  function createReviewEditForm(review) {
    var wrap = document.createElement('div');
    wrap.className = 'review-edit-form';
    wrap.setAttribute('data-testid', 'review-edit-form');

    var ratingField = document.createElement('div');
    ratingField.className = 'field';
    var ratingLabel = document.createElement('label');
    ratingLabel.className = 'field__label';
    ratingLabel.textContent = '평점';
    var select = document.createElement('select');
    select.className = 'field__input';
    select.setAttribute('data-testid', 'review-edit-rating');
    // 빈 값 placeholder가 없다 — 이미 값이 있는 리뷰에는 "미선택" 상태가 없다 (29.3 / 31.10).
    [1, 2, 3, 4, 5].forEach(function (n) {
      var opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = String(n);
      if (n === review.rating) opt.selected = true;
      select.appendChild(opt);
    });
    ratingField.appendChild(ratingLabel);
    ratingField.appendChild(select);

    var contentField = document.createElement('div');
    contentField.className = 'field';
    var contentLabel = document.createElement('label');
    contentLabel.className = 'field__label';
    contentLabel.textContent = '리뷰 내용';
    // maxlength를 붙이지 않는다 (29.3 / 28.7과 같은 규칙).
    var textarea = document.createElement('textarea');
    textarea.className = 'field__input review-form__textarea';
    textarea.setAttribute('data-testid', 'review-edit-content');
    textarea.rows = 4;
    textarea.value = review.content;

    var counter = document.createElement('span');
    counter.className = 'review-form__counter';
    counter.setAttribute('data-testid', 'review-edit-content-counter');
    function updateEditCounter() {
      var len = textarea.value.length;
      counter.textContent = len + '/500';
      counter.classList.toggle('review-form__counter--over', len > 500);
    }
    updateEditCounter();
    textarea.addEventListener('input', updateEditCounter);

    contentField.appendChild(contentLabel);
    contentField.appendChild(textarea);
    contentField.appendChild(counter);

    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn--primary';
    saveBtn.setAttribute('data-testid', 'review-edit-save');
    saveBtn.textContent = '저장';

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.setAttribute('data-testid', 'review-edit-cancel');
    cancelBtn.textContent = '취소';

    wrap.appendChild(ratingField);
    wrap.appendChild(contentField);
    wrap.appendChild(saveBtn);
    wrap.appendChild(cancelBtn);
    return wrap;
  }

  function createReviewItem(review) {
    var li = document.createElement('li');
    li.className = 'review-item';
    li.setAttribute('data-testid', 'review-item');
    li.setAttribute('data-review-id', review.reviewId);   // 화면에 표시하지 않고 속성으로만 쓴다 (27.7/D44)

    var isEditing = reviewState.editingReviewId === review.reviewId;

    var email = document.createElement('p');
    email.className = 'review-item__email';
    email.setAttribute('data-testid', 'review-item-email');
    email.textContent = review.email;   // 마스킹 없이 전체 표시 (D43)
    li.appendChild(email);

    var rating = document.createElement('p');
    rating.className = 'review-item__rating';
    rating.setAttribute('data-testid', 'review-item-rating');
    rating.textContent = String(review.rating);
    rating.hidden = isEditing;   // 수정 폼이 열린 동안 표시를 숨긴다 (29.2)
    li.appendChild(rating);

    var content = document.createElement('p');
    content.className = 'review-item__content';
    content.setAttribute('data-testid', 'review-item-content');
    content.textContent = review.content;   // textContent — innerHTML로 해석하지 않는다 (27.7)
    content.hidden = isEditing;
    li.appendChild(content);

    var time = document.createElement('time');
    time.className = 'review-item__date';
    time.setAttribute('data-testid', 'review-item-date');
    time.setAttribute('datetime', review.createdAt);
    time.textContent = formatReviewDate(review.createdAt);
    li.appendChild(time);

    // 남의 줄에는 버튼을 DOM에 아예 만들지 않는다 — hidden이 아니라 "없음" (29.11).
    if (review.isMine && !isEditing) {
      var editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn review-item__edit';
      editBtn.setAttribute('data-testid', 'review-item-edit');
      editBtn.textContent = '수정';
      editBtn.disabled = !!reviewState.rowBusy[review.reviewId];
      li.appendChild(editBtn);

      var deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn review-item__delete';
      deleteBtn.setAttribute('data-testid', 'review-item-delete');
      deleteBtn.textContent = '삭제';
      deleteBtn.disabled = !!reviewState.rowBusy[review.reviewId];
      li.appendChild(deleteBtn);
    }

    if (isEditing) {
      li.appendChild(createReviewEditForm(review));
    }

    return li;
  }

  function renderReviewList() {
    var reviews = reviewState.snapshot ? reviewState.snapshot.reviews : [];
    var frag = document.createDocumentFragment();
    // 서버가 준 순서(최신순)를 그대로 그린다 — sort()/reverse()를 쓰지 않는다 (27.6/D51).
    reviews.forEach(function (review) { frag.appendChild(createReviewItem(review)); });
    rv.list.textContent = '';
    rv.list.appendChild(frag);
  }

  // GET/POST/PATCH/DELETE 네 응답 모두 이 함수 하나로 화면을 다시 그린다 (D50 / 27.3).
  function applyReviewSnapshot(snapshot) {
    reviewState.snapshot = snapshot;
    renderReviewSummary(snapshot);
    renderReviewList();
    setReviewDataState(snapshot.reviews.length === 0 ? 'empty' : 'list');   // 7.8/27.8과 같은 판단
    updateWriteAreaVisibility();
  }

  /* ---------- 조회 (화면당 1회 — 27.3) ---------- */

  function loadReviews(productId) {
    reviewProductId = productId;
    setReviewDataState('loading');
    clearReviewError();

    fetch(reviewsCollectionUrl(productId), { headers: { Accept: 'application/json' } })
      .then(parseReviewResponse)
      .then(function (snapshot) {
        applyReviewSnapshot(snapshot);
      })
      .catch(function (err) {
        // 조회 실패가 상세 화면 전체를 망가뜨리지 않는다 — 리뷰 영역 안에만 에러를 표시한다 (27.9).
        setReviewDataState('none');
        showReviewError(err && err.message);
        console.error('[review] 조회 실패:', err);
      });
  }

  /* ---------- 작성 ---------- */

  // 500자 제한은 안내일 뿐 전송을 막지 않으므로(28.7), 이 카운터도 501자 이상에서 입력을
  // 막지 않는다 — 글자 수만 그대로 보여주고, 서버가 보내면 400으로 거절한다.
  function updateContentCounter() {
    if (!rv.contentCounter) return;
    var len = rv.contentInput.value.length;
    rv.contentCounter.textContent = len + '/500';
    rv.contentCounter.classList.toggle('review-form__counter--over', len > 500);
  }

  function handleReviewSubmit(event) {
    event.preventDefault();
    if (reviewState.submitting || !reviewProductId) return;

    var ratingRaw = rv.ratingSelect.value;   // '' 이면 변환하지 않고 그대로 보낸다 (28.5)
    var contentRaw = rv.contentInput.value;  // trim하지 않는다 — trim은 서버가 한다 (28.5/D48)

    reviewState.submitting = true;
    rv.submitBtn.disabled = true;

    fetch(reviewsCollectionUrl(reviewProductId), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        rating: ratingRaw === '' ? ratingRaw : Number(ratingRaw),
        content: contentRaw
      })
    })
      .then(parseReviewResponse)
      .then(function (snapshot) {
        clearReviewError();
        applyReviewSnapshot(snapshot);
        // 성공 후 입력값을 초기 상태로 되돌린다 (28.8-4) — 폼은 updateWriteAreaVisibility()가 숨긴다.
        rv.ratingSelect.value = '';
        rv.contentInput.value = '';
        updateContentCounter();
      })
      .catch(function (err) {
        showReviewError(err && err.message);   // 입력값은 유지한다 — 지우지 않는다 (28.9)
        if (err && err.status === 401) {
          // 쓰는 사이 세션이 끊긴 경우 — 작성 영역을 비로그인 안내로 전환한다 (28.9).
          // 헤더 인증 영역은 건드리지 않는다 — 그건 이 영역의 책임이 아니다 (20.2 / 책임 분리).
          reviewState.authStatus = 'guest';
          updateWriteAreaVisibility();
        }
        console.error('[review] 작성 실패:', err);
      })
      .then(function () {
        reviewState.submitting = false;
        rv.submitBtn.disabled = false;
      });
  }

  /* ---------- 수정 / 삭제 (29장) ---------- */

  function handleReviewEditSave(reviewId, ratingValue, contentValue, buttonEl) {
    if (reviewState.rowBusy[reviewId]) return;
    reviewState.rowBusy[reviewId] = true;
    buttonEl.disabled = true;

    fetch(reviewItemUrl(reviewId), {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ rating: Number(ratingValue), content: contentValue })
    })
      .then(parseReviewResponse)
      .then(function (snapshot) {
        clearReviewError();
        reviewState.editingReviewId = null;
        // rowBusy를 재렌더 "전"에 지운다 — renderReviewList()가 이 reviewId로 새 버튼을 만들 때
        // disabled 값을 여기서 읽는다. 나중에 지우면 재렌더로 교체된 새 버튼이 disabled로 굳어버리고,
        // 아래에서 재활성화하는 buttonEl은 이미 DOM에서 떨어져나간 옛 버튼이라 효과가 없다.
        delete reviewState.rowBusy[reviewId];
        applyReviewSnapshot(snapshot);
      })
      .catch(function (err) {
        // 실패 시 그 줄을 지우지 않고, 수정 폼은 열린 채로 입력값을 유지한다 (29.9).
        showReviewError(err && err.message);
        if (err && err.status === 401) {
          reviewState.authStatus = 'guest';
          updateWriteAreaVisibility();
        }
        console.error('[review] 수정 실패:', err);
        delete reviewState.rowBusy[reviewId];
        buttonEl.disabled = false;
      });
  }

  function handleReviewDelete(reviewId, buttonEl) {
    if (reviewState.rowBusy[reviewId]) return;
    reviewState.rowBusy[reviewId] = true;
    buttonEl.disabled = true;

    fetch(reviewItemUrl(reviewId), { method: 'DELETE', headers: { Accept: 'application/json' } })
      .then(parseReviewResponse)
      .then(function (snapshot) {
        clearReviewError();
        if (reviewState.editingReviewId === reviewId) reviewState.editingReviewId = null;
        // handleReviewEditSave와 같은 이유로, 재렌더 전에 rowBusy를 지운다.
        delete reviewState.rowBusy[reviewId];
        applyReviewSnapshot(snapshot);
      })
      .catch(function (err) {
        // 실패 시(403/404/5xx) 그 줄이 화면에서 사라지지 않는다 — 목록을 다시 그리지 않는다 (29.9).
        showReviewError(err && err.message);
        if (err && err.status === 401) {
          reviewState.authStatus = 'guest';
          updateWriteAreaVisibility();
        }
        console.error('[review] 삭제 실패:', err);
        delete reviewState.rowBusy[reviewId];
        buttonEl.disabled = false;
      });
  }

  function onReviewListClick(event) {
    var button = event.target.closest ? event.target.closest('button') : null;
    if (!button) return;

    var li = button.closest('[data-testid="review-item"]');
    if (!li) return;

    var reviewId = li.getAttribute('data-review-id');
    var testid = button.getAttribute('data-testid');

    if (testid === 'review-item-edit') {
      reviewState.editingReviewId = reviewId;   // 상품당 내 리뷰는 1개뿐이라 동시에 열리는 폼도 하나다 (D45)
      renderReviewList();
      return;
    }

    if (testid === 'review-edit-cancel') {
      // 서버를 호출하지 않고 닫는다 — 입력했던 값은 버린다 (29.5).
      reviewState.editingReviewId = null;
      renderReviewList();
      return;
    }

    if (testid === 'review-item-delete') {
      // 확인 다이얼로그 없이 클릭 한 번이 곧 실행이다 (D10 / 29.6).
      handleReviewDelete(reviewId, button);
      return;
    }

    if (testid === 'review-edit-save') {
      var form = li.querySelector('[data-testid="review-edit-form"]');
      var ratingVal = form.querySelector('[data-testid="review-edit-rating"]').value;
      var contentVal = form.querySelector('[data-testid="review-edit-content"]').value;
      handleReviewEditSave(reviewId, ratingVal, contentVal, button);
    }
  }

  rv.list.addEventListener('click', onReviewListClick);
  rv.form.addEventListener('submit', handleReviewSubmit);
  rv.contentInput.addEventListener('input', updateContentCounter);
  updateContentCounter();

  // auth-header.js가 이미 받은 로그인 상태를 구독한다 — GET /api/auth/me를 여기서 다시 부르지
  // 않는다 (D52 / 28.2 / 32장 H4). 구독 즉시 현재 상태로 1회 호출되므로 "확정 전" 상태부터 반영된다.
  if (window.HaruAuth && typeof window.HaruAuth.subscribe === 'function') {
    window.HaruAuth.subscribe(function (state) {
      reviewState.authStatus = state.status;
      updateWriteAreaVisibility();
    });
  }

  bindQuantity();
  el.addBtn.addEventListener('click', addToCart);
  loadProduct();
  window.HaruCart.refreshBadge();
})();
