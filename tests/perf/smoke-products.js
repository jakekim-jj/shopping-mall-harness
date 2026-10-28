/**
 * 성능 스모크 (실험용) — 상품 목록/상세 읽기
 *
 * 목적: k6가 서버에 붙는지, 읽기 API p95가 대략 어느지 먼저 본다.
 * 정식 임계값·하네스 연동은 아직 없다. BASE_URL 기본값 http://localhost:3000
 *
 *   k6 run tests/perf/smoke-products.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 5,
  duration: '20s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<200'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  const list = http.get(`${BASE_URL}/api/products`);
  check(list, {
    'GET /api/products status 200': (r) => r.status === 200,
    'GET /api/products has items': (r) => {
      try {
        return Array.isArray(r.json('items'));
      } catch {
        return false;
      }
    },
  });

  const detail = http.get(`${BASE_URL}/api/products/p1`);
  check(detail, {
    'GET /api/products/p1 status 200': (r) => r.status === 200,
    'GET /api/products/p1 has item.id': (r) => {
      try {
        return r.json('item.id') === 'p1';
      } catch {
        return false;
      }
    },
  });

  const reviews = http.get(`${BASE_URL}/api/products/p1/reviews`);
  check(reviews, {
    'GET reviews status 200': (r) => r.status === 200,
    'GET reviews has reviewCount': (r) => {
      try {
        return typeof r.json('reviewCount') === 'number';
      } catch {
        return false;
      }
    },
  });

  sleep(0.3);
}
