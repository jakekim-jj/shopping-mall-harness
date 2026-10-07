/* 하루상점 — 로그인 화면 로직 (/login.html)
 *
 * 백엔드 계약(_workspace/02_backend_api-spec.md §2M)
 *   POST /api/auth/login   body { "email": string, "password": string }
 *     200 → { "user": { "email": "...", "createdAt": "..." } }  + Set-Cookie: sessionId=...
 *     400 → { "error": { "message": "..." } }   형식 검증 실패 (signup과 동일 메시지, 401보다 먼저 검사)
 *     401 → { "error": { "message": "이메일 또는 비밀번호가 올바르지 않습니다." } }
 *           ⚠️ "이메일 없음"과 "비밀번호 불일치"가 완전히 같은 응답이다(D34) — 프론트가 추측해서
 *           메시지를 나누지 않고 서버 메시지를 그대로 보여준다.
 *
 * 프론트는 입력 검증을 하지 않는다 (PRD 22.6 = 21.6). 비밀번호를 흘리지 않는다 (PRD 22.11 = 21.11) —
 * fetch + preventDefault()로 제출하고 URL/localStorage/console.log에 비밀번호를 남기지 않는다.
 *
 * 성공 시 '/'로 이동한다 (PRD 22.3) — ?returnTo=/?next= 같은 "원래 가려던 화면" 복귀는 구현하지
 * 않는다(D38, 목적지는 항상 '/'로 고정). 이동한 '/'에서는 그 화면의 auth-header.js가 다시
 * GET /api/auth/me를 호출해 로그인 상태(이메일+로그아웃 버튼)를 그려준다 — 이 화면에서 헤더를
 * 직접 갱신할 필요가 없다(페이지가 곧 떠난다).
 *
 * 실패 시 이메일은 남기고 비밀번호만 비운다 (PRD 22.4) — signup(둘 다 유지)과 정반대 규칙이므로
 * 섞어 쓰지 않는다.
 */
(function () {
  'use strict';

  var LOGIN_ENDPOINT = '/api/auth/login';

  var el = {
    form: document.getElementById('login-form'),
    email: document.getElementById('login-email'),
    password: document.getElementById('login-password'),
    submit: document.getElementById('login-submit'),
    error: document.getElementById('login-error'),
    errorMessage: document.getElementById('login-error-message')
  };

  var submitting = false; // 이중 클릭 방지 (PRD 22.7 = 21.7)

  function readErrorMessage(body) {
    if (body && typeof body === 'object' && body.error && typeof body.error.message === 'string') {
      return body.error.message;
    }
    return '';
  }

  function showError(message) {
    el.errorMessage.textContent = message;
    el.error.hidden = false;
  }

  function hideError() {
    el.error.hidden = true;
  }

  function setSubmitting(value) {
    submitting = value;
    el.submit.disabled = value;
  }

  function onSubmit(event) {
    event.preventDefault(); // 쿼리스트링에 비밀번호가 노출되는 기본 submit을 막는다 (PRD 22.11)
    if (submitting) return;

    hideError();
    setSubmitting(true);

    var payload = {
      email: el.email.value,
      password: el.password.value
    };

    fetch(LOGIN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        return res.json()
          .catch(function () { return null; })
          .then(function (body) { return { status: res.status, body: body }; });
      })
      .then(function (result) {
        if (result.status === 200) {
          // 성공 — '/'로 이동. 헤더 갱신은 이동한 화면의 auth-header.js가 담당한다 (PRD 22.3).
          window.location.href = '/';
          return;
        }
        // 400/401 — 이메일은 남기고 비밀번호만 비운다 (PRD 22.4)
        el.password.value = '';
        showError(readErrorMessage(result.body) || '로그인에 실패했습니다.');
      })
      .catch(function (err) {
        el.password.value = '';
        showError((err && err.message) || '로그인 요청을 처리하지 못했습니다. 네트워크 상태를 확인해 주세요.');
        console.error('[login] 로그인 요청 실패:', err);
      })
      .then(function () {
        // 성공(이동 직전)·실패·에러 모두 재활성화한다 (PRD 22.7).
        setSubmitting(false);
      });
  }

  el.form.addEventListener('submit', onSubmit);

  // 헤더 장바구니 배지 — 인증 화면도 예외 없이 채운다 (PRD 20.10).
  if (window.HaruCart) {
    window.HaruCart.refreshBadge();
  }
})();
