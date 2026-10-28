# 성능 / 부하 테스트 (k6 실험 트랙)

기능 E2E(`tests/e2e`, Playwright)와 **분리**된 트랙이다.  
하네스 승인 게이트는 없다. **로컬 Express + 인메모리**라서 프로덕션 한계와는 다르다.

학습 과정에서 확인한 내용은 [`LEARNING-NOTES.md`](./LEARNING-NOTES.md)에 정리해 두었다.

## 준비

1. [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) 설치 (`winget install GrafanaLabs.k6`)
2. 서버 기동: `npm start` (포트 3000) — **부하는 서버를 켠 채**, `localhost`만 치므로 사내망 영향은 거의 없음
3. 결과 JSON/HTML은 `tests/perf/results/` (gitignore)

## 한눈에 보는 실행

```bash
# 스모크 (짧은 확인)
npm run test:perf:smoke
npm run test:perf:cart
npm run test:perf:mixed
npm run test:perf                 # 스모크 셋

# 부하(ramp) — 읽기 API, VU 서서히 상승 (~90초)
npm run test:perf:load
npm run test:perf:load:report     # HTML 리포트 (경과시간 축)
npm run test:perf:load:compare-rich

# Think Time만 줄여 비교 (기본 VU=300, sleep 0.5 / 0.1 / 0)
npm run test:perf:think-compare

# 시나리오: 목록+상세 vs 목록+상세+담기+장바구니 조회
npm run test:perf:scenario-compare

# 스파이크 vs 부하(ramp) — 같은 목표 VU·sleep, VU 올리는 모양만 다름
npm run test:perf:spike
npm run test:perf:spike-compare

# 실패 UX 데모 (의도적 500 — 서버 다운 재현이 아님)
npm run test:perf:fail:report
```

환경변수 예 (PowerShell):

```powershell
$env:TARGET_VUS = "300"
$env:THINK_TIME = "0.5"
npm run test:perf:spike-compare

# 더 극단 스파이크 (그래프는 우리 리포트 추천 — k6 기본 export는 RPS가 약함)
k6 run -e TARGET_VUS=800 -e THINK_TIME=0 -e SPIKE_UP=2s -e SPIKE_HOLD=40s `
  --out json=tests/perf/results/spike.json tests/perf/load-spike-read.js
node tests/perf/make-relative-report.js tests/perf/results/spike.json out.html
```

> `THINK_TIME=0` + 고VU는 JSON이 **수 GB**까지 커질 수 있다. 탐색만 할 때는 `--out json` 없이 돌리거나 hold를 줄인다.

## 스크립트

| 파일 | 역할 |
|------|------|
| `smoke-products.js` | 목록/상세/리뷰 읽기 스모크 |
| `cart-checkout.js` | 담기 → 조회 → 모의결제 |
| `mixed-read.js` | 읽기 비율 혼합 |
| `load-ramp-read.js` | **부하** — VU 서서히 상승 + Think Time |
| `load-spike-read.js` | **스파이크** — 낮은 VU → 짧은 구간 급상승 → 유지 → 급하락 |
| `load-ramp-browse-cart.js` | 목록+상세+담기+장바구니 조회 ramp |
| `load-fail-demo.js` | 의도적 실패율로 리포트/threshold UX |
| `make-relative-report.js` | k6 JSON → 경과시간 축 HTML (단일 / `--overlay` / `--overlay-rich`) |
| `run-*-compare.js` 등 | 비교 실행 + 리포트 생성 헬퍼 |

### 스파이크 stages (`load-spike-read.js`)

- 기본 총 ~90초 (ramp와 맞춤): 낮게 15s → 급상승 `SPIKE_UP`(기본 5s) → 유지 `SPIKE_HOLD`(기본 40s) → 하락
- `TARGET_VUS`, `THINK_TIME`, `SPIKE_UP`, `SPIKE_HOLD` 로 조절

## 그래프에서 볼 것 (3개면 충분)

1. **VU** — 올리는 모양 (ramp=사선, spike=벽)
2. **RPS** — VU를 따라 초당 요청이 언제 튀는지
3. **p95 / p99** — 느린 꼬리. 스파이크는 같은 최대 VU라도 급상승 구간에 꼬리가 더 잘 올라감

우리 리포트의 「초당 요청 수 (RPS)」를 본다. k6 웹 대시보드 export만 보면 RPS가 약하다.

## 로컬에서 배운 한계

- sleep 0.5 + VU 수백에서는 응답·실패가 거의 안 흔들림
- sleep을 줄이거나 VU를 크게 + 스파이크를 짧게 해야 p95가 눈에 띄게 움직임
- 실패율 0%인 경우가 많음 → “안 죽는다”와 “안 느려진다”는 다름
