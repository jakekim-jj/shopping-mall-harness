'use strict';

/**
 * 상품 시드(seed) 데이터.
 *
 * PRD(_workspace/01_planner_prd.md) "데이터 모델" 확정값을 따른다.
 * - 필드명: camelCase, 5개 필드 전부 필수 (id, name, price, imageUrl, description)
 * - id: string
 * - price: 원(KRW) 단위 정수. 소수/문자열 금지
 * - imageUrl: 서버가 public/ 에서 정적 서빙하는 경로
 * - description: 한 줄 설명, 80자 이내
 *
 * PRD 3.5: 최소 6개 이상. 현재 8개.
 * 필드명을 바꾸면 프론트엔드가 즉시 깨지므로 임의로 변경하지 않는다.
 */
const products = [
  {
    id: 'p1',
    name: '베이직 코튼 티셔츠',
    price: 19000,
    imageUrl: '/images/p1.svg',
    description: '사계절 입기 좋은 부드러운 기본 반팔 티셔츠',
  },
  {
    id: 'p2',
    name: '워시드 데님 팬츠',
    price: 59000,
    imageUrl: '/images/p2.svg',
    description: '자연스러운 워싱과 편안한 일자 핏의 데님 팬츠',
  },
  {
    id: 'p3',
    name: '오버핏 후드 집업',
    price: 78000,
    imageUrl: '/images/p3.svg',
    description: '가볍게 걸치기 좋은 넉넉한 핏의 후드 집업',
  },
  {
    id: 'p4',
    name: '캔버스 토트백',
    price: 32000,
    imageUrl: '/images/p4.svg',
    description: '두꺼운 캔버스 원단으로 만든 데일리 토트백',
  },
  {
    id: 'p5',
    name: '레더 카드 지갑',
    price: 45000,
    imageUrl: '/images/p5.svg',
    description: '카드 6장이 들어가는 얇은 소가죽 카드 지갑',
  },
  {
    id: 'p6',
    name: '니트 비니',
    price: 24000,
    imageUrl: '/images/p6.svg',
    description: '겨울철 어디에나 어울리는 기본 니트 비니',
  },
  {
    id: 'p7',
    name: '러닝 스니커즈',
    price: 89000,
    imageUrl: '/images/p7.svg',
    description: '쿠션감이 좋아 오래 걸어도 편한 러닝 스니커즈',
  },
  {
    id: 'p8',
    name: '스테인리스 텀블러',
    price: 28000,
    imageUrl: '/images/p8.svg',
    description: '보온·보냉 6시간 유지되는 500ml 텀블러',
  },
];

module.exports = { products };
