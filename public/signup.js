/* 하루상점 — 회원가입 화면 로직 (/signup.html)
 *
 * 백엔드 계약(_workspace/02_backend_api-spec.md §2L, 2026-10-06 핫픽스 — D39)
 *   POST /api/auth/signup   body { "email": string, "password": string, "passwordConfirm": string }  ← 3개 필드
 *     201 → { "user": { "email": "...", "createdAt": "..." } }   ← Set-Cookie 없음(자동 로그인 아님, D31)
 *     400 → { "error": { "message": "이메일 형식이 올바르지 않습니다." } }
 *         → { "error": { "message": "이메일은 254자 이하로 입력해 주세요." } }
 *         → { "error": { "message": "비밀번호는 4자 이상 20자 이하로 입력해 주세요." } }
 *         → { "error": { "message": "비밀번호가 일치하지 않습니다." } }   ← 신규(D39), passwordConfirm 불일치
 *     409 → { "error": { "message": "이미 가입된 이메일입니다." } }
 *
 * 프론트는 입력 검증을 하지 않는다 (PRD 21.6) — 이메일이 비어 있든 비밀번호가 3자든, password와
 * passwordConfirm이 서로 다르든 그대로 서버로 보내고 응답 메시지를 표시한다.
 * required/pattern/minlength/maxlength/type="email"을 쓰지 않는다.
 *
 * ⚠️ D39 핵심 — 두 비밀번호 값을 프론트에서 절대 비교하지 않는다. password !== passwordConfirm 같은
 * 분기, 실시간 일치/불일치 표시, 불일치 시 제출 버튼 비활성화를 만들지 않는다. 입력된 값을 그대로
 * 세 필드로 전송하고, 불일치는 서버의 400 메시지를 signup-error에 그대로 표시한다(별도 분기 없음) —
 * 이 메시지도 기존 readErrorMessage/showError 경로를 그대로 재사용한다.
 *
 * 비밀번호를 흘리지 않는다 (PRD 21.11) — POST body로만 전송하고, URL 쿼리스트링/localStorage/
 * sessionStorage/console.log에 남기지 않는다. 이 규칙은 passwordConfirm에도 동일하게 적용된다.
 * 폼은 fetch로 제출하며 preventDefault()로 브라우저 기본 submit(페이지 이동 + 쿼리스트링 노출)을 막는다.
 *
 * GET /api/auth/me는 이 파일에서 직접 호출하지 않는다 — auth-header.js가 화면당 1회를 이미
 * 책임지고 있다 (PRD 20.2/20.9). 가입 성공은 자동 로그인이 아니므로(D31) 헤더를 다시 조회할
 * 이유도 없다 — 헤더는 그대로 게스트 상태로 남는다.
 */
(function () {
  'use strict';

  var SIGNUP_ENDPOINT = '/api/auth/signup';

  var el = {
    form: document.getElementById('signup-form'),
    email: document.getElementById('signup-email'),
    password: document.getElementById('signup-password'),
    passwordConfirm: document.getElementById('signup-password-confirm'),
    submit: document.getElementById('signup-submit'),
    error: document.getElementById('signup-error'),
    errorMessage: document.getElementById('signup-error-message'),
    success: document.getElementById('signup-success')
  };

  var submitting = false; // 이중 클릭 방지 (PRD 21.7)

  // { error: { message } } 중첩을 벗기는 유일한 지점
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

  // 성공 — 폼을 숨기고 성공 안내를 보여준다. 입력값을 지울 필요도 없다(폼 자체가 사라진다).
  function showSuccess() {
    el.form.hidden = true;
    el.success.hidden = false;
  }

  function setSubmitting(value) {
    submitting = value;
    el.submit.disabled = value;
  }

  function onSubmit(event) {
    event.preventDefault(); // 브라우저 기본 submit 차단 — 쿼리스트링에 비밀번호가 노출되지 않게 함 (PRD 21.11)
    if (submitting) return;

    hideError();
    setSubmitting(true);

    // 세 값 모두 입력란의 값을 그대로 싣는다 — password/passwordConfirm 값을 서로 비교하거나
    // 어느 한쪽으로 덮어쓰지 않는다. 일치 판정은 서버가 한다 (PRD 21.2 / D39).
    var payload = {
      email: el.email.value,
      password: el.password.value,
      passwordConfirm: el.passwordConfirm.value
    };

    fetch(SIGNUP_ENDPOINT, {
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
        if (result.status === 201) {
          showSuccess();
          return;
        }
        // 400/409 — 서버 메시지 그대로 표시, 입력값 유지, 폼 계속 보임 (PRD 21.4/21.5)
        showError(readErrorMessage(result.body) || '회원가입에 실패했습니다.');
      })
      .catch(function (err) {
        // 네트워크 오류 — 역시 입력값을 지우지 않는다
        showError((err && err.message) || '회원가입 요청을 처리하지 못했습니다. 네트워크 상태를 확인해 주세요.');
        console.error('[signup] 회원가입 요청 실패:', err);
      })
      .then(function () {
        // 성공·실패·에러 모두 재활성화한다 (PRD 21.7). 성공 시엔 폼이 숨겨져 실질적 영향은 없다.
        setSubmitting(false);
      });
  }

  el.form.addEventListener('submit', onSubmit);

  // 헤더 장바구니 배지 — 인증 화면도 예외 없이 채운다 (PRD 20.10).
  if (window.HaruCart) {
    window.HaruCart.refreshBadge();
  }
})();
