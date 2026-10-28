/**
 * 스파이크 테스트 — VU를 천천히 올리지 않고 갑자기 올린다
 *
 * 부하(ramp): 0 → … → 300 (서서히)
 * 스파이크:   낮음 → 짧은 시간에 300 → 유지 → 급격히 내림
 *
 * 시나리오는 기초와 동일 (목록 → 상세). Think Time 기본 0.5
 *
 *   k6 run -e TARGET_VUS=300 -e THINK_TIME=0.5 tests/perf/load-spike-read.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const listDuration = new Trend('products_list_duration', true);
const detailDuration = new Trend('products_detail_duration', true);

const TARGET_VUS = Number(__ENV.TARGET_VUS || 300);
const THINK_TIME = Number(__ENV.THINK_TIME !== undefined ? __ENV.THINK_TIME : 0.5);
const BASE_VUS = Math.max(1, Math.round(TARGET_VUS * 0.05)); // 스파이크 전 낮은 수준 (~5%)
const SPIKE_UP = __ENV.SPIKE_UP || '5s'; // 급상승 구간 (짧을수록 더 극단)
const SPIKE_HOLD = __ENV.SPIKE_HOLD || '40s'; // 고점 유지

export const options = {
  // 총 ~1분 30초 (ramp와 비교하기 쉽게 맞춤)
  stages: [
    { duration: '15s', target: BASE_VUS }, // 낮게 유지
    { duration: SPIKE_UP, target: TARGET_VUS }, // ★ 급상승 (스파이크)
    { duration: SPIKE_HOLD, target: TARGET_VUS }, // 고점 유지
    { duration: '10s', target: BASE_VUS }, // 급하락
    { duration: '20s', target: 0 },
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
