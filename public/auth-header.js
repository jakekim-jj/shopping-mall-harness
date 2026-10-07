/* 하루상점 — 공통 헤더 인증 영역 (7개 화면 전부 공유하는 유일한 모듈)
 *
 * 백엔드 계약(_workspace/02_backend_api-spec.md §2L~§2O)
 *   GET  /api/auth/me      → 항상 200. { "user": { email, createdAt } } | { "user": null }
 *   POST /api/auth/logout  → 200 + { "user": null } (성공) | 401 + { "error": { "message" } } (세션 없음/위조/만료)
 *
 * ⚠️ M4(쿠키 최초 발급 경쟁 조건, docs/bug-history/2026-08-08_cart-session-race-condition.md) 재발 차단
 *   (PRD 20.9 / 24.13): 이 파일은 `cartId`를 전혀 알지 못한다. document.cookie를 읽지도 쓰지도 않고,
 *   HaruCart(cart-badge.js)의 어떤 함수도 호출하지 않는다. 7개 화면이 로드 시 GET /api/cart(배지)와
 *   GET /api/auth/me(이 파일)를 병렬로 호출하는 것은 허용되지만, 그 안전성은 전적으로
 *   "cartId를 발급하는 코드 경로가 ensureCartId() 하나뿐"이라는 백엔드 쪽 보장에 의존한다 — 이 파일이
 *   cartId를 건드리지 않아야 그 보장이 성립한다.
 *
 * ⚠️ 20.9 (공용 모듈 1개): 화면별 JS가 각자 GET /api/auth/me를 호출하는 구조를 만들지 않는다.
 *   이 파일이 각 HTML에서 1회 자기 실행(self-invoke)되어 화면당 정확히 1회 호출을 보장한다.
 *   signup.js/login.js/checkout.js 등 어떤 화면 스크립트도 /api/auth/me를 직접 fetch하지 않는다.
 *
 * 3상태 규칙 (PRD 20.5 / 25.5):
 *   확정 전(응답 도착 전 + 실패 시) → auth-guest, auth-user 둘 다 hidden (HTML 기본값이 이미 hidden이다)
 *   비로그인 확정                  → auth-guest visible, auth-user hidden
 *   로그인 확정                    → auth-user visible, auth-guest hidden
 *   두 요소는 DOM에서 제거/재생성하지 않고 hidden 토글만 한다.
 */
(function () {
  'use strict';

  var ME_ENDPOINT = '/api/auth/me';
  var LOGOUT_ENDPOINT = '/api/auth/logout';
  var JSON_HEADERS = { Accept: 'application/json' };

  function els() {
    return {
      guest: document.querySelector('[data-testid="auth-guest"]'),
      user: document.querySelector('[data-testid="auth-user"]'),
      email: document.querySelector('[data-testid="auth-user-email"]'),
      logoutBtn: document.querySelector('[data-testid="auth-logout-button"]')
    };
  }

  // { error: { message } } 중첩을 벗기는 지점 (이 파일 안에서는 쓰지 않지만 일관된 자리에 둔다)
  function readErrorMessage(body) {
    if (body && typeof body === 'object' && body.error && typeof body.error.message === 'string') {
      return body.error.message;
    }
    return '';
  }

  /* ---------- 상태 전환 (확정 전 / 게스트 / 로그인 — 셋 중 하나, 요소는 항상 DOM에 존재) ---------- */

  function showUnresolved() {
    var e = els();
    if (e.guest) e.guest.hidden = true;
    if (e.user) e.user.hidden = true;
  }

  function showGuest() {
    var e = els();
    if (e.guest) e.guest.hidden = false;
    if (e.user) e.user.hidden = true;
  }

  function showUser(email) {
    var e = els();
    if (e.user) e.user.hidden = false;
    if (e.guest) e.guest.hidden = true;
    if (e.email) e.email.textContent = email; // 마스킹 없이 그대로 전체 표시 (PRD 20.4)
  }

  // { user: {...} } | { user: null } → 헤더 상태. me/logout 응답 shape이 같으므로 같은 함수로 처리한다 (24.10/24.11).
  function renderFromUserField(user) {
    if (user && typeof user === 'object' && typeof user.email === 'string') {
      showUser(user.email);
    } else {
      showGuest();
    }
  }

  /* ---------- GET /api/auth/me — 화면당 정확히 1회 ---------- */

  function loadAuthState() {
    return fetch(ME_ENDPOINT, { headers: JSON_HEADERS })
      .then(function (res) {
        if (!res.ok) {
          throw new Error('인증 상태를 불러오지 못했습니다');
        }
        return res.json();
      })
      .then(function (body) {
        var user = body && typeof body === 'object' ? body.user : null;
        renderFromUserField(user);
        return user;
      })
      .catch(function (err) {
        // 5xx/네트워크 오류 → 확정 전 상태로 남긴다. 화면 본문 렌더링은 이 파일과 무관하게
        // 계속 진행되므로(각 화면의 app.js/product.js/...가 독립적으로 진행), 여기서 막을 것이 없다 (PRD 20.6).
        showUnresolved();
        console.warn('[auth] 인증 상태 조회 실패 (헤더는 확정 전 상태로 유지):', err);
        return null;
      });
  }

  /* ---------- POST /api/auth/logout ---------- */

  function handleLogoutClick() {
    var e = els();
    if (!e.logoutBtn || e.logoutBtn.disabled) return;

    e.logoutBtn.disabled = true;

    fetch(LOGOUT_ENDPOINT, { method: 'POST', headers: JSON_HEADERS })
      .then(function (res) {
        return res.json()
          .catch(function () { return null; })
          .then(function (body) { return { status: res.status, body: body }; });
      })
      .then(function (result) {
        if (result.status === 200) {
          // 성공 — 게스트로 갱신, 화면 이동 없음 (PRD 23.2)
          showGuest();
        } else if (result.status === 401) {
          // 이미 세션이 없음 — 원하던 결과(로그아웃됨)가 이미 성립해 있다. 에러 표시 없이 게스트로 갱신 (PRD 23.3)
          showGuest();
        } else {
          // 5xx 등 예상 밖 — 서버 세션이 실제로 지워졌는지 알 수 없으므로 로그인 상태를 그대로 유지한다 (PRD 23.3)
          console.warn('[auth] 로그아웃 실패(상태코드 ' + result.status + ') — 헤더를 로그인 상태로 유지:',
            readErrorMessage(result.body));
        }
      })
      .catch(function (err) {
        // 네트워크 오류 — 역시 로그인 상태 유지 (PRD 23.3)
        console.warn('[auth] 로그아웃 요청 실패 — 헤더를 로그인 상태로 유지:', err);
      })
      .then(function () {
        e.logoutBtn.disabled = false;
      });
  }

  /* ---------- 초기화 (화면당 1회 자기 실행) ---------- */

  function init() {
    var e = els();
    if (e.logoutBtn) {
      e.logoutBtn.addEventListener('click', handleLogoutClick);
    }
    return loadAuthState();
  }

  window.HaruAuth = {
    init: init,
    loadAuthState: loadAuthState,
    readErrorMessage: readErrorMessage
  };

  init();
})();
