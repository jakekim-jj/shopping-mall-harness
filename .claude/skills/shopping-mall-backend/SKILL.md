---
name: shopping-mall-backend
description: "쇼핑몰 백엔드 API(상품/장바구니/결제)를 구현하는 방법을 안내. 상품 목록/상세 API, 장바구니 CRUD API, 모의 결제 API를 만들거나, API 응답 shape을 문서화할 때 반드시 이 스킬을 사용할 것."
---

# 쇼핑몰 백엔드 스킬

이 스킬의 핵심은 기능 구현 자체보다 **frontend-agent가 그대로 믿고 쓸 수 있는 응답 shape 문서화**다. shape이 문서화 안 되면 frontend가 추측하게 되고, 그 추측이 틀리는 순간이 경계면 버그다.

## 최소 API 세트 (MVP 범위)

| Method | Path | 역할 |
|---|---|---|
| GET | /api/products | 상품 목록 |
| GET | /api/products/:id | 상품 상세 |
| GET | /api/cart | 장바구니 조회 |
| POST | /api/cart | 장바구니에 상품 추가 |
| DELETE | /api/cart/:itemId | 장바구니 항목 삭제 |
| POST | /api/checkout | 모의 결제 (성공/실패만 판단, 실제 PG 없음) |

범위를 넘는 API(회원, 리뷰, 주문내역 등)는 PRD의 Out of scope에 있으면 만들지 않는다.

## 응답 shape 문서화 형식

각 엔드포인트마다 이 형식으로 `_workspace/02_backend_api-spec.md`에 기록한다:

```markdown
### GET /api/products

**응답 (200)**:
\`\`\`json
{
  "items": [
    { "id": "p1", "name": "상품A", "price": 10000, "imageUrl": "..." }
  ]
}
\`\`\`

**빈 목록일 때**: `{ "items": [] }` (에러 아님, 200)
```

래핑 여부(`items`로 감쌀지 배열 그대로 줄지), 필드명, 빈 상태 응답까지 **반드시** 명시한다. 이 세 가지가 실제로 가장 자주 어긋나는 지점이다.

## 흔한 경계면 실수 (미리 피하기)

| 실수 | 왜 문제인가 |
|---|---|
| 목록 응답을 어떤 때는 배열로, 어떤 때는 `{ items: [] }`로 반환 | 프론트가 한 가지 형태만 가정하고 짜므로 나머지 경우 깨짐 |
| 필드명을 문서화 없이 나중에 바꿈 (`price` → `unitPrice`) | frontend-agent가 모르고 옛날 필드명을 계속 참조 |
| 장바구니 추가 성공 시 응답에 추가된 항목을 안 돌려줌 | 프론트가 화면 갱신을 위해 다시 GET을 해야 하는지, 응답만으로 되는지 불명확 |
| 에러 상황(재고 없음 등)을 200으로 반환하면서 body에만 표시 | 프론트가 상태 코드로 성공/실패를 판단하면 놓침 — 상태 코드와 body의 의미를 문서에 함께 명시 |

## 모의 결제 구현 원칙

- 실제 PG 연동 없이, 입력값 검증(장바구니가 비어있지 않은지 등)만 통과하면 성공으로 처리
- 성공/실패 응답 형태를 명확히 구분 (예: 성공 시 `{ orderId, status: "success" }`, 실패 시 `{ status: "failed", reason }`)
- "왜 실패했는지"를 프론트가 사용자에게 보여줄 수 있는 형태로 반환

## 완성 후 반드시 할 일

각 엔드포인트를 완성하면 바로 frontend-agent에게 SendMessage로 알린다. 전체 API를 다 만들고 한 번에 알리지 않는다 — frontend-agent가 그만큼 오래 기다리게 되고, qa-agent의 점진적 검증도 늦어진다.
