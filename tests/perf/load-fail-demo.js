/**
 * 실패 체험용 — 서버를 죽이지 않고 HTTP 실패를 일부러 만든다.
 *
 * 쇼핑몰 서버의 QA용 쿼리 ?simulate=error → 500 을 친다.
 * (프로덕션 버그가 아니라, 실패율·threshold가 어떻게 터지는지 보는 용도)
 *
 *   npm start
 *   npm run test:perf:fail
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 20 },
    { duration: '20s', target: 40 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    // 정상이면 실패율 < 1% 인데, 이 스크립트는 일부러 거의 다 실패시킴 → 테스트 탈락
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  // 70%: 일부러 500, 30%: 정상 목록 (그래프에서 실패율 ~70%로 보이게)
  const boom = Math.random() < 0.7;
  const url = boom
    ? `${BASE_URL}/api/products?simulate=error`
    : `${BASE_URL}/api/products`;

  const res = http.get(url);
  check(res, {
    'status 200': (r) => r.status === 200,
  });
  sleep(0.2);
}
