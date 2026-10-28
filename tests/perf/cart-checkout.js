/**
 * 성능 스모크 (실험용) — 장바구니 담기 → 조회 → 모의 결제
 *
 * VU마다 쿠키 jar가 분리되므로 cartId가 VU 간에 섞이지 않는다.
 * 결제 수단은 MOCK_SUCCESS만 쓴다 (실패 분기 부하는 아직 안 봄).
 *
 *   k6 run tests/perf/cart-checkout.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 5,
  duration: '20s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export default function () {
  // 장바구니 발급(쿠키) + 담기
  const add = http.post(
    `${BASE_URL}/api/cart/items`,
    JSON.stringify({ productId: 'p1', quantity: 1 }),
    { headers: JSON_HEADERS }
  );
  check(add, {
    'POST /api/cart/items 200': (r) => r.status === 200,
    'cart totalQuantity >= 1': (r) => {
      try {
        return r.json('cart.totalQuantity') >= 1;
      } catch {
        return false;
      }
    },
  });

  const cart = http.get(`${BASE_URL}/api/cart`);
  check(cart, {
    'GET /api/cart 200': (r) => r.status === 200,
  });

  const checkout = http.post(
    `${BASE_URL}/api/checkout`,
    JSON.stringify({
      ordererName: 'Perf Tester',
      ordererPhone: '01012345678',
      paymentMethod: 'MOCK_SUCCESS',
    }),
    { headers: JSON_HEADERS }
  );
  check(checkout, {
    'POST /api/checkout 200': (r) => r.status === 200,
    'order.status paid-ish': (r) => {
      try {
        const order = r.json('order');
        return order && typeof order.orderId === 'string';
      } catch {
        return false;
      }
    },
  });

  sleep(0.5);
}
