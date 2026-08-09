---
name: shopping-mall-orchestrator
description: "쇼핑몰 웹사이트 제작 에이전트 팀(기획/백엔드/프론트/QA)을 조율하는 오케스트레이터. '쇼핑몰 만들어줘', '쇼핑몰 웹사이트 제작', '상품/장바구니/결제 기능 구현' 요청 시 반드시 이 스킬을 사용. 후속 작업(쇼핑몰 기능 추가/수정, 상품 목록 화면만 다시, 장바구니 로직 보완, 이전 결과 개선, 쇼핑몰 QA 재검증)에도 반드시 이 스킬을 사용할 것."
---

# Shopping Mall Orchestrator

쇼핑몰 웹사이트를 4명의 전문 에이전트 팀(기획/백엔드/프론트엔드/QA)으로 만드는 통합 스킬.

## 실행 모드: 에이전트 팀

## 에이전트 구성

| 팀원 | 에이전트 타입 | 역할 | 스킬 | 출력 | 모델 |
|------|-------------|------|------|------|------|
| product-planner | 커스텀 | PRD/데이터모델 정리 | shopping-mall-planning | `_workspace/01_planner_prd.md` | **opus** (판단 비중 높음) |
| backend-agent | 커스텀 | 상품/장바구니/결제 API | shopping-mall-backend | `_workspace/02_backend_api-spec.md` + 코드 | **sonnet** (명세 실행 위주) |
| frontend-agent | 커스텀 | 상품/장바구니/결제 화면 | shopping-mall-frontend | `_workspace/03_frontend_screens.md` + 코드 | **sonnet** (명세 실행 위주) |
| qa-agent (검증) | general-purpose | 경계면/스펙 검증 | shopping-mall-qa | `_workspace/04_qa_report.md`, `tests/test-cases.ko.md` | **opus** (판단 비중 높음) |
| qa-agent (자동화) | general-purpose | 승인된 케이스를 Playwright로 변환 | shopping-mall-qa | `tests/e2e/*.spec.js` | **sonnet** (기계적 변환) |

> 하네스 기본값은 전 팀원 opus지만, 이 프로젝트는 판단 비중이 낮은 실행 작업(구현,
> 자동화 코드 변환)에 한해 의도적으로 sonnet을 쓴다. 이유·변경일은 `CLAUDE.md`
> 변경 이력 참고. `Agent` 도구 호출 시 표의 모델을 그대로 `model` 파라미터에 넣는다.

## 워크플로우

### Phase 0: 컨텍스트 확인 (후속 작업 지원)

1. `_workspace/` 존재 여부 확인
2. 실행 모드 결정:
   - **미존재** → 초기 실행. Phase 1로 진행
   - **존재 + 부분 수정 요청** ("장바구니만 다시", "결제 로직 보완" 등) → 부분 재실행. 해당 에이전트만 팀으로 재소집하고, 관련 산출물만 갱신
   - **존재 + 새 쇼핑몰 요청** → 새 실행. 기존 `_workspace/`를 `_workspace_{YYYYMMDD_HHMMSS}/`로 이동 후 Phase 1
3. 부분 재실행 시: 이전 PRD/API spec/화면 문서 경로를 재소집된 에이전트에게 프롬프트에 포함하여, 기존 결과를 읽고 피드백을 반영하도록 지시

### Phase 1: 준비
1. 사용자 요청에서 범위 파악 (기본 MVP: 상품 목록/상세/장바구니/모의 결제, 회원 없음 — 사용자가 다른 범위를 명시하면 그것을 따른다)
2. `_workspace/` 생성 (초기 실행 시, 또는 새 실행에서 기존 폴더 이동 직후)

### Phase 2: 팀 구성

```
TeamCreate(
  team_name: "shopping-mall-team",
  members: [
    { name: "product-planner", agent_type: "product-planner", model: "opus",
      prompt: "shopping-mall-planning 스킬을 사용해 쇼핑몰 PRD와 데이터 모델을 작성하라. 완성 즉시 backend-agent와 frontend-agent에게 SendMessage로 공지." },
    { name: "backend-agent", agent_type: "backend-agent", model: "sonnet",
      prompt: "product-planner의 PRD를 기다렸다가, shopping-mall-backend 스킬을 사용해 상품/장바구니/결제 API를 구현하라. 엔드포인트 하나 완성할 때마다 frontend-agent에게 shape을 공지." },
    { name: "frontend-agent", agent_type: "frontend-agent", model: "sonnet",
      prompt: "product-planner의 PRD를 기다렸다가, shopping-mall-frontend 스킬을 사용해 화면을 구현하라. backend-agent가 공지하는 API shape에 맞춰 연동하고, 화면 하나 완성할 때마다 공지." },
    { name: "qa-agent", agent_type: "general-purpose", model: "opus",
      prompt: "shopping-mall-qa 스킬을 사용해 backend-agent와 frontend-agent의 산출물을 점진적으로 교차 검증하라. 모듈(상품/장바구니/결제) 하나가 양쪽에서 완성될 때마다 즉시 그 모듈만 검증. 검증 후 tests/test-cases.ko.md를 작성하고 멈춰서 사용자 승인을 기다려라 (자동화 코드는 승인 후 별도로 model: sonnet 호출에서 작성한다)." }
  ]
)

TaskCreate(tasks: [
  { title: "PRD 작성", assignee: "product-planner" },
  { title: "백엔드: 상품 API", assignee: "backend-agent", depends_on: ["PRD 작성"] },
  { title: "백엔드: 장바구니 API", assignee: "backend-agent", depends_on: ["PRD 작성"] },
  { title: "백엔드: 결제 API", assignee: "backend-agent", depends_on: ["PRD 작성"] },
  { title: "프론트: 상품 목록/상세 화면", assignee: "frontend-agent", depends_on: ["PRD 작성"] },
  { title: "프론트: 장바구니 화면", assignee: "frontend-agent", depends_on: ["PRD 작성"] },
  { title: "프론트: 결제 화면", assignee: "frontend-agent", depends_on: ["PRD 작성"] },
  { title: "QA: 상품 모듈 검증", assignee: "qa-agent", depends_on: ["백엔드: 상품 API", "프론트: 상품 목록/상세 화면"] },
  { title: "QA: 장바구니 모듈 검증", assignee: "qa-agent", depends_on: ["백엔드: 장바구니 API", "프론트: 장바구니 화면"] },
  { title: "QA: 결제 모듈 검증", assignee: "qa-agent", depends_on: ["백엔드: 결제 API", "프론트: 결제 화면"] }
])
```

> 상품/장바구니/결제를 별도 작업으로 나눈 이유: qa-agent가 모듈 단위로 점진적 검증을 할 수 있어야 하기 때문(전체 완성 후 한 번에 검증하면 버그 수정 비용이 커짐).

### Phase 3: 팀 작업 수행

**실행 방식:** 팀원들이 자체 조율

1. product-planner가 PRD 작성 후 backend-agent, frontend-agent에게 SendMessage로 공지
2. backend-agent와 frontend-agent가 병렬로 각자 모듈 작업, API 완성 시마다 SendMessage로 shape 공지
3. qa-agent는 모듈 하나(예: 상품)가 양쪽에서 완성되는 즉시 해당 모듈만 검증 — 전체 완성을 기다리지 않음
4. qa-agent가 불일치를 발견하면 backend-agent와 frontend-agent 양쪽 모두에게 SendMessage로 알리고, 둘이 논의해서 한쪽을 수정
5. 모든 팀원은 완료 시 파일 저장 + TaskUpdate로 진행 상황 갱신

**리더 모니터링:**
- 팀원이 유휴 상태가 되면 자동 알림 수신
- 특정 팀원이 막히면(예: backend-agent가 데이터 모델 관련 질문에 답을 못 받고 대기) SendMessage로 개입
- TaskGet으로 전체 진행률 확인

### Phase 4: 통합 및 최종 검증
1. 모든 Task 완료 대기 (TaskGet)
2. qa-agent의 최종 리포트(`_workspace/04_qa_report.md`) 확인 — Critical 항목이 남아있으면 해당 에이전트에게 재작업 요청 (최대 1회 추가 루프)
3. **테스트 자동화 승인 체크포인트 (필수, 건너뛰지 않는다):** qa-agent는 검증이 끝나면
   `tests/test-cases.ko.md`를 먼저(만) 갱신하고 멈춘다 (`agents/qa-agent.md`의 2단계
   프로세스 참고). 리더는 이 문서를 사용자에게 보여주고 승인을 받은 뒤에야 qa-agent에게
   2단계(`tests/e2e/*.spec.js` 자동화 작성)를 진행하라고 알린다. 문서 단계를 건너뛰고
   바로 자동화 코드를 작성하도록 지시하지 않는다.
4. 산출물 요약 정리

### Phase 5: 정리
1. 팀원들에게 종료 요청 (SendMessage)
2. 팀 정리 (TeamDelete)
3. `_workspace/` 보존 (중간 산출물 삭제하지 않음 — 사후 검증·감사 추적용)
4. 사용자에게 결과 요약 보고 (완성된 화면/API, QA 통과 여부, 남은 이슈)

## 데이터 흐름

```
[리더] → TeamCreate → [product-planner]
                            │ SendMessage (PRD 완성 공지)
                ┌───────────┴───────────┐
                ↓                       ↓
        [backend-agent]  ←SendMessage→  [frontend-agent]
                │ (API shape 공지)              │
                └───────────┬───────────────────┘
                            ↓ (모듈 완성마다)
                        [qa-agent]
                            │
                            ↓ Read (전체 _workspace/)
                      [리더: 통합·보고]
```

## 에러 핸들링

| 상황 | 전략 |
|------|------|
| backend-agent 또는 frontend-agent 1명 실패/중지 | 리더가 감지 → SendMessage로 상태 확인 → 재시작 |
| product-planner가 요구사항 확정 못 함 (사용자 응답 대기) | 리더가 사용자에게 직접 확인 요청, 팀은 대기 |
| qa-agent가 Critical 이슈를 반복 발견 (같은 모듈 2회 이상) | 리더가 개입 — backend/frontend에게 직접 SendMessage로 근본 원인 논의 지시 |
| 팀원 간 API shape 합의 실패 | product-planner에게 최종 결정 요청 |
| 타임아웃 | 현재까지 완성된 모듈만으로 결과 보고, 미완료 모듈 명시 |

## 테스트 시나리오

### 정상 흐름
1. 사용자가 "쇼핑몰 웹사이트 만들어줘" 요청
2. Phase 1에서 MVP 범위 확정 (상품/장바구니/모의결제, 회원 없음)
3. Phase 2에서 4명 팀 구성 + 10개 작업 등록
4. Phase 3에서 product-planner → PRD 완성 → backend/frontend 병렬 작업 → qa-agent가 상품 모듈부터 점진 검증
5. Phase 4에서 전체 Task 완료 확인, QA 리포트에 Critical 없음
6. Phase 5에서 팀 정리, 결과 보고
7. 예상 결과: 상품 목록/상세/장바구니/결제 화면과 API가 동작하고, QA 리포트에 Critical 이슈 없음

### 에러 흐름
1. Phase 3에서 backend-agent가 장바구니 API 응답에 `items` 래핑 여부를 공지하지 않고 넘어감
2. frontend-agent가 임의로 배열이라고 가정하고 연동
3. qa-agent가 "QA: 장바구니 모듈 검증" 단계에서 코드 교차 비교 중 불일치 발견
4. qa-agent가 backend-agent와 frontend-agent 양쪽에 SendMessage로 파일:라인 + 수정 방향 전달
5. backend-agent가 문서화를 보완하고, frontend-agent가 언랩 로직 수정
6. qa-agent가 재검증 후 통과
7. 최종 보고서에 "장바구니 모듈 1회 재작업" 기록
