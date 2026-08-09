---
name: shopping-mall-frontend
description: "쇼핑몰 화면(상품 목록/상세/장바구니/결제)을 구현하는 방법을 안내. 상품 목록/상세 화면, 장바구니 화면, 결제 화면을 만들거나, 백엔드 API와 화면을 연동할 때 반드시 이 스킬을 사용할 것."
---

# 쇼핑몰 프론트엔드 스킬

이 스킬의 핵심은 **backend-agent가 문서화한 shape을 그대로 믿고 연동하되, 문서화 안 된 건 추측하지 않는 것**이다. "아마 이렇게 오겠지"로 짠 연동 코드가 경계면 버그의 절반이다.

## 최소 화면 세트 (MVP 범위)

| 화면 | 호출 API | 핵심 동작 |
|---|---|---|
| 상품 목록 | GET /api/products | 상품 카드 나열, 클릭 시 상세로 이동 |
| 상품 상세 | GET /api/products/:id | 상품 정보 + "장바구니 담기" 버튼 |
| 장바구니 | GET/POST/DELETE /api/cart | 담긴 상품 목록, 수량, 삭제, 총액 |
| 결제 | POST /api/checkout | 장바구니 내역 확인 후 결제 버튼, 성공/실패 화면 |

## API 연동 코드 작성 원칙

1. **API 응답을 화면에 그대로 뿌리지 않는다** — 응답을 받는 지점에 매핑 함수를 하나 둬서, API shape이 나중에 바뀌어도 그 함수 하나만 고치면 되게 한다.
2. **backend-agent의 공지 없이 shape을 짐작해서 연동하지 않는다** — 공지가 늦으면 화면 구조(레이아웃, 상태)까지만 먼저 만들고, 실제 fetch 연동은 공지 받은 뒤에 한다.
3. **로딩/빈 상태/에러 상태 3가지를 항상 같이 만든다** — 상품 0개일 때, API 실패했을 때 화면이 깨지지 않아야 한다.

## data-testid 컨벤션

qa-agent와 이후 테스트 작성을 위해, 상호작용 가능한 요소마다 안정적인 선택자를 남긴다:

| 요소 | 예시 |
|---|---|
| 상품 카드 | `data-testid="product-card"`, `data-product-id="{id}"` |
| 장바구니 담기 버튼 | `data-testid="add-to-cart-button"` |
| 장바구니 항목 | `data-testid="cart-item"` |
| 장바구니 항목 삭제 | `data-testid="cart-item-remove"` |
| 결제 버튼 | `data-testid="checkout-button"` |
| 빈 상태 | `data-testid="empty-state"` |

CSS 클래스명이나 텍스트가 아니라 이 속성으로 요소를 찾게 해서, 디자인이 바뀌어도 안 깨지게 한다.

## 흔한 경계면 실수 (미리 피하기)

| 실수 | 왜 문제인가 |
|---|---|
| API가 `{ items: [...] }`로 감쌌는데 프론트가 배열로 가정하고 `.map()` 바로 호출 | 런타임에 "map is not a function" 에러 |
| 성공/실패를 body 내용으로만 판단(상태 코드 무시) | backend가 상태 코드로 구분하도록 만들었다면 놓침 — backend 문서의 "상태 코드와 body 의미"를 그대로 따른다 |
| 장바구니 추가 후 화면 갱신을 위해 임의로 다시 GET 호출 (backend는 응답에 이미 최신 항목을 포함시켰는데) | 불필요한 API 호출 + backend 문서와 다른 가정으로 구현 |

## 완성 후 반드시 할 일

화면 하나를 완성하면 바로 어떤 API를 어떤 shape으로 호출하는지 정리해서 알린다 (qa-agent가 점진적으로 검증할 수 있도록). backend-agent가 알려준 shape과 다르게 구현하게 됐다면 그 즉시 SendMessage로 알린다 — 나중에 한꺼번에 발견되면 수정 범위가 커진다.
