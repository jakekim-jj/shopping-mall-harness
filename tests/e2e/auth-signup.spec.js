'use strict';

/**
 * 회원가입 화면 + API — tests/test-cases.ko.md
 *   "5차 사이클 — 회원가입 / 로그인 / 로그아웃" 중 회원가입 관련 6개 섹션
 *   (PRD 20~26장, 매트릭스 A1~A30. D39 — 비밀번호 확인란 핫픽스 포함)
 *
 * 구성 방식 (2026-10-07 — BDD/시나리오 스타일로 전환, skills/shopping-mall-qa/SKILL.md 참고)
 *   - describe 블록 = "시나리오"(어떤 방문자가 무엇을 하려는가). 테스트 제목 = 그 시나리오 안의
 *     한 단락("무엇을 하면 무엇이 된다"). PRD 조항/매트릭스 번호는 제목 끝 [ ] 안에 각주로만
 *     남긴다 — 이 태그 하나만 grep하면 test-cases.ko.md의 해당 케이스로 역추적할 수 있다.
 *     (test-cases.ko.md 자체의 구조는 바꾸지 않았다 — 그 문서는 "요구사항을 테스트했는가"를
 *     추적하는 매트릭스이고, 이 파일은 "어떤 상황을 테스트하는가"를 읽는 코드라서 두 문서가
 *     같은 구조일 필요는 없다고 판단했다.)
 *   - 여러 단계를 거치는 화면 테스트는 `test.step()`으로 Given/When/Then을 명시한다. 이건
 *     Playwright 기본 기능이라 새 패키지가 필요 없고, HTML 리포트·트레이스 뷰어에 그대로
 *     단계별로 찍힌다.
 *   - 각 테스트는 여전히 완전히 독립적이다 — "시나리오"로 묶여 있어도 서로의 상태에 의존하지
 *     않고, 전부 자기 몫의 새 이메일을 스스로 만들어 쓴다(uniqueEmail).
 *
 * 규칙 (skills/shopping-mall-qa/SKILL.md)
 *   - data-testid 선택자만 쓴다.
 *   - "요청이 나갔는가"는 화면 모양이 아니라 실제 요청 개수로 확인한다.
 *   - 서버 메시지는 글자 단위로 비교한다 — 추측해서 느슨하게 포함(contain) 검사하지 않는다.
 *   - spec 파일 하나당 브라우저 컨텍스트(창)는 하나다. 아래 beforeAll에서 한 번만 만든다.
 *
 * 서버가 재시작되지 않는 한 users Map이 테스트 실행 간에도 유지된다(PRD D28 — 인메모리).
 * 그래서 이 파일의 모든 테스트는 매번 새로운 무작위 이메일을 만들어 쓴다(uniqueEmail) —
 * 재실행해도 "이미 가입된 이메일"과 충돌하지 않는다. 의도적으로 중복을 만드는 시나리오만 예외다.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'default' });

/** 이 파일의 모든 테스트가 재사용하는 컨텍스트/페이지. beforeAll에서 딱 한 번만 만든다. */
let context;
let page;

test.beforeAll(async ({ browser, baseURL, viewport }) => {
  context = await browser.newContext({ baseURL, viewport });
  page = await context.newPage();
  console.log('[auth-signup.spec] 공유 브라우저 컨텍스트 1개 생성 (테스트마다 새로 열지 않는다)');
});

test.afterAll(async () => {
  await context.close();
});

// 로그인 상태가 다음 테스트로 새어나가지 않게, 매 테스트 전에 게스트로 되돌린다.
// ("로그인한 채로 가입 화면에 들어가는" 시나리오처럼 의도적으로 로그인해두는 테스트가 있으므로
// "로그인 안 된 상태로 시작"을 보장하는 용도다.)
test.beforeEach(async () => {
  await context.request.post('/api/auth/logout').catch(() => {});
});

test.afterEach(async () => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  page.removeAllListeners('request');
  page.removeAllListeners('dialog');
});

let emailSeq = 0;
/** 재실행해도 겹치지 않는 고유 이메일을 만든다. */
function uniqueEmail(prefix) {
  emailSeq += 1;
  // 공백·한글 등 이메일에 쓸 수 없는 문자가 라벨에 섞여 들어와도(예: "빈 문자열") 유효한 이메일이
  // 되도록 영문/숫자/.- 만 남긴다 — 안 그러면 EMAIL_FORMAT_ERROR가 먼저 터져 테스트 의도가 깨진다.
  const safePrefix = String(prefix).replace(/[^a-zA-Z0-9.-]/g, '') || 'x';
  return `${safePrefix}.${Date.now()}.${emailSeq}.${Math.random().toString(36).slice(2, 8)}@example.com`;
}

function errMsg(body) {
  return body && body.error && typeof body.error.message === 'string' ? body.error.message : '';
}

/** POST /api/auth/signup — API 레벨 호출. */
async function apiSignup(reqCtx, payload) {
  const res = await reqCtx.post('/api/auth/signup', { data: payload });
  const body = await res.json().catch(() => null);
  return { status: res.status(), body, res };
}

async function apiLogin(reqCtx, email, password) {
  const res = await reqCtx.post('/api/auth/login', { data: { email, password } });
  const body = await res.json().catch(() => null);
  return { status: res.status(), body, res };
}

const EMAIL_FORMAT_ERROR = '이메일 형식이 올바르지 않습니다.';
const EMAIL_LENGTH_ERROR = '이메일은 254자 이하로 입력해 주세요.';
const PASSWORD_LENGTH_ERROR = '비밀번호는 4자 이상 20자 이하로 입력해 주세요.';
const EMAIL_DUPLICATE_ERROR = '이미 가입된 이메일입니다.';
const PASSWORD_MISMATCH_ERROR = '비밀번호가 일치하지 않습니다.';

// ===========================================================================
// 시나리오 1: 올바른 정보로 가입하는 신규 방문자
// [PRD 24.1/24.2/21.3/21.10 · D30/D31/D33 · A1/A13~A15]
// ===========================================================================
test.describe('시나리오: 올바른 정보로 가입하는 신규 방문자', () => {
  test('이메일과 4자 이상 비밀번호를 입력해 제출하면, 가입에 성공하고 응답에는 이메일·가입일 두 가지만 담긴다 [24.2/D30 · A1/A13]', async () => {
    const email = uniqueEmail('a1');
    const { status, body } = await apiSignup(context.request, {
      email,
      password: 'abcd1234',
      passwordConfirm: 'abcd1234',
    });

    expect(status).toBe(201);
    expect(Object.keys(body)).toEqual(['user']);
    expect(Object.keys(body.user).sort()).toEqual(['createdAt', 'email']);
    expect(body.user.email).toBe(email);
    expect(typeof body.user.createdAt).toBe('string');
    // 비밀번호·해시·salt·내부 id가 절대 들어 있지 않다
    expect(JSON.stringify(body)).not.toContain('abcd1234');
    expect(JSON.stringify(body).toLowerCase()).not.toContain('hash');
    expect(JSON.stringify(body).toLowerCase()).not.toContain('salt');
  });

  test('서버가 쓰지 않는 값(이름·권한 등)을 끼워 보내도, 그 값은 전부 무시되고 가입은 정상 처리된다 [24.1]', async () => {
    const email = uniqueEmail('a1-extra');
    const { status, body } = await apiSignup(context.request, {
      email,
      password: 'abcd1234',
      passwordConfirm: 'abcd1234',
      name: '홍길동',
      role: 'admin',
      id: 'should-be-ignored',
    });

    expect(status).toBe(201);
    expect(Object.keys(body.user).sort()).toEqual(['createdAt', 'email']);
  });

  test('이메일 앞뒤에 공백과 대문자를 섞어 입력해도, 공백이 제거되고 소문자로 정규화되어 저장·응답된다 [D33]', async () => {
    const rawLocal = `Mixed.Case.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
    const email = `  ${rawLocal}@EXAMPLE.COM  `;
    const { status, body } = await apiSignup(context.request, {
      email,
      password: 'abcd1234',
      passwordConfirm: 'abcd1234',
    });

    expect(status).toBe(201);
    expect(body.user.email).toBe(`${rawLocal}@example.com`.toLowerCase());
  });

  test('가입에 성공해도 자동으로 로그인되지는 않는다 — 쿠키가 발급되지 않고, 직후 상태 조회는 로그인 안 됨이다 [D31 · A14]', async () => {
    const email = uniqueEmail('a14');
    const res = await context.request.post('/api/auth/signup', {
      data: { email, password: 'abcd1234', passwordConfirm: 'abcd1234' },
    });
    expect(res.status()).toBe(201);

    const setCookies = res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
    expect(setCookies).toEqual([]);

    const me = await context.request.get('/api/auth/me');
    const meBody = await me.json();
    expect(meBody.user).toBeNull();
  });

  test('화면에서 가입에 성공하면, 화면 이동 없이 폼이 숨겨지고 성공 안내·로그인 링크가 나타나며 헤더는 게스트 상태를 유지한다 [21.3/21.10 · A15]', async () => {
    const email = uniqueEmail('a15');

    await test.step('Given: 회원가입 화면에서 올바른 이메일/비밀번호를 입력한다', async () => {
      await page.goto('/signup.html');
      await page.getByTestId('signup-email').fill(email);
      await page.getByTestId('signup-password').fill('abcd1234');
      await page.getByTestId('signup-password-confirm').fill('abcd1234');
    });

    await test.step('When: 가입 버튼을 누른다', async () => {
      await page.getByTestId('signup-submit').click();
    });

    await test.step('Then: 화면은 이동하지 않고, 폼은 숨겨지고 성공 안내가 나타난다', async () => {
      await expect(page.getByTestId('signup-success')).toBeVisible();
      await expect(page.getByTestId('signup-form')).toBeHidden();
      await expect(page.getByTestId('signup-login-link')).toHaveAttribute('href', '/login.html');
      await expect(page).toHaveURL(/\/signup\.html$/);
      // 폼과 성공 안내가 동시에 보이는 순간은 없다 (21.10)
      await expect(page.getByTestId('signup-error')).toBeHidden();
    });

    await test.step('Then: 가입은 자동 로그인이 아니므로 헤더는 여전히 게스트 상태다', async () => {
      await expect(page.getByTestId('auth-guest')).toBeVisible();
      await expect(page.getByTestId('auth-user')).toBeHidden();
    });
  });
});

// ===========================================================================
// 시나리오 2: 이메일을 잘못 입력한 방문자
// [PRD 24.3 · A6/A7/A8/A12]
// ===========================================================================
test.describe('시나리오: 이메일을 잘못 입력한 방문자', () => {
  const invalidEmailInputs = [
    ['누락', undefined],
    ['null', null],
    ['숫자', 12345],
    ['빈 문자열', ''],
    ['공백만', '   '],
  ];
  for (const [label, value] of invalidEmailInputs) {
    test(`이메일이 ${label}이면, 형식 오류로 거절된다 [A6]`, async () => {
      const payload = { password: 'abcd1234', passwordConfirm: 'abcd1234' };
      if (value !== undefined) payload.email = value;
      const { status, body } = await apiSignup(context.request, payload);
      expect(status).toBe(400);
      expect(errMsg(body)).toBe(EMAIL_FORMAT_ERROR);
    });
  }

  const disallowedEmails = [
    'user@example',
    'user@@ex.com',
    '@ex.com',
    'user@',
    'user@ex.',
    'user@ex..com',
    'user @example.com',
    'user@ ex.com',
    'us er@ex.com',
  ];
  for (const email of disallowedEmails) {
    test(`형식이 잘못된 이메일 "${email}"로 가입을 시도하면 거절된다 [A7]`, async () => {
      const { status, body } = await apiSignup(context.request, {
        email,
        password: 'abcd1234',
        passwordConfirm: 'abcd1234',
      });
      expect(status).toBe(400);
      expect(errMsg(body)).toBe(EMAIL_FORMAT_ERROR);
    });
  }

  test('짧은 도메인·플러스태그·앞뒤 공백이 섞인, 흔히 쓰이는 형태의 이메일은 통과한다 [A7]', async () => {
    const short = `a7s${Date.now()}${Math.random().toString(36).slice(2, 5)}@b.co`;
    const tagged = `user.name+tag.${Date.now()}${Math.random().toString(36).slice(2, 5)}@mail.example.co.kr`;
    const paddedLocal = `a7p${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
    const padded = `  ${paddedLocal}@example.com  `;

    for (const email of [short, tagged, padded]) {
      const { status, body } = await apiSignup(context.request, {
        email,
        password: 'abcd1234',
        passwordConfirm: 'abcd1234',
      });
      expect(status).toBe(201);
      expect(body.user.email).toBe(email.trim().toLowerCase());
    }
  });

  test('이메일 길이가 254자면 통과하고 255자면 길이 오류로 거절된다 [A8]', async () => {
    const domain = '@example.com'; // 12자
    // 재실행해도 겹치지 않도록 매번 다른 접두사를 넣고, 'a'로 채워 정확한 길이를 맞춘다.
    function emailOfExactLength(totalLen) {
      const localLen = totalLen - domain.length;
      const uniquePrefix = `u${Date.now()}${Math.floor(Math.random() * 1e6)}`;
      const local = (uniquePrefix + 'a'.repeat(Math.max(0, localLen))).slice(0, localLen);
      return local + domain;
    }

    const email254 = emailOfExactLength(254);
    expect(email254.length).toBe(254);
    const ok = await apiSignup(context.request, {
      email: email254,
      password: 'abcd1234',
      passwordConfirm: 'abcd1234',
    });
    expect(ok.status).toBe(201);

    const email255 = emailOfExactLength(255);
    expect(email255.length).toBe(255);
    const tooLong = await apiSignup(context.request, {
      email: email255,
      password: 'abcd1234',
      passwordConfirm: 'abcd1234',
    });
    expect(tooLong.status).toBe(400);
    expect(errMsg(tooLong.body)).toBe(EMAIL_LENGTH_ERROR);
  });

  test('이메일과 비밀번호가 둘 다 잘못되면, 이메일 형식 오류가 먼저 나온다 [A12]', async () => {
    const { status, body } = await apiSignup(context.request, {
      email: 'not-an-email',
      password: 'ab', // 길이도 위반
      passwordConfirm: 'ab',
    });
    expect(status).toBe(400);
    expect(errMsg(body)).toBe(EMAIL_FORMAT_ERROR);
  });
});

// ===========================================================================
// 시나리오 3: 비밀번호 길이를 지키지 않은 방문자
// [PRD D35/24.3 · A9/A10/A11]
// ===========================================================================
test.describe('시나리오: 비밀번호 길이를 지키지 않은 방문자', () => {
  const invalidPasswordInputs = [
    ['누락', undefined],
    ['null', null],
    ['숫자', 12345],
  ];
  for (const [label, value] of invalidPasswordInputs) {
    test(`비밀번호가 ${label}이면, 길이 오류로 거절된다 [A9]`, async () => {
      const payload = { email: uniqueEmail('a9'), passwordConfirm: value === undefined ? undefined : value };
      if (value !== undefined) payload.password = value;
      const { status, body } = await apiSignup(context.request, payload);
      expect(status).toBe(400);
      expect(errMsg(body)).toBe(PASSWORD_LENGTH_ERROR);
    });
  }

  const lengthBoundaries = [
    [3, 400],
    [4, 201],
    [20, 201],
    [21, 400],
  ];
  for (const [len, expectedStatus] of lengthBoundaries) {
    test(`비밀번호를 ${len}자로 입력하면, ${expectedStatus === 201 ? '통과한다' : '거절된다'} [A10]`, async () => {
      const password = 'a'.repeat(len);
      const { status, body } = await apiSignup(context.request, {
        email: uniqueEmail(`a10-${len}`),
        password,
        passwordConfirm: password,
      });
      expect(status).toBe(expectedStatus);
      if (expectedStatus === 400) {
        expect(errMsg(body)).toBe(PASSWORD_LENGTH_ERROR);
      }
    });
  }

  test('공백 4개("    ")로 가입해도 유효한 비밀번호로 처리되고, 그 공백 4개로 로그인도 된다 [D35 · A11]', async () => {
    const email = uniqueEmail('a11');
    const password = '    ';
    const { status } = await apiSignup(context.request, { email, password, passwordConfirm: password });
    expect(status).toBe(201);

    const login = await apiLogin(context.request, email, password);
    expect(login.status).toBe(200);
    await context.request.post('/api/auth/logout').catch(() => {});
  });

  test('비밀번호에 앞뒤 공백을 섞어 가입하면, 공백까지 포함한 원본 그대로만 로그인된다 — 이메일과 달리 비밀번호는 trim되지 않는다 [D35]', async () => {
    const email = uniqueEmail('a11-trim');
    const password = ' abcd1234 '; // 앞뒤 공백 포함, 10자 (4~20자 범위 내)
    const { status } = await apiSignup(context.request, { email, password, passwordConfirm: password });
    expect(status).toBe(201);

    // 공백을 뗀 값으로는 로그인되지 않는다 — 비밀번호는 원본 그대로 비교된다
    const trimmedAttempt = await apiLogin(context.request, email, password.trim());
    expect(trimmedAttempt.status).toBe(401);

    // 원본(공백 포함) 그대로는 로그인된다
    const exactAttempt = await apiLogin(context.request, email, password);
    expect(exactAttempt.status).toBe(200);
    await context.request.post('/api/auth/logout').catch(() => {});
  });
});

// ===========================================================================
// 시나리오 4: 비밀번호 확인란을 다르게 입력한 방문자
// [PRD D39/24.1/24.3 · A22~A28]
// ===========================================================================
test.describe('시나리오: 비밀번호 확인란을 다르게 입력한 방문자', () => {
  test('비밀번호와 확인란이 같으면 가입되고, 다르면 불일치 오류로 거절된다 [A23]', async () => {
    const matchEmail = uniqueEmail('a23-match');
    const matched = await apiSignup(context.request, {
      email: matchEmail,
      password: 'secret1234',
      passwordConfirm: 'secret1234',
    });
    expect(matched.status).toBe(201);

    const mismatchEmail = uniqueEmail('a23-mismatch');
    const mismatched = await apiSignup(context.request, {
      email: mismatchEmail,
      password: 'secret1234',
      passwordConfirm: 'secret123',
    });
    expect(mismatched.status).toBe(400);
    expect(errMsg(mismatched.body)).toBe(PASSWORD_MISMATCH_ERROR);
  });

  const confirmInputs = [
    ['누락', undefined],
    ['null', null],
    ['숫자', 98765],
    ['빈 문자열', ''],
  ];
  for (const [label, value] of confirmInputs) {
    test(`비밀번호 확인란이 ${label}이면, 이유를 가리지 않고 같은 불일치 오류로 거절된다 [A22]`, async () => {
      const payload = { email: uniqueEmail(`a22-${label}`), password: 'abcd1234' };
      if (value !== undefined) payload.passwordConfirm = value;
      const { status, body } = await apiSignup(context.request, payload);
      expect(status).toBe(400);
      expect(errMsg(body)).toBe(PASSWORD_MISMATCH_ERROR);
    });
  }

  test('확인란에 대문자만 다르거나 뒤에 공백 하나만 더 있어도, 일치하지 않는 것으로 처리된다 [D35 · A24]', async () => {
    const caseEmail = uniqueEmail('a24-case');
    const caseDiff = await apiSignup(context.request, {
      email: caseEmail,
      password: 'secret1234',
      passwordConfirm: 'Secret1234',
    });
    expect(caseDiff.status).toBe(400);
    expect(errMsg(caseDiff.body)).toBe(PASSWORD_MISMATCH_ERROR);

    const spaceEmail = uniqueEmail('a24-space');
    const spaceDiff = await apiSignup(context.request, {
      email: spaceEmail,
      password: 'secret1234',
      passwordConfirm: 'secret1234 ',
    });
    expect(spaceDiff.status).toBe(400);
    expect(errMsg(spaceDiff.body)).toBe(PASSWORD_MISMATCH_ERROR);
  });

  test('이메일 형식과 확인란이 둘 다 틀리면, 검증 순서상 이메일 오류가 먼저 나온다 [A25⒜]', async () => {
    const { status, body } = await apiSignup(context.request, {
      email: 'not-an-email',
      password: 'abcd1234',
      passwordConfirm: 'xxxxxxxx',
    });
    expect(status).toBe(400);
    expect(errMsg(body)).toBe(EMAIL_FORMAT_ERROR);
  });

  test('비밀번호가 3자로 너무 짧고 확인란도 안 맞으면, 검증 순서상 길이 오류가 먼저 나온다 [A25⒝]', async () => {
    const { status, body } = await apiSignup(context.request, {
      email: uniqueEmail('a25b'),
      password: 'abc',
      passwordConfirm: 'xyz',
    });
    expect(status).toBe(400);
    expect(errMsg(body)).toBe(PASSWORD_LENGTH_ERROR);
  });

  test('이미 가입된 이메일로 확인란까지 불일치하게 보내면, 불일치 오류가 나오고 중복 오류는 나오지 않는다 [A25⒞]', async () => {
    const email = uniqueEmail('a25c');
    const first = await apiSignup(context.request, {
      email,
      password: 'abcd1234',
      passwordConfirm: 'abcd1234',
    });
    expect(first.status).toBe(201);

    const second = await apiSignup(context.request, {
      email,
      password: 'differentpw1',
      passwordConfirm: 'nope-mismatch',
    });
    expect(second.status).toBe(400);
    expect(errMsg(second.body)).toBe(PASSWORD_MISMATCH_ERROR);
    expect(errMsg(second.body)).not.toBe(EMAIL_DUPLICATE_ERROR);
  });

  test('확인란 불일치로 거절된 뒤에도 서버 상태는 그대로다 — 계정이 안 만들어지고, 기존 계정 비밀번호도 안 바뀐다 [A26]', async () => {
    // (1) 완전히 새 이메일: 불일치로 한 번 거절된 뒤, 같은 이메일로 제대로 입력하면 정상 가입된다
    const freshEmail = uniqueEmail('a26-fresh');
    const rejected = await apiSignup(context.request, {
      email: freshEmail,
      password: 'abcd1234',
      passwordConfirm: 'zzzzzzzz',
    });
    expect(rejected.status).toBe(400);

    const retried = await apiSignup(context.request, {
      email: freshEmail,
      password: 'abcd1234',
      passwordConfirm: 'abcd1234',
    });
    expect(retried.status).toBe(201); // 앞선 요청이 계정을 만들어두지 않았다

    // (2) 이미 있는 계정: 불일치 요청을 보내도 원래 비밀번호로 계속 로그인된다
    const existingEmail = uniqueEmail('a26-existing');
    await apiSignup(context.request, {
      email: existingEmail,
      password: 'original-pw1',
      passwordConfirm: 'original-pw1',
    });
    const mismatchAttempt = await apiSignup(context.request, {
      email: existingEmail,
      password: 'hijack-pw999',
      passwordConfirm: 'totally-different',
    });
    expect(mismatchAttempt.status).toBe(400);

    const loginOriginal = await apiLogin(context.request, existingEmail, 'original-pw1');
    expect(loginOriginal.status).toBe(200);
    await context.request.post('/api/auth/logout').catch(() => {});
  });

  test('화면에서 확인란을 다르게 입력해 거절되면, 서버 메시지가 표시되고 세 입력값이 전부 그대로 남는다 [21.4 · A27]', async () => {
    const email = uniqueEmail('a27');

    await test.step('Given/When: 이메일·비밀번호는 맞게, 확인란만 다르게 입력해 제출한다', async () => {
      await page.goto('/signup.html');
      await page.getByTestId('signup-email').fill(email);
      await page.getByTestId('signup-password').fill('abcd1234');
      await page.getByTestId('signup-password-confirm').fill('totally-different');
      await page.getByTestId('signup-submit').click();
    });

    await test.step('Then: 불일치 오류가 표시되고, 세 입력값은 지워지지 않는다', async () => {
      await expect(page.getByTestId('signup-error')).toBeVisible();
      await expect(page.locator('#signup-error-message')).toHaveText(PASSWORD_MISMATCH_ERROR);
      await expect(page.getByTestId('signup-form')).toBeVisible();
      await expect(page.getByTestId('signup-success')).toBeHidden();

      await expect(page.getByTestId('signup-email')).toHaveValue(email);
      await expect(page.getByTestId('signup-password')).toHaveValue('abcd1234');
      await expect(page.getByTestId('signup-password-confirm')).toHaveValue('totally-different');
    });
  });

  test('화면은 두 비밀번호 값을 스스로 비교하지 않는다 — 불일치해도 버튼은 그대로 눌리고 요청이 실제로 나간다 [21.6 · A28]', async () => {
    const email = uniqueEmail('a28');
    const posts = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/api/auth/signup')) posts.push(req.postDataJSON());
    });

    await test.step('Given: 비밀번호와 확인란을 다르게 입력한다', async () => {
      await page.goto('/signup.html');
      await page.getByTestId('signup-email').fill(email);
      await page.getByTestId('signup-password').fill('abcd1234');
      await page.getByTestId('signup-password-confirm').fill('not-matching');
    });

    await test.step('Then: 실시간 일치 표시 같은 건 없고, 제출 버튼도 막히지 않는다', async () => {
      await expect(page.locator('[data-testid*="match"]')).toHaveCount(0);
      await expect(page.getByTestId('signup-submit')).toBeEnabled();
    });

    await test.step('When: 그래도 제출하면, 서버까지 실제 요청이 나간다', async () => {
      await page.getByTestId('signup-submit').click();
      await expect(page.getByTestId('signup-error')).toBeVisible();

      expect(posts).toHaveLength(1);
      expect(posts[0]).toEqual({ email, password: 'abcd1234', passwordConfirm: 'not-matching' });
    });
  });

  test('비밀번호 확인란도 비밀번호처럼 마스킹되고, 그 아래에는 별도 안내 문구를 두지 않는다 [25.7]', async () => {
    await page.goto('/signup.html');
    await expect(page.getByTestId('signup-password-confirm')).toHaveAttribute('type', 'password');
    await expect(page.getByTestId('signup-password-confirm-hint')).toHaveCount(0);
  });
});

// ===========================================================================
// 시나리오 5: 이미 가입된 이메일로 다시 가입을 시도하는 방문자
// [PRD D33/24.4 · A2~A5/A16]
// ===========================================================================
test.describe('시나리오: 이미 가입된 이메일로 다시 가입을 시도하는 방문자', () => {
  test('같은 이메일로 두 번 가입하면, 두 번째 시도는 중복 오류로 거절된다 [A2]', async () => {
    const email = uniqueEmail('a2');
    const first = await apiSignup(context.request, { email, password: 'abcd1234', passwordConfirm: 'abcd1234' });
    expect(first.status).toBe(201);

    const second = await apiSignup(context.request, { email, password: 'abcd1234', passwordConfirm: 'abcd1234' });
    expect(second.status).toBe(409);
    expect(errMsg(second.body)).toBe(EMAIL_DUPLICATE_ERROR);
  });

  test('대소문자만 다른 이메일로 다시 가입을 시도해도, 같은 계정으로 보고 거절된다 — 양방향 모두 [A3]', async () => {
    const base = `Hong.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
    const mixedCase = `${base}@Ex.com`;
    const lowerCase = `${base}@ex.com`;

    const first = await apiSignup(context.request, {
      email: mixedCase,
      password: 'abcd1234',
      passwordConfirm: 'abcd1234',
    });
    expect(first.status).toBe(201);

    const second = await apiSignup(context.request, {
      email: lowerCase,
      password: 'abcd1234',
      passwordConfirm: 'abcd1234',
    });
    expect(second.status).toBe(409);
  });

  test('앞뒤 공백만 다른 이메일로 다시 가입을 시도해도, 같은 계정으로 보고 거절된다 [A4]', async () => {
    const base = uniqueEmail('a4').trim();
    const first = await apiSignup(context.request, { email: base, password: 'abcd1234', passwordConfirm: 'abcd1234' });
    expect(first.status).toBe(201);

    const second = await apiSignup(context.request, {
      email: `  ${base}  `,
      password: 'abcd1234',
      passwordConfirm: 'abcd1234',
    });
    expect(second.status).toBe(409);
  });

  test('🚨 다른 비밀번호로 계정을 가로채려 해도, 거절될 뿐 기존 계정의 비밀번호는 바뀌지 않는다 [A5]', async () => {
    const email = uniqueEmail('a5');
    const originalPassword = 'original-pw1';
    const stolenPassword = 'attacker-pw2';

    const first = await apiSignup(context.request, {
      email,
      password: originalPassword,
      passwordConfirm: originalPassword,
    });
    expect(first.status).toBe(201);

    const takeover = await apiSignup(context.request, {
      email,
      password: stolenPassword,
      passwordConfirm: stolenPassword,
    });
    expect(takeover.status).toBe(409);

    const loginOriginal = await apiLogin(context.request, email, originalPassword);
    expect(loginOriginal.status).toBe(200);
    await context.request.post('/api/auth/logout').catch(() => {});

    const loginStolen = await apiLogin(context.request, email, stolenPassword);
    expect(loginStolen.status).toBe(401); // 계정 탈취 불가
  });

  test('화면에서 중복 이메일로 거절되면, 서버 안내가 표시되고 입력값 3개가 모두 남고 성공 안내는 보이지 않는다 [21.4 · A16]', async () => {
    const email = uniqueEmail('a16');
    await apiSignup(context.request, { email, password: 'abcd1234', passwordConfirm: 'abcd1234' });

    await page.goto('/signup.html');
    await page.getByTestId('signup-email').fill(email);
    await page.getByTestId('signup-password').fill('anotherpw1');
    await page.getByTestId('signup-password-confirm').fill('anotherpw1');
    await page.getByTestId('signup-submit').click();

    await expect(page.getByTestId('signup-error')).toBeVisible();
    await expect(page.locator('#signup-error-message')).toHaveText(EMAIL_DUPLICATE_ERROR);
    await expect(page.getByTestId('signup-form')).toBeVisible();
    await expect(page.getByTestId('signup-success')).toBeHidden();
    await expect(page.getByTestId('signup-email')).toHaveValue(email);
    await expect(page.getByTestId('signup-password')).toHaveValue('anotherpw1');
    await expect(page.getByTestId('signup-password-confirm')).toHaveValue('anotherpw1');
  });
});

// ===========================================================================
// 시나리오 6: 화면이 입력을 가로막지 않는지 확인하는 방문자
// [PRD 21.6/21.7/21.9/21.11~21.13/25.7 · A17~A21/A29/A30]
// ===========================================================================
test.describe('시나리오: 화면이 입력을 가로막지 않는지 확인하는 방문자', () => {
  test('이메일을 완전히 비운 채 제출해도, 브라우저가 막지 않고 요청이 실제로 나가 서버의 오류 안내가 표시된다 [A17/A30]', async () => {
    const posts = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/api/auth/signup')) posts.push(req.postDataJSON());
    });

    await page.goto('/signup.html');
    await page.getByTestId('signup-password').fill('abcd1234');
    await page.getByTestId('signup-password-confirm').fill('abcd1234');
    await page.getByTestId('signup-submit').click();

    await expect(page.getByTestId('signup-error')).toBeVisible();
    await expect(page.locator('#signup-error-message')).toHaveText(EMAIL_FORMAT_ERROR);
    expect(posts).toHaveLength(1);
    expect(posts[0].email).toBe('');
  });

  test('비밀번호 길이 안내 문구는 항상 떠 있고, 3자로 제출해도 그 문구는 바뀌지 않는다 [21.12 · A20/A21]', async () => {
    await page.goto('/signup.html');
    const hint = page.getByTestId('signup-password-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText('4자 이상 20자 이하로 입력해주세요.');

    const email = uniqueEmail('a21');
    const posts = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/api/auth/signup')) posts.push(req.postDataJSON());
    });

    await page.getByTestId('signup-email').fill(email);
    await page.getByTestId('signup-password').fill('abc');
    await page.getByTestId('signup-password-confirm').fill('abc');
    await page.getByTestId('signup-submit').click();

    await expect(page.getByTestId('signup-error')).toBeVisible();
    await expect(page.locator('#signup-error-message')).toHaveText(PASSWORD_LENGTH_ERROR);
    // 안내 문구는 에러와 별개 요소 — 글자도 안 바뀐다
    await expect(hint).toHaveText('4자 이상 20자 이하로 입력해주세요.');
    expect(posts).toHaveLength(1);
  });

  test('이메일 입력란에는 예시 글자(placeholder)만 있을 뿐 실제 값은 비어 있고, 브라우저 검증 속성도 없다 [21.13 · A29]', async () => {
    await page.goto('/signup.html');
    const emailInput = page.getByTestId('signup-email');
    await expect(emailInput).toHaveAttribute('placeholder', 'example@email.com');
    await expect(emailInput).toHaveValue('');
    await expect(emailInput).toHaveAttribute('type', 'text');
    for (const attr of ['required', 'pattern', 'minlength', 'maxlength']) {
      expect(await emailInput.evaluate((el, a) => el.hasAttribute(a), attr)).toBe(false);
    }

    // 비밀번호·비밀번호 확인 입력란에는 예시 글자를 두지 않는다
    await expect(page.getByTestId('signup-password')).not.toHaveAttribute('placeholder', /.+/);
    await expect(page.getByTestId('signup-password-confirm')).not.toHaveAttribute('placeholder', /.+/);
  });

  test('가입 버튼을 연달아 세 번 눌러도, 가입 요청은 한 번만 나간다 [21.7 · A18]', async () => {
    const email = uniqueEmail('a18');
    const posts = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/api/auth/signup')) posts.push(req.postDataJSON());
    });

    await page.goto('/signup.html');
    await page.getByTestId('signup-email').fill(email);
    await page.getByTestId('signup-password').fill('abcd1234');
    await page.getByTestId('signup-password-confirm').fill('abcd1234');

    const submit = page.getByTestId('signup-submit');
    await submit.click();
    await submit.click({ force: true });
    await submit.click({ force: true });

    await expect(page.getByTestId('signup-success')).toBeVisible();
    expect(posts).toHaveLength(1);
  });

  test('제출한 뒤 주소창에 비밀번호가 나타나지 않고, 브라우저 저장소에도 비밀번호가 남지 않는다 [21.11 · A19]', async () => {
    const email = uniqueEmail('a19');
    await page.goto('/signup.html');
    await page.getByTestId('signup-email').fill(email);
    await page.getByTestId('signup-password').fill('secret777');
    await page.getByTestId('signup-password-confirm').fill('secret777');
    await page.getByTestId('signup-submit').click();
    await expect(page.getByTestId('signup-success')).toBeVisible();

    expect(page.url()).toBe('http://localhost:3000/signup.html');
    expect(page.url()).not.toContain('secret777');

    const storage = await page.evaluate(() => ({
      local: JSON.stringify(Object.entries(localStorage)),
      session: JSON.stringify(Object.entries(sessionStorage)),
    }));
    expect(storage.local).not.toContain('secret777');
    expect(storage.session).not.toContain('secret777');
  });

  test('화면의 입력 순서는 이메일 → 비밀번호 → 길이 안내 문구 → 비밀번호 확인이다 [25.7]', async () => {
    await page.goto('/signup.html');
    // compareDocumentPosition으로 인접한 각 쌍이 "먼저 → 나중" 순서인지 DOM 안에서 전부 확인한다
    // (요소 핸들을 evaluate 밖으로 꺼내지 않고, 브라우저 안에서 한 번에 계산해 반환한다)
    const relations = await page.evaluate(() => {
      const ids = ['signup-email', 'signup-password', 'signup-password-hint', 'signup-password-confirm'];
      const els = ids.map((id) => document.querySelector(`[data-testid="${id}"]`));
      const results = [];
      for (let i = 0; i < els.length - 1; i += 1) {
        results.push(els[i].compareDocumentPosition(els[i + 1]));
      }
      return results;
    });
    // Node.DOCUMENT_POSITION_FOLLOWING === 4 → 다음 요소가 이전 요소보다 뒤에 온다
    for (const relation of relations) {
      expect(relation & 4).toBe(4);
    }
  });

  test('이미 로그인한 상태로 가입 화면에 들어가도 막지 않고, 새 계정 가입에 성공해도 지금 로그인한 계정은 그대로 유지된다 [21.9]', async () => {
    const existingEmail = uniqueEmail('a-existing-session');

    await test.step('Given: 기존 계정으로 미리 로그인해둔다', async () => {
      await apiSignup(context.request, {
        email: existingEmail,
        password: 'abcd1234',
        passwordConfirm: 'abcd1234',
      });
      const login = await apiLogin(context.request, existingEmail, 'abcd1234');
      expect(login.status).toBe(200);
    });

    await test.step('When: 로그인한 채로 회원가입 화면에 들어가 새 계정으로 가입한다', async () => {
      await page.goto('/signup.html');
      await expect(page.getByTestId('signup-form')).toBeVisible();
      await expect(page.getByTestId('auth-user')).toBeVisible();
      await expect(page.getByTestId('auth-user-email')).toHaveText(existingEmail);

      const newEmail = uniqueEmail('a-new-while-logged-in');
      await page.getByTestId('signup-email').fill(newEmail);
      await page.getByTestId('signup-password').fill('freshpw12');
      await page.getByTestId('signup-password-confirm').fill('freshpw12');
      await page.getByTestId('signup-submit').click();
      await expect(page.getByTestId('signup-success')).toBeVisible();
    });

    await test.step('Then: 새 계정 가입과 무관하게, 지금 로그인된 세션은 그대로다', async () => {
      const me = await context.request.get('/api/auth/me');
      const meBody = await me.json();
      expect(meBody.user.email).toBe(existingEmail);
      await context.request.post('/api/auth/logout').catch(() => {});
    });
  });
});
