## 하네스: 쇼핑몰 웹사이트 제작

**목표:** 상품 목록/상세/장바구니/모의 결제로 구성된 쇼핑몰 웹사이트를, 기획/백엔드/프론트엔드/QA 4명의 에이전트 팀이 협업하여 제작한다.

**트리거:** 쇼핑몰 관련 작업 요청 시 `shopping-mall-orchestrator` 스킬을 사용하라. 단순 질문은 직접 응답 가능.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-08-05 | 초기 구성 (기획/백엔드/프론트/QA 4명 팀) | 전체 | 상품/장바구니/결제 MVP 범위로 첫 하네스 설계 |
| 2026-08-08 | 상품 상세+장바구니 확장 (기존 매뉴얼 재사용, 부분 재실행) | PRD/API/화면/QA 문서 | 랜딩페이지 다음 단계로 범위 확장 |
| 2026-08-08 | `docs/bug-history/` RAG 검색 단계 추가 (backend/frontend/qa 3개 에이전트 매뉴얼에 "작업 전 히스토리 확인" 지침 삽입) | agents/backend-agent.md, frontend-agent.md, qa-agent.md | 과거 발견된 버그(쿠키 경쟁조건, 공용 에러핸들러 재사용 등)가 다음 기능(결제 등)에서 같은 패턴으로 재발하는지 사전에 잡아내기 위함 |
| 2026-08-09 | 장바구니 전체 비우기 + 수량 10개 이상 10% 할인 기능 추가 (3차 사이클). RAG 실전 검증 — backend-agent가 M5(공용 에러핸들러)를 스스로 재발 방지, M4(쿠키 경쟁조건)는 무관함을 스스로 판단 | PRD/API/화면/QA 문서, server.js, public/cart.* | 기능 확장 + RAG 히스토리 검색이 실제로 효과 있는지 실험 |
| 2026-08-09 | qa-agent 역할에 "자동화 테스트 유지보수" 추가 — 검증 후 `tests/e2e/*.spec.js`(Playwright) + `tests/test-cases.ko.md`(누적 테스트 케이스 목록)를 매 사이클 갱신하도록 변경 | agents/qa-agent.md, skills/shopping-mall-qa/SKILL.md | 기존엔 매 사이클 curl/임시 스크립트로 검증만 하고 버려서 재사용 자산이 안 남았음. mini-qa-agent-v2의 test-cases.ko.md 패턴을 이식 |
| 2026-08-09 | 자동화 테스트 규칙에 "spec 파일(PRD 단위)당 브라우저 컨텍스트 1개 공유" 추가 | skills/shopping-mall-qa/SKILL.md, tests/e2e/*.spec.js | headed 모드로 사용자가 직접 지켜볼 때 테스트마다 창이 새로 열려 불편함 — mini-qa-agent-v2에서 이미 적용했던 패턴을 이식 |
| 2026-08-09 | qa-agent의 자동화 프로세스를 "문서 작성 → 사용자 승인 → 자동화 코드 작성" 2단계로 고정. 오케스트레이터 Phase 4에 승인 체크포인트 명시 | agents/qa-agent.md, skills/shopping-mall-orchestrator/SKILL.md | 이번 사이클에 사용자가 "케이스 먼저 보고 승인한 뒤 자동화"를 요청 — 매번 수동으로 요청 안 해도 되게 하네시 규칙으로 고정 |
| 2026-08-09 | 하네스 기본값(전원 opus)을 부분적으로 낮춤 — backend-agent/frontend-agent/qa-agent(자동화 단계)는 sonnet, product-planner/qa-agent(검증 단계)는 opus 유지 | agents/backend-agent.md, frontend-agent.md, qa-agent.md, skills/shopping-mall-orchestrator/SKILL.md | 사용자가 토큰 소비량 지적 — 판단 비중이 낮은 실행 작업(상세 명세를 그대로 구현/변환)은 sonnet으로도 충분하다고 판단, 판단 비중 높은 두 곳(범위 결정, 경계면 검증)만 opus 유지 |
| 2026-08-10 | 4번째 사이클: 모의 결제(mock checkout) 추가 — 장바구니→결제→주문확인, 실제 PG 미연동, 결제수단으로 성공/실패 결정론적 시뮬레이션. Playwright 84개 전부 통과(기존 45 → 84) | _workspace/*, server.js, public/checkout.*, public/order.*, tests/test-cases.ko.md, tests/e2e/checkout.spec.js, order.spec.js, cart.spec.js | 원래 MVP 범위(상품/장바구니/모의결제)의 마지막 조각. 사용자가 "실PG 연동 안 되면 반쪽짜리 아니냐" 우려 제기 → 모의 결제로도 경계면(장바구니↔결제 총액 일치, 성공/실패 분기, 재고 미차감 등) 검증 가치는 있다고 합의 후 진행. 이번 세션에서 Agent Teams(TeamCreate) 비활성으로 오케스트레이터의 팀 모드 대신 서브 에이전트 순차 호출(product-planner→backend→frontend→qa) 폴백 경로 사용 |
