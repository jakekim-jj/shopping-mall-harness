/**
 * 부하 시나리오 확장 — 목록 → 상세 → 담기 → 장바구니 조회
 *
 * 기존 load-ramp-read.js(목록+상세)보다 요청 4개/바퀴.
 * cartId는 응답 Set-Cookie로 VU마다 자동 분리된다.
 *
 *   k6 run -e TARGET_VUS=300 -e THINK_TIME=0.5 tests/perf/load-ramp-browse-cart.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const listDuration = new Trend('products_list_duration', true);
const detailDuration = new Trend('products_detail_duration', true);
const cartAddDuration = new Trend('cart_add_duration', true);
const cartGetDuration = new Trend('cart_get_duration', true);

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
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function pickId() {
  return PRODUCT_IDS[Math.floor(Math.random() * PRODUCT_IDS.length)];
}

function maybeSleep() {
  if (THINK_TIME > 0) sleep(THINK_TIME);
}

export default function () {
  // 1) 목록
  const list = http.get(`${BASE_URL}/api/products`);
  listDuration.add(list.timings.duration);
  check(list, { 'list 200': (r) => r.status === 200 });
  maybeSleep();

  // 2) 상세
  const id = pickId();
  const detail = http.get(`${BASE_URL}/api/products/${id}`);
  detailDuration.add(detail.timings.duration);
  check(detail, { 'detail 200': (r) => r.status === 200 });
  maybeSleep();

  // 3) 담기
  const add = http.post(
    `${BASE_URL}/api/cart/items`,
    JSON.stringify({ productId: id, quantity: 1 }),
    { headers: JSON_HEADERS }
  );
  cartAddDuration.add(add.timings.duration);
  check(add, {
    'cart add 200': (r) => r.status === 200,
    'cart has quantity': (r) => {
      try {
        return r.json('cart.totalQuantity') >= 1;
      } catch {
        return false;
      }
    },
  });
  maybeSleep();

  // 4) 장바구니 조회
  const cart = http.get(`${BASE_URL}/api/cart`);
  cartGetDuration.add(cart.timings.duration);
  check(cart, { 'cart get 200': (r) => r.status === 200 });
  maybeSleep();
}
