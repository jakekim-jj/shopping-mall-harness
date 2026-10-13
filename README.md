# shopping-mall-harness

AI 에이전트 팀(기획 / 백엔드 / 프론트 / QA)이 **사이클 단위로** 쇼핑몰 MVP를 만들고,  
그 과정에서 **QA가 검증·자동화·재발 방지를 어떻게 보강하는지**를 남기는 하네스 레포입니다.

제품 데모보다 **경계면 검증, 케이스 승인 → 자동화, 회귀 자산, 버그 히스토리**가 이 레포의 중심입니다.

## 무엇을 다루는가

| 영역 | 내용 |
|------|------|
| 상품 | 목록 · 상세 |
| 장바구니 | CRUD · 전체 비우기 · 수량 할인 |
| 결제 | 모의 결제(성공/실패 결정론) · 주문 확인 |
| 회원 | 회원가입 · 로그인 · 로그아웃 (장바구니와 비연동) |
| 리뷰 | 평점/리뷰 — 읽기 공개, 쓰기·수정·삭제는 로그인 + 소유권 |

단일 Node 서버(`server.js`)가 API와 `public/` 정적 화면을 **포트 3000**에서 함께 제공합니다.  
DB 없음(프로세스 메모리). 서버를 재시작하면 장바구니·회원·리뷰 상태가 초기화됩니다.

## 사이클 한눈에

| 차수 | 날짜 | QA가 확정하려 한 것 | Playwright |
|------|------|---------------------|------------|
| 1~4 | 2026-08 | 상품 → 장바구니 → 모의결제 MVP, 자동화 유지보수·승인 2단계·모델 티어 | → 84 |
| 5 | 2026-10-07 | 인증 경계 · **네거티브 케이스** · BDD 서술 규칙 | 84 → 204 |
| 6 | 2026-10-11 | **인가(소유권)** · 주문 조회와 다른 403/404 정책 · flaky 안정화 | 204 → **299** |

하네스 규칙이 왜 바뀌었는지는 [`CLAUDE.md` 변경 이력](./CLAUDE.md)이 원본입니다.

## QA 프로세스 (이 레포의 핵심)

매 사이클 QA는 한 번에 코드를 몰아 쓰지 않습니다.

1. **경계면 검증** — API 응답 shape ↔ 프론트 호출부를 동시에 읽고, 실서버·실브라우저로 재현  
2. **`tests/test-cases.ko.md` 작성 후 중단** — 사람(비개발자 포함)이 읽는 케이스 목록, 사이클 목적 서술 포함  
3. **사용자 승인** — 오케스트레이터 체크포인트  
4. **승인된 목록만 Playwright로 이관** — 임의 추가/생략 없음, 작성 후 `npm test`로 통과 확인  
5. **과거 버그 재발 점검** — `docs/bug-history/`를 작업 전 확인 (에이전트 매뉴얼에 필수)

자동화 서술: BDD/시나리오 스타일 (`describe` = 방문자 시나리오, PRD 번호는 `[ ]` 각주).  
상세 규칙은 `.claude/skills/shopping-mall-qa/SKILL.md`를 따릅니다.

## 빠른 시작

요구사항: **Node.js 20+**

```bash
npm install
npx playwright install chromium
npm start
```

브라우저에서 http://localhost:3000

### 테스트

```bash
npm test                 # headless, Chromium (로컬 @playwright/test CLI)
npm run test:headed      # 창 보며 실행 (파일당 컨텍스트 1개)
```

`playwright.config.js`가 `npm start`로 서버를 자동 기동합니다.  
이미 3000 포트에 서버가 떠 있으면 그 서버를 재사용합니다(`reuseExistingServer: true`).

**회귀 기준 시간 (2026-10-13, 로컬 headless Chromium):** 전체 299개 약 **15–25초**  
(파일 단위 병렬, 기본 워커. CI 붙일 때 이 구간을 예산으로 쓴다.)

## 레포 구조

```
.claude/agents/     # 역할별 에이전트 매뉴얼 (planner / backend / frontend / qa)
.claude/skills/     # 오케스트레이터·기획·백엔드·프론트·QA 스킬
_workspace/         # 사이클 산출물 (PRD, API 스펙, 화면 메모, QA 리포트)
docs/bug-history/   # 재발 방지용 버그 히스토리 (에이전트 RAG)
public/             # 정적 화면
tests/
  test-cases.ko.md  # 사람이 읽는 누적 테스트 케이스
  e2e/*.spec.js     # Playwright (화면·경계면 단위)
server.js           # Express API + 정적 서빙
CLAUDE.md           # 하네스 목표 · 변경 이력(사유 포함)
```

## 에이전트로 작업할 때

쇼핑몰 기능 추가·수정·QA 재검증 요청 시 `shopping-mall-orchestrator` 스킬을 사용합니다.  
단순 질문은 오케스트레이터 없이 응답해도 됩니다. 자세한 트리거·모델 티어(판단=opus, 실행=sonnet)는 `CLAUDE.md`와 `.claude/skills/shopping-mall-orchestrator/SKILL.md`를 참고하세요.
