/**
 * 성능 스모크 (실험용) — 읽기 위주 혼합 (목록 70% / 상세 20% / 리뷰 10%)
 *
 * 짧은 stages로 "조금만 올려도 어떤지"만 본다. 정식 soak/spike는 다음 단계.
 *
 *   k6 run tests/perf/mixed-read.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 10 },
    { duration: '20s', target: 10 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<250'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const PRODUCT_IDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];

function pickId() {
  return PRODUCT_IDS[Math.floor(Math.random() * PRODUCT_IDS.length)];
}

export default function () {
  const roll = Math.random();

  if (roll < 0.7) {
    const res = http.get(`${BASE_URL}/api/products`);
    check(res, { 'list 200': (r) => r.status === 200 });
  } else if (roll < 0.9) {
    const id = pickId();
    const res = http.get(`${BASE_URL}/api/products/${id}`);
    check(res, { 'detail 200': (r) => r.status === 200 });
  } else {
    const id = pickId();
    const res = http.get(`${BASE_URL}/api/products/${id}/reviews`);
    check(res, { 'reviews 200': (r) => r.status === 200 });
  }

  sleep(0.2);
}
