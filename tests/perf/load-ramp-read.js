/**
 * 부하 입문용 — 읽기 API, VU ramp + Think Time 조절
 *
 * 환경변수:
 *   TARGET_VUS   목표 동시 사용자 (기본 150)
 *   THINK_TIME   요청 사이 대기 초 (기본 0.5). 0이면 쉬지 않고 연타
 *
 * 접근법 (Think Time 실험):
 *   1) VU·시간(stages)은 고정
 *   2) THINK_TIME만 0.5 → 0.1 → 0 으로 줄이며 같은 리포트에 겹침
 *   3) RPS·p95/p99가 어떻게 벌어지는지 본다
 *
 *   k6 run -e TARGET_VUS=300 -e THINK_TIME=0 tests/perf/load-ramp-read.js
 *   npm run test:perf:think-compare
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const listDuration = new Trend('products_list_duration', true);
const detailDuration = new Trend('products_detail_duration', true);

const TARGET_VUS = Number(__ENV.TARGET_VUS || 150);
const THINK_TIME = Number(__ENV.THINK_TIME !== undefined ? __ENV.THINK_TIME : 0.5);
const WARM_VUS = Math.max(1, Math.round(TARGET_VUS * 40 / 150));

export const options = {
  stages: [
    { duration: '20s', target: WARM_VUS },
    { duration: '30s', target: TARGET_VUS },
    { duration: '25s', target: TARGET_VUS },
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<500'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const PRODUCT_IDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];

function pickId() {
  return PRODUCT_IDS[Math.floor(Math.random() * PRODUCT_IDS.length)];
}

function maybeSleep() {
  if (THINK_TIME > 0) sleep(THINK_TIME);
}

export default function () {
  const list = http.get(`${BASE_URL}/api/products`);
  listDuration.add(list.timings.duration);
  check(list, { 'list 200': (r) => r.status === 200 });
  maybeSleep();

  const id = pickId();
  const detail = http.get(`${BASE_URL}/api/products/${id}`);
  detailDuration.add(detail.timings.duration);
  check(detail, { 'detail 200': (r) => r.status === 200 });
  maybeSleep();
}
