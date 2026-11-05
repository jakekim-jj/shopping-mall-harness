---
id: BUG-2026-11-05-01
severity: minor
status: fixed
area: [testing, playwright, flaky, shared-context]
found_in_cycle: 6차 이후 (QA 하네스 보강)
found_by: qa (전체 스위트 반복 실행)
---

# 지연 route를 응답 전에 unroute → 공유 창 전체가 무너지는 flaky (E2E 테스트 코드 결함)

## 한 줄 요약
"로딩 상태" 테스트가 `page.route`로 응답을 1초 늦춘 뒤, **그 응답이 끝나기 전에** `page.unroute` 하고
다음 `test.step`에서 `goto` 하면, 1초 뒤 깨어난 `route.continue()`가 `Route is already handled!`를 던진다.
spec 파일당 창 1개를 공유하므로(SKILL.md 규칙) 이 에러가 **같은 파일의 뒤 테스트**를
`Target page, context or browser has been closed`로 무너뜨린다. 실패가 엉뚱한 테스트(예: checkout 18.5)에
찍혀서 원인 추적이 어렵다. 제품 코드 결함 아님.

## 발견 경위
2026-11-05 클라우드 환경에서 전체 299개를 반복 실행 — 매 회 1건씩, 실패 테스트가 매번 달랐다.
`checkout.spec.js --repeat-each=3`에서 `route.continue: Route is already handled!` 확인.

## 해당 위치와 처방
| 위치 | 처방 |
|------|------|
| `tests/e2e/checkout.spec.js` 16.17 "로딩 중에는 로딩 상태만 보인다" | `waitForResponse`로 지연 응답 완료를 기다린 뒤 unroute |
| `tests/e2e/order.spec.js` 17.11 "로딩 중에는 로딩 상태만 보인다" | 같은 구조(아직 터지진 않았지만 같은 레이스) — 같은 처방 |

선례: `auth-session.spec.js` C17은 이미 같은 처방(`await meResponse` 후 unroute)을 쓰고 있었다.
테스트 끝에서 정리되는 경우는 `afterEach`의 `unrouteAll({ behavior: 'ignoreErrors' })`가 막아주므로 안전하다.
**위험한 것은 "테스트 중간"(test.step 사이)에서 지연 handler를 unroute하는 경우뿐이다.**

## 같은 날 함께 정리한 것
`auth-session.spec.js` C18의 장바구니 본문 4상태 카운트가 `isVisible()` 스냅샷 루프였다 —
2026-10-13 `expectOnlyState`에서 없앤 것과 같은 패턴(로딩→완료 전환 순간 0개/2개). 병렬 부하에서 2회 관찰.
`:visible` 합집합 locator + `toHaveCount(1)`(재시도 대기)로 교체.

## 다음에 주의할 점 (재발 방지)
- 새 spec에서 `setTimeout`으로 지연시키는 route를 만들고 **같은 테스트 안에서 다음 화면으로 넘어간다면**,
  `const r = page.waitForResponse(...)`를 goto 전에 걸고 `await r` 후에 unroute한다.
- 상태 개수를 셀 때 `isVisible()`를 순서대로 부르지 말고 재시도하는 `expect`(toHaveCount/toBeVisible)를 쓴다.

## 검증
- checkout + order `--repeat-each=10` → 360/360 통과
- auth-session `--repeat-each=10` → 180/180 통과
- 전체 299개 5회 연속 → 전부 통과 (클라우드 headless, 약 40초/회)
