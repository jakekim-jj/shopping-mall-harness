# 성능 테스트 학습 메모 (세션 정리)

작성 목적: 포트폴리오 확정이 아니라 **이해 우선**으로 돌린 k6 실험 기록.  
범위: **부하(load)** · **스파이크** 위주. 스트레스·소크·결제 풀플로우는 미실시 또는 얕음.

---

## 1. 환경

| 항목 | 내용 |
|------|------|
| 앱 | shopping-mall-harness (`localhost:3000`) |
| 도구 | k6 + `make-relative-report.js` (한글 HTML) |
| 기본 시나리오 | `GET /api/products` → sleep → `GET /api/products/:id` → sleep |
| E2E와 관계 | Playwright(`tests/e2e`)와 **분리**된 `tests/perf` |
| 한계 | 로컬 Express·인메모리. 프로덕션/실DB 한계가 아님. 트래픽은 loopback → 사내망 영향 거의 없음 |

---

## 2. 한 일 (순서)

### 2.1 스모크 → 부하 ramp

- 스크립트·API 연결 확인 후 VU를 서서히 올리는 ramp
- Think Time(sleep) 기본 0.5초
- 가벼운 조건에서는 실패 0%, p95 ~1ms대 → **아직 한계에 안 닿음**

### 2.2 VU만 바꿔 비교 (sleep 고정 0.5)

- VU 150 / 200 / 300 / 500 / 800
- **RPS·VU 곡선**은 목표만큼 커짐
- 응답시간·실패율은 거의 그대로 (sleep이 요청 수를 크게 눌림)

### 2.3 Think Time만 바꿔 비교 (VU 고정 300) ★핵심

- sleep `0.5` / `0.1` / `0`
- sleep↓ → **RPS 크게 ↑** (같은 사람 수가 더 자주 요청)
- sleep 0에서 p95가 올라가며 “바빠지면 느려진다”가 보임
- 교훈: **VU를 올리는 것**과 **sleep을 줄이는 것**은 부하 의미가 다름

### 2.4 시나리오 확장 (browse+cart)

- 목록+상세 vs 목록+상세+담기+장바구니
- 로컬에선 지표 차이가 크지 않음 → 학습 우선순위는 낮음

### 2.5 실패 UX 데모

- `?simulate=error` 등으로 의도적 실패 → threshold 탈락·리포트 확인
- “진짜 서버 한계로 죽은 것”이 아님. 로컬에서 자연 실패는 잘 안 남

### 2.6 스파이크 vs 부하(ramp)

- 같은 목표 VU·sleep·시나리오, **VU 올리는 모양만** 다름
  - ramp: 천천히 목표까지
  - spike: 낮게 유지 → 짧은 구간(예: 2~5초)에 목표까지 → 유지 → 하락
- 기본 비교: VU 300 · sleep 0.5 → 실패·p95는 둘 다 여유로움. 차이는 **그래프의 VU/RPS 형태**
- 극단: VU 800 · sleep 0 · 급상승 2초 → p95 ~50ms대, RPS ~1만 후반. 실패는 여전히 0%에 가까움
- 관찰: 같은 최대 VU라도 스파이크 쪽이 **p95/p99(꼬리)** 가 더 잘 튀는 편

### 2.7 리포트

- k6 `--out json` → `make-relative-report.js` (단일 / overlay / overlay-rich)
- 볼 지표 3개면 충분: **VU · RPS · p95(p99)**
- k6 웹 대시보드 HTML export만 보면 **RPS가 약함** → 우리 리포트 사용
- sleep 0 + 고VU JSON은 수 GB까지 가능 → results는 gitignore

---

## 3. 지표 의미 (이 실험 기준)

| 지표 | 의미 |
|------|------|
| VU | 동시에 시나리오를 도는 가상 사용자 |
| Think Time (sleep) | 요청 사이 대기. RPS를 크게 좌우 |
| RPS | 초당 HTTP 요청 수 |
| HTTP 응답시간 | 요청~응답 (sleep 제외) |
| avg / p95 / p99 | 평균 / 느린 쪽 5% / 1% (꼬리) |
| 실패율 | 연결 실패·5xx 등 |

---

## 4. 비교 시 주의

- **공정 비교**: 목표 VU·sleep·시나리오·가능하면 **총 stages 시간**을 맞출 것
- 극단 스파이크 실험에서 hold를 줄이면 총 시간이 ramp(90초)보다 짧아질 수 있음  
  → **올리는 모양** 비교는 유효, **합산 평균·총 요청 수**만으로 우열을 가르면 부정확
- “실패 0%” ≠ “느려지지 않음”. 스파이크 학습 포인트는 종종 **꼬리 지연**

---

## 5. 아직 안 한 것

| 항목 | 상태 |
|------|------|
| 스트레스 (한계까지 밀어 실패/붕괴) | 미실시 (sleep 0이 약한 스트레스에 가까움) |
| 소크 (장시간) | 미실시 |
| 결제 풀플로우 부하 | 미실시 |
| 원격/공유 환경 부하 | 의도적으로 안 함 (localhost만) |

---

## 6. 자주 쓰는 명령

```bash
npm run test:perf:think-compare
npm run test:perf:spike-compare
npm run test:perf:load:compare-rich
npm run test:perf:scenario-compare
npm run test:perf:fail:report
```

상세 실행법·환경변수는 [`README.md`](./README.md).
