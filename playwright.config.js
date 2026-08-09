'use strict';

/**
 * Playwright 설정 — 쇼핑몰 하네스 E2E 테스트
 *
 * skills/shopping-mall-qa/SKILL.md "자동화 테스트 작성 규칙" 확정값:
 *   - baseURL: http://localhost:3000  (PRD Tech stack — 포트 고정)
 *   - testDir: ./tests/e2e            (화면별로 spec 파일을 나눈다)
 *   - webServer로 `npm start` 자동 기동
 *
 * ⚠ reuseExistingServer: true — 이미 3000 포트에 수동 확인용 서버가 떠 있으면
 *   그 서버를 그대로 쓴다. 죽이거나 실패로 처리하지 않는다.
 *   (장바구니는 프로세스 메모리에 있으므로 서버를 재시작하면 남의 세션이 날아간다 — PRD D6)
 *
 * 브라우저 창(컨텍스트) 정책: spec 파일 하나당 창 하나다. 각 spec이 test.beforeAll에서
 * 컨텍스트를 한 번만 만들어 그 파일의 모든 테스트가 재사용한다 (SKILL.md 규칙 —
 * --headed로 볼 때 테스트마다 창이 깜빡이지 않게 하기 위함). 파일 3개 = 창 3개다.
 *
 * ⚠ 그래서 fullyParallel: false 다. 테스트를 파일 안에서 쪼개 여러 워커로 흩으면
 *   beforeAll이 워커마다 다시 실행되어 창이 다시 여러 개가 된다. 파일 단위 병렬은 유지된다
 *   (파일끼리는 서로 다른 워커 = 서로 다른 cartId 쿠키라 간섭하지 않는다).
 *
 * 장바구니 격리: 창을 공유하면 cartId 쿠키도 공유되므로, 각 spec이 beforeEach에서
 * DELETE /api/cart로 장바구니를 비우고 시작한다 (PRD D5 / 8.5).
 */
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    // data-testid만 선택자로 쓴다 (SKILL.md 규칙). 기본값이지만 명시해 둔다.
    testIdAttribute: 'data-testid',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npm start',
    url: 'http://localhost:3000/api/products',
    reuseExistingServer: true,
    timeout: 30 * 1000,
  },
});
