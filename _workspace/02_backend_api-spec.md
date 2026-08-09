# 백엔드 API 스펙 — 상품 목록 / 상품 상세 / 장바구니

> 작성: backend-agent / 2026-08-05 (1차: 상품 목록)
> 개정: backend-agent / 2026-08-08 (2차: 상품 상세 + 장바구니 5개 엔드포인트 추가)
> 개정: backend-agent / 2026-08-09 (**3차: `DELETE /api/cart` 전체 비우기 + 수량 기반 자동 할인**)
> 입력: `_workspace/01_planner_prd.md`
> **이 문서는 frontend-agent가 그대로 믿고 코딩해도 되는 계약(contract)이다.**
> 여기 적힌 필드명·래핑·상태 코드는 실제 구동 중인 서버에서 curl로 검증된 값이다.
> 백엔드가 shape을 바꿔야 할 사정이 생기면, 코드를 고치기 전에 이 문서를 먼저 고치고 frontend-agent에게 알린다.

---

## 🚨 3차 사이클 — frontend-agent가 **반드시 먼저 읽어야 할 파괴적 변경** (2026-08-09)

**`lineTotal`의 의미가 2차와 달라졌다. 필드 이름은 그대로인데 값의 뜻이 바뀌었으므로, 코드를 안 고쳐도 에러가 나지 않고 조용히 틀린 금액이 표시된다.** 이것이 이번 사이클의 최대 경계면 위험이다.

| 필드 | 2차까지의 의미 | **3차부터의 의미** |
|---|---|---|
| `lineTotal` | `price × quantity` (**할인 전**) | **`discountedUnitPrice × quantity` (할인 후 최종 금액)** ← 의미 변경 |
| `lineSubtotal` | (없었음) | **신규.** `price × quantity` — 2차의 `lineTotal`이 담던 값이 이 이름으로 옮겨왔다 |
| `totalPrice` | `lineTotal`들의 합 | 규칙은 그대로지만 `lineTotal`이 할인 후 값이므로 **결과적으로 할인이 반영된 총액** |

- 할인이 **없는 줄에서는 `lineTotal == lineSubtotal`** 이므로 2차 코드가 그대로 맞는 값을 낸다. **할인 줄(수량 10 이상)에서만 값이 갈라진다** — 그래서 평소 테스트로는 안 잡힌다.
- 줄 합계(`cart-item-total`)에 그릴 값은 **계속 `lineTotal`** 이다 (PRD 10.10 / 12.12). 즉 **프론트가 `lineTotal`을 참조하던 코드는 고치지 않아도 되고, 고치면 오히려 틀린다.** 할인 전 금액(`lineSubtotal`)은 화면에 그릴 자리가 없다 (취소선은 **단가 자리 한 곳**에만 — PRD 12.12).
- 새로 늘어난 줄 필드 5개는 **할인 미적용 줄에서도 항상 존재한다** (`null`·생략 없음). `undefined` 방어 코드를 쓸 필요가 없다.

👉 상세는 **§2H(CartItem 재정의 + 할인 계산)** 와 **§2I(`DELETE /api/cart`)** 를 볼 것. §2B의 2차 JSON 예시는 **필드 6개짜리 옛 버전**이며, 실제 기준은 §2H다.

---

## 0. 서버 실행 방법 (qa-agent / frontend-agent 공통)

```bash
cd /Users/m1/projects/shopping-mall-harness
npm install     # 최초 1회
npm start       # → http://localhost:3000
```

기동 성공 시 stdout:

```
[server] listening on http://localhost:3000
[server] products API: http://localhost:3000/api/products
```

| 항목 | 값 |
|---|---|
| 런타임 | Node.js 20+ (검증 환경 v22.23.1) / Express 4 |
| 포트 | **3000 고정** (환경변수 `PORT`로 변경 가능하나 이번 사이클은 3000으로 검증) |
| 오리진 | 단일 서버 / 단일 포트. 정적 파일과 API가 같은 오리진 → **CORS 설정 불필요** |
| 정적 서빙 루트 | `public/` (프론트엔드는 `public/index.html`을 만들면 `/`로 서빙됨) |
| 이미지 | `public/images/p1.svg` … `p8.svg` (백엔드가 이미 생성해 둠, 외부 네트워크 불필요) |

> `public/index.html`은 frontend-agent가 이미 만들었고 `/`에서 서빙된다. 2차의 `product.html` / `cart.html`도 `public/`에 두기만 하면 `express.static`이 그대로 서빙한다 — **서버 라우팅을 추가할 필요가 없다** (PRD D9).

---

## 1. 엔드포인트 목록

| Method | Path | 역할 | 사이클 | 상태 |
|---|---|---|---|---|
| GET | `/api/products` | 상품 목록 조회 | 1차 | ✅ 구현 완료 (§2) |
| GET | `/api/products/:id` | 상품 1건 조회 | **2차** | ✅ 구현 완료 (§2A) |
| GET | `/api/cart` | 장바구니 조회 | **2차** | ✅ 구현 완료 (§2C) |
| POST | `/api/cart/items` | 장바구니에 담기 | **2차** | ✅ 구현 완료 (§2D) |
| PATCH | `/api/cart/items/:productId` | 줄 수량 변경 | **2차** | ✅ 구현 완료 (§2E) |
| DELETE | `/api/cart/items/:productId` | 줄 삭제 | **2차** | ✅ 구현 완료 (§2F) |
| DELETE | `/api/cart` | **장바구니 전체 비우기** | **3차** | ✅ 구현 완료 (§2I) |

~~**이번 범위의 API는 위 6개가 전부다** (PRD 9.12).~~

> 🔁 **[3차 개정 — 2026-08-09] 위 문장은 폐기된다. 이번 범위의 API는 총 7개다** (PRD 13.8). `DELETE /api/cart`(전체 비우기)가 범위로 편입되었다 (§2I).

`POST /api/checkout`(결제), 쿠폰/프로모션 코드 엔드포인트(`POST /api/cart/coupon` 등), 할인율 조회·변경 엔드포인트, 주문 관련 엔드포인트는 **3차에도 구현하지 않았다** — frontend-agent는 이 경로들을 호출하는 코드를 작성하지 말 것. 호출하면 아래처럼 404 JSON이 돌아온다.

```
POST /api/checkout  →  404
{ "error": { "message": "존재하지 않는 API 경로입니다." } }
```

> 1차 문서의 "이번 범위에는 `GET /api/products` 하나뿐"이라는 문장은 위 표로 대체되었다. **§2(GET /api/products)의 스펙 자체는 3차에도 한 글자도 바뀌지 않았다.** §2A~§2F의 경로·메서드·상태 코드·래핑도 전부 그대로이며, 3차에서 바뀐 것은 **장바구니 응답 안 `CartItem`의 필드 구성(6개 → 11개)과 `lineTotal`의 의미** 뿐이다 (§2H).

---

## 2. GET /api/products

### 요청

```
GET /api/products HTTP/1.1
Host: localhost:3000
```

- 요청 파라미터 **없음**. 헤더 불필요. 인증 없음(PRD D1).
- 프론트 호출 예: `fetch('/api/products')` — 같은 오리진이므로 절대 URL 불필요.

### 응답 (200) — 정상

`Content-Type: application/json; charset=utf-8`

```json
{
  "items": [
    {
      "id": "p1",
      "name": "베이직 코튼 티셔츠",
      "price": 19000,
      "imageUrl": "/images/p1.svg",
      "description": "사계절 입기 좋은 부드러운 기본 반팔 티셔츠"
    },
    {
      "id": "p2",
      "name": "워시드 데님 팬츠",
      "price": 59000,
      "imageUrl": "/images/p2.svg",
      "description": "자연스러운 워싱과 편안한 일자 핏의 데님 팬츠"
    },
    {
      "id": "p3",
      "name": "오버핏 후드 집업",
      "price": 78000,
      "imageUrl": "/images/p3.svg",
      "description": "가볍게 걸치기 좋은 넉넉한 핏의 후드 집업"
    },
    {
      "id": "p4",
      "name": "캔버스 토트백",
      "price": 32000,
      "imageUrl": "/images/p4.svg",
      "description": "두꺼운 캔버스 원단으로 만든 데일리 토트백"
    },
    {
      "id": "p5",
      "name": "레더 카드 지갑",
      "price": 45000,
      "imageUrl": "/images/p5.svg",
      "description": "카드 6장이 들어가는 얇은 소가죽 카드 지갑"
    },
    {
      "id": "p6",
      "name": "니트 비니",
      "price": 24000,
      "imageUrl": "/images/p6.svg",
      "description": "겨울철 어디에나 어울리는 기본 니트 비니"
    },
    {
      "id": "p7",
      "name": "러닝 스니커즈",
      "price": 89000,
      "imageUrl": "/images/p7.svg",
      "description": "쿠션감이 좋아 오래 걸어도 편한 러닝 스니커즈"
    },
    {
      "id": "p8",
      "name": "스테인리스 텀블러",
      "price": 28000,
      "imageUrl": "/images/p8.svg",
      "description": "보온·보냉 6시간 유지되는 500ml 텀블러"
    }
  ]
}
```

> 위 JSON은 **실제 서버 응답을 그대로 붙여넣은 것**이다. 시드 상품은 현재 **8개** (PRD 3.5의 최소 6개 충족).

### 응답 (200) — 상품이 0개일 때

**에러가 아니다. 404도 아니다. 200이다.** (PRD 3.2)

```json
{ "items": [] }
```

프론트는 `items.length === 0`으로 빈 상태(`data-testid="empty-state"`)를 판단한다.
`items` 키 자체가 없는 경우는 **없다** — 성공 응답에는 항상 `items`가 존재한다.

### 응답 (500) — 서버 내부 오류

`Content-Type: application/json; charset=utf-8`

```json
{ "error": { "message": "상품 목록을 불러오지 못했습니다." } }
```

- 오류를 200으로 반환하면서 body에만 표시하는 일은 **없다**. 프론트는 `response.ok` / 상태 코드로 성공·실패를 판단하면 된다 (PRD 3.4).
- 에러 응답에는 `items` 키가 **없다**. 성공 응답에는 `error` 키가 **없다**. 두 키가 동시에 오는 경우는 없다.
- `error.message`는 사용자에게 그대로 보여줘도 되는 한글 문구다. 다만 PRD 2.3의 문구("상품을 불러오지 못했습니다")를 프론트가 자체적으로 쓰는 것도 무방하다.

---

## 2A. GET /api/products/:id — 상품 상세 (2차 신규)

### 요청

```
GET /api/products/p1 HTTP/1.1
Host: localhost:3000
```

- 요청 파라미터·헤더·인증 **없음**. 프론트 호출 예: `fetch(`/api/products/${id}`)`.
- 쿠키를 발급하지 **않는다**. 이 엔드포인트는 장바구니와 무관하다.

### 응답 (200) — 정상

```json
{
  "item": {
    "id": "p1",
    "name": "베이직 코튼 티셔츠",
    "price": 19000,
    "imageUrl": "/images/p1.svg",
    "description": "사계절 입기 좋은 부드러운 기본 반팔 티셔츠"
  }
}
```

- **`item`으로 래핑된다.** 상품 객체를 top-level로 그대로 주지 않는다 (PRD 9.1). 목록의 `items`와 같은 원칙이다.
- 필드는 목록과 **완전히 동일한 5개**(`id`, `name`, `price`, `imageUrl`, `description`)이며 전부 항상 존재한다. 상세라고 해서 필드가 더 붙지 않는다.

### 응답 (404) — 존재하지 않는 id

```json
{ "error": { "message": "상품을 찾을 수 없습니다." } }
```

- **200 + 빈 객체로 내려보내지 않는다** (PRD 9.2). 프론트는 `res.status === 404`로 not-found 상태(`data-testid="detail-not-found"`)를 판단하면 된다.
- 성공 응답에 `error` 키가, 에러 응답에 `item` 키가 함께 오는 경우는 **없다**.

---

## 2B. 장바구니 공통 규약 — 4개 엔드포인트가 전부 여기에 해당한다

> 🔁 **[3차 개정 — 2026-08-09]** 이 절의 **쿠키·래핑·에러 규약은 전부 그대로 유효**하지만, 아래 두 가지가 바뀌었다.
> 1. 같은 shape을 반환하는 엔드포인트가 **4개 → 5개**가 되었다 (`DELETE /api/cart` 추가, PRD 13.5). 프론트의 렌더 함수는 여전히 **하나**다.
> 2. `CartItem`의 필드가 **6개 → 11개**로 늘고 **`lineTotal`의 의미가 바뀌었다.** **아래 "성공 응답 shape" JSON과 "CartItem 필드" 표는 2차 시점의 옛 버전이다** — 실제 구현 기준은 **§2H**다.

### 성공 응답 shape (200) — 네 엔드포인트 공통 ⚠️ *(2차 시점 — 최신본은 §2H)*

```json
{
  "cart": {
    "items": [
      { "productId": "p1", "name": "베이직 코튼 티셔츠", "price": 19000, "imageUrl": "/images/p1.svg", "quantity": 2, "lineTotal": 38000 },
      { "productId": "p7", "name": "러닝 스니커즈", "price": 89000, "imageUrl": "/images/p7.svg", "quantity": 1, "lineTotal": 89000 }
    ],
    "totalQuantity": 3,
    "totalPrice": 127000
  }
}
```

> 위 JSON은 **실제 서버 응답을 그대로 붙여넣은 것**이다 (§5의 2차 검증 기록 참고).

### 빈 장바구니 (200) — 404가 아니다

```json
{ "cart": { "items": [], "totalQuantity": 0, "totalPrice": 0 } }
```

`items`가 `null`이거나 `cart` 키가 없는 경우는 **없다.** 프론트는 `cart.items.length === 0`으로 빈 상태(`data-testid="cart-empty"`)를 판단한다.

### CartItem 필드 (줄 하나) ⚠️ *(2차 시점 — 필드 6개. 3차 최신본은 §2H의 11개 표)*

| 필드 | 타입 | 필수 | 비고 |
|---|---|---|---|
| `productId` | string | O | **이 값이 곧 줄의 식별자다** (PRD D8). `id`가 **아니다** — 상품의 `id`와 헷갈리지 않도록 이름을 다르게 뒀다. `data-product-id`에 그대로 넣으면 된다 |
| `name` | string | O | 담을 때 상품에서 복사해 넣은 값 |
| `price` | integer | O | **단가**(원 단위 정수). `unitPrice`가 **아니다** — 상품과 같은 `price`를 쓴다 |
| `imageUrl` | string | O | 담을 때 상품에서 복사해 넣은 값 |
| `quantity` | integer | O | 1 이상 99 이하 정수 |
| `lineTotal` | integer | O | ~~`price × quantity`~~ → **[3차 개정] 할인 후 최종 줄 금액 = `discountedUnitPrice × quantity`** (§2H). 할인 전 금액은 신규 필드 `lineSubtotal`이 담는다. 어느 쪽이든 **서버가 계산해서 내려준다** |

- `description`은 CartItem에 **없다** (장바구니에서 쓰지 않음).
- `name`/`price`/`imageUrl`을 일부러 중복해 담아 내려주므로, **장바구니 화면은 줄마다 `GET /api/products/:id`를 호출할 필요가 없다.**
- `items` 배열 순서는 **처음 담은 순서**를 유지한다. 수량을 바꿔도 줄 위치가 튀지 않는다.

### 금액 계산 주체 = 서버 (PRD 9.8 / 7.6)

`lineTotal`, `totalQuantity`, `totalPrice`는 **전부 서버가 계산해 응답에 담는다.** 프론트는 이 값을 **그대로 표시만** 하고 다시 합산하지 않는다. (합산 로직이 두 군데 있으면 값이 어긋났을 때 어느 쪽이 정답인지 판정할 수 없다.)

- 상단 배지의 값도 응답의 `cart.totalQuantity`를 그대로 쓴다 (PRD 5.6).
- 표시 포맷팅(`127000` → `127,000원`)만 프론트 책임이다.

### cartId 쿠키 (PRD 9.11)

장바구니 4개 엔드포인트는 요청에 `cartId` 쿠키가 없으면 **즉시 새로 발급해 `Set-Cookie`로 내려준다.**

```
Set-Cookie: cartId=0e764b61-0dbf-4e25-9d71-16564374b98e; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800
```

| 항목 | 값 |
|---|---|
| 쿠키 이름 | `cartId` |
| 값 | `crypto.randomUUID()`로 만든 임의 UUID |
| 속성 | `Path=/`, `HttpOnly`, `SameSite=Lax`, `Max-Age=604800`(7일) |
| `Secure` | **붙이지 않는다.** 붙이면 `http://localhost`에서 쿠키가 저장되지 않아 장바구니가 매 요청 초기화된다 |
| 서버 저장 | `Map<cartId, CartItem[]>` — 프로세스 메모리. DB 없음 |

- 쿠키가 **이미 있으면 다시 발급하지 않는다** (응답에 `Set-Cookie`가 붙지 않는다).
- **frontend-agent 주의:** `document.cookie`를 읽지도 쓰지도 **말 것** (PRD 8.6). `HttpOnly`라서 JS에서 읽히지도 않는다. 같은 오리진 `fetch`의 기본 쿠키 동작에 그냥 맡기면 된다 — `credentials` 옵션도 **불필요**하다.
- 서버를 재시작하면 장바구니가 비워진다. 이는 **허용된 동작이며 버그가 아니다** (PRD 8.7).

### 에러 응답 (400 / 404) — 장바구니 공통

```json
{ "error": { "message": "수량은 1 이상 99 이하의 정수여야 합니다." } }
```

| 상태 | 언제 | `error.message` |
|---|---|---|
| **400** | `quantity`가 정수가 아님(소수 / `"2"` 문자열 / `NaN`), 또는 `< 1` / `> 99` | `수량은 1 이상 99 이하의 정수여야 합니다.` |
| **400** | `productId`가 없거나 문자열이 아님 | `상품 ID(productId)가 필요합니다.` |
| **400** | 합산 결과가 99를 넘김 (POST 재담기 시) | `한 상품의 수량은 99개를 넘을 수 없습니다.` |
| **400** | 요청 body가 깨진 JSON | `요청 본문(JSON)을 해석할 수 없습니다.` |
| **404** | 담으려는 `productId`가 시드 상품에 없음 | `상품을 찾을 수 없습니다.` |
| **404** | PATCH/DELETE 대상이 **현재 장바구니에 없음** | `장바구니에 해당 상품이 없습니다.` |

> **`quantity: 0`은 "삭제"가 아니라 400이다** (PRD 9.9). 항목을 지우는 경로는 `DELETE` **하나뿐**이다. 같은 결과에 이르는 경로가 둘이면 프론트가 어느 쪽을 쓸지 갈린다.

---

## 2C. GET /api/cart — 장바구니 조회 (2차 신규)

### 요청

```
GET /api/cart HTTP/1.1
Host: localhost:3000
Cookie: cartId=...        ← 브라우저가 자동으로 붙인다. 없으면 서버가 발급
```

프론트 호출 예: `fetch('/api/cart')`

### 응답 — **항상 200**

- 장바구니가 비어 있어도 **404가 아니라 200**이다 (PRD 9.3). shape은 §2B와 동일.
- 최초 요청(쿠키 없음)이면 `Set-Cookie: cartId=...`가 함께 내려온다.

```json
{ "cart": { "items": [], "totalQuantity": 0, "totalPrice": 0 } }
```

> **PRD 5.7 관련:** 목록 화면이 배지를 채우려고 이 API를 부를 때, 이 호출이 실패해도 상품 목록 렌더링은 정상이어야 한다. 다만 **정상 동작에서 이 엔드포인트가 4xx/5xx를 내는 경우는 없다** — 조회는 언제나 200이다.

---

## 2D. POST /api/cart/items — 장바구니에 담기 (2차 신규)

### 요청

```
POST /api/cart/items HTTP/1.1
Content-Type: application/json

{ "productId": "p1", "quantity": 2 }
```

| 필드 | 타입 | 필수 | 비고 |
|---|---|---|---|
| `productId` | string | **O** | 시드 상품의 `id`. 없거나 문자열이 아니면 400 |
| `quantity` | integer | 선택 | **생략하면 1로 간주한다** (PRD 9.4). 보내면 1~99 정수여야 한다 |

```js
// 프론트 호출 예 (PRD 6.4)
await fetch('/api/cart/items', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ productId, quantity }),
});
```

> `Content-Type: application/json` 헤더를 **반드시** 붙여야 한다. 없으면 서버가 body를 파싱하지 못해 `productId` 누락 400이 난다.

### 응답 (200)

변경 후 **장바구니 전체 스냅샷** (§2B shape). 담긴 항목 하나만 돌려주지 않는다 — 프론트는 이 응답만으로 화면 전체와 배지를 다시 그릴 수 있고, **다시 `GET /api/cart`를 호출할 필요가 없다.**

### 같은 상품을 또 담을 때 — 줄이 늘지 않고 수량이 합산된다 (PRD 6.6 / D8)

`p1`을 2개 담은 뒤 다시 3개 담으면:

```json
{
  "cart": {
    "items": [
      { "productId": "p1", "name": "베이직 코튼 티셔츠", "price": 19000, "imageUrl": "/images/p1.svg", "quantity": 5, "lineTotal": 95000 }
    ],
    "totalQuantity": 5,
    "totalPrice": 95000
  }
}
```

- 줄이 **2개가 되지 않는다.** 기존 줄의 `quantity`가 `2 + 3 = 5`로 합산된다.
- **합산 결과가 99를 넘으면 조용히 99로 깎지 않고 400으로 거절한다.** (90개 담긴 상태에서 15개 추가 → 400이고, 장바구니는 **90 그대로 유지**된다. 99로 잘리지 않는다.)

### 에러

| 상태 | 상황 |
|---|---|
| 400 | `productId` 누락/비문자열, `quantity`가 정수가 아니거나 1~99 밖, 합산 시 99 초과 |
| 404 | `productId`가 시드 상품에 없음 → `{ "error": { "message": "상품을 찾을 수 없습니다." } }` |

> 검증 순서는 **body 검증(400) → 상품 조회(404)**다. 없는 상품에 잘못된 수량을 함께 보내면 **400**이 난다.
> 실패한 요청은 장바구니를 **전혀 변경하지 않는다.** 프론트는 실패 시 배지를 갱신하면 안 된다 (PRD 6.7).

---

## 2E. PATCH /api/cart/items/:productId — 줄 수량 변경 (2차 신규)

### 요청

```
PATCH /api/cart/items/p1 HTTP/1.1
Content-Type: application/json

{ "quantity": 3 }
```

- **`quantity`는 "변경 후의 절대 수량"이다. 증감분(delta)이 아니다** (PRD 7.2 / 9.5).
  수량 5인 줄에 `{ "quantity": 3 }`을 보내면 결과는 `8`이 아니라 **`3`**이다.
- URL의 `:productId`가 곧 줄 식별자다 (`/api/cart/items/p1`). 별도 `cartItemId`는 **없다**.

```js
// 프론트 호출 예 (+ 버튼: 현재 수량에 1을 더한 "결과값"을 보낸다)
await fetch(`/api/cart/items/${productId}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ quantity: nextQuantity }),   // ← delta 아님
});
```

### 응답 (200)

변경 후 장바구니 전체 스냅샷 (§2B shape). 줄의 **위치(순서)는 바뀌지 않는다.**

### 에러

| 상태 | 상황 |
|---|---|
| 400 | `quantity` 누락, 정수 아님, `< 1` 또는 `> 99`. **`quantity: 0`도 400이다 (삭제 아님)** |
| 404 | `:productId` 줄이 **현재 장바구니에 없음** → `{ "error": { "message": "장바구니에 해당 상품이 없습니다." } }` |

> 시드에 존재하는 상품이라도 **장바구니에 담겨 있지 않으면 404**다. PATCH는 "담기"를 겸하지 않는다.

---

## 2F. DELETE /api/cart/items/:productId — 줄 삭제 (2차 신규)

### 요청

```
DELETE /api/cart/items/p7 HTTP/1.1
```

- 요청 body **없음**. `Content-Type`도 불필요.
- **장바구니에서 항목을 제거하는 경로는 이 엔드포인트 하나뿐이다.**

### 응답 (200) — **204가 아니다**

변경 후 장바구니 전체 스냅샷 (§2B shape). **`204 No Content`를 반환하지 않는다** (PRD 9.6) — 프론트가 갱신된 `totalQuantity`/`totalPrice`를 받아야 하므로 body가 반드시 필요하다.

마지막 항목을 지우면 그대로 빈 장바구니 shape이 돌아오고, 프론트는 이 응답만으로 빈 상태(PRD 7.8)로 전환할 수 있다:

```json
{ "cart": { "items": [], "totalQuantity": 0, "totalPrice": 0 } }
```

### 에러

| 상태 | 상황 |
|---|---|
| 404 | `:productId` 줄이 현재 장바구니에 없음 (이미 지운 줄을 또 지우는 경우 포함) |

---

## 2G. 장바구니 계약 요약 — 여기가 2차의 경계면 버그 지점이다

| 결정 | 확정값 | 절대 하지 말 것 |
|---|---|---|
| 장바구니 래핑 | **`{ "cart": { "items": [...] } }` — 두 겹** | 상품 목록의 `{ items }`(한 겹)와 **다르다**. `data.items`로 바로 접근하면 `undefined`다. `data.cart.items`여야 한다 |
| 상세 래핑 | **`{ "item": {...} }`** | `data.id`처럼 한 겹 벗겨서 기대하지 말 것. `data.item.id`다 |
| 4개 엔드포인트 응답 | **전부 동일한 `{ cart }` shape** | 조작별로 다른 shape을 기대하지 말 것. 렌더 함수는 하나면 된다 |
| 줄 식별자 | **`productId`** | `id`도 `cartItemId`도 **없다**. 줄 객체에 `id` 키는 존재하지 않는다 |
| 단가 필드명 | **`price`** | `unitPrice` 아님. 상품과 같은 이름이다 |
| 금액 계산 | **서버가 `lineTotal`/`totalQuantity`/`totalPrice`를 다 내려줌** | 프론트에서 다시 합산하지 말 것 (7.6) |
| DELETE 응답 | **200 + body** | 204 기대하지 말 것. `res.json()`이 항상 가능하다 |
| `quantity: 0` | **400 (에러)** | "0을 보내면 삭제"로 구현하지 말 것. 삭제는 DELETE뿐 |
| PATCH의 quantity | **절대값** | delta(`+1`/`-1`)를 보내지 말 것 |
| 쿠키 | **서버가 알아서 발급/식별** | `document.cookie`를 만지지 말 것. `credentials` 옵션도 불필요 |
| 에러 | `{ "error": { "message" } }` + 4xx | `{ "message": ... }`로 한 겹 벗겨서 기대하지 말 것 |

### 프론트 참고 스니펫 (계약과 1:1로 일치하는 형태)

```js
// 4개 장바구니 엔드포인트 전부 이 한 함수로 응답을 벗긴다 (두 겹 벗기는 지점을 한 곳으로 모을 것)
async function callCart(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();          // 성공: { cart: {...} } / 실패: { error: { message } }
  if (!res.ok) {
    throw new Error(data?.error?.message ?? '장바구니 요청에 실패했습니다');
  }
  return data.cart;                        // { items, totalQuantity, totalPrice }
}

const cart = await callCart('/api/cart');
renderCart(cart);                          // 조회·담기·변경·삭제 전부 같은 렌더 함수
document.querySelector('[data-testid="cart-count"]').textContent = cart.totalQuantity;
```

> 🔁 **[3차]** 위 `callCart` 스니펫은 **그대로 쓰면 된다.** `DELETE /api/cart`도 같은 함수로 호출·파싱된다 (`callCart('/api/cart', { method: 'DELETE' })`).

---

## 2H. CartItem 재정의 — 수량 기반 자동 할인 (3차 신규, **이것이 최종 기준이다**)

**§2B의 CartItem 표(필드 6개)를 대체한다.** 장바구니를 반환하는 **5개 엔드포인트**(`GET /api/cart`, `POST /api/cart/items`, `PATCH /api/cart/items/:productId`, `DELETE /api/cart/items/:productId`, `DELETE /api/cart`)가 **전부 아래 shape을 반환한다** (PRD 13.5). 계산은 서버의 `buildCartSnapshot()` **한 곳**에서만 이뤄지므로 엔드포인트별로 값이 갈릴 수 없다.

### ⚠️ `lineTotal`의 의미 변경 (2차 → 3차) — 프론트가 놓치기 가장 쉬운 지점

```
2차:  lineTotal = price × quantity                  (할인 개념 자체가 없었음)
3차:  lineSubtotal = price × quantity                ← 2차의 lineTotal이 이 이름으로 이사
      lineTotal    = discountedUnitPrice × quantity  ← 같은 이름, 다른 뜻 (할인 후 최종)
```

**이름이 그대로라서 컴파일 에러도 `undefined`도 안 난다. 할인 줄에서만 조용히 값이 달라진다.**
다만 **줄 합계 자리에 그릴 값은 계속 `lineTotal`** 이므로(PRD 10.10 / 12.12), 2차의 프론트 코드는 **고치지 않는 것이 정답**이다. 새로 해야 할 일은 "할인 UI를 추가로 그리는 것"뿐이다.

### 응답 shape (200) — 5개 엔드포인트 공통 / 실제 서버 응답 그대로

```json
{
  "cart": {
    "items": [
      {
        "productId": "p1",
        "name": "베이직 코튼 티셔츠",
        "price": 19000,
        "imageUrl": "/images/p1.svg",
        "quantity": 10,
        "lineSubtotal": 190000,
        "discountApplied": true,
        "discountPercent": 10,
        "discountedUnitPrice": 17100,
        "discountAmount": 19000,
        "lineTotal": 171000
      },
      {
        "productId": "p7",
        "name": "러닝 스니커즈",
        "price": 89000,
        "imageUrl": "/images/p7.svg",
        "quantity": 1,
        "lineSubtotal": 89000,
        "discountApplied": false,
        "discountPercent": 0,
        "discountedUnitPrice": 89000,
        "discountAmount": 0,
        "lineTotal": 89000
      }
    ],
    "totalQuantity": 11,
    "totalPrice": 260000
  }
}
```

- `cart`의 키는 **`items` / `totalQuantity` / `totalPrice` 3개뿐**이다. **`totalDiscount`·`totalSubtotal` 같은 장바구니 단위 할인 요약 필드는 없다** (PRD 데이터 모델 / Out of scope). 프론트가 이 필드를 기대하면 `undefined`다.
- `totalPrice`는 **할인 후 `lineTotal`들의 합**이다 (위 예시: 171000 + 89000 = 260000). 할인 전 합(279000)이 **아니다.**
- `totalQuantity`는 할인과 **무관**하다 (10 + 1 = 11).

### CartItem 필드 (11개 — 하나도 생략되지 않는다)

| # | 필드 | 타입 | 사이클 | 값 | 프론트 사용처 |
|---|---|---|---|---|---|
| 1 | `productId` | string | 2차 | 줄 식별자 (PRD D8) | `data-product-id` |
| 2 | `name` | string | 2차 | 상품명 | `cart-item-name` |
| 3 | `imageUrl` | string | 2차 | 이미지 경로 | 줄 썸네일 |
| 4 | `quantity` | integer | 2차 | 1~99 | `cart-item-quantity` |
| 5 | `price` | integer | 2차 | **원래 단가. 할인이 걸려도 절대 깎이지 않는다** | `cart-item-price` — 할인 줄에서는 여기에 취소선만 붙는다 |
| 6 | `lineSubtotal` | integer | **3차** | `price × quantity` (할인 전) | **화면에 그릴 자리 없음** (취소선은 단가 자리 한 곳뿐 — PRD 12.12) |
| 7 | `discountApplied` | boolean | **3차** | `quantity >= 10` | **할인 UI를 그릴지 말지 판정하는 유일한 기준** (PRD 12.11) |
| 8 | `discountPercent` | integer | **3차** | 적용 `10` / 미적용 `0`. 퍼센트 정수(0.1 아님) | 안내 문구의 숫자 (`cart-item-discount-notice`) |
| 9 | `discountedUnitPrice` | integer | **3차** | 적용 `price - floor(price × 10 / 100)` / 미적용 `price` | `cart-item-discounted-price` |
| 10 | `discountAmount` | integer | **3차** | `lineSubtotal - lineTotal`. 미적용 `0` | 표시 여부는 frontend 재량 (전용 선택자 없음) |
| 11 | `lineTotal` | integer | 2차(**의미 변경**) | **`discountedUnitPrice × quantity` (할인 후 최종)** | `cart-item-total`, 그리고 `totalPrice` 합산의 재료 |

- **할인이 적용되지 않은 줄에서도 11개 필드가 전부 존재한다.** 생략도 `null`도 없다 (PRD 13.6) → 프론트에 `undefined` 방어 코드가 필요 없다.
- 미적용 줄의 값: `discountApplied:false`, `discountPercent:0`, `discountedUnitPrice: price`, `discountAmount:0`, `lineTotal == lineSubtotal`.
- `discountedUnitPrice`가 미적용 시 `price`와 같으므로, **"언제나 `discountedUnitPrice`를 실제 단가로 취급"하는 한 갈래 로직**으로도 금액은 항상 맞는다. 분기가 필요한 곳은 **할인 UI 표시 여부 한 곳뿐**이다.

### 계산식 (서버 전담 — 프론트는 이 중 어떤 값도 만들지 않는다)

```js
// server.js — buildCartLine() 안. 상수는 이 두 개가 유일한 출처다 (PRD 12.15)
const DISCOUNT_MIN_QUANTITY = 10;   // >= 10 (초과가 아니라 이상)
const DISCOUNT_PERCENT = 10;

discountApplied     = quantity >= DISCOUNT_MIN_QUANTITY;
discountPercent     = discountApplied ? DISCOUNT_PERCENT : 0;
lineSubtotal        = price * quantity;
discountedUnitPrice = discountApplied
                        ? price - Math.floor(price * DISCOUNT_PERCENT / 100)   // 1원 미만 버림
                        : price;
lineTotal           = discountedUnitPrice * quantity;    // 단가를 먼저 깎고 수량을 곱한다
discountAmount      = lineSubtotal - lineTotal;
```

- **단가를 먼저 깎고 수량을 곱한다** (PRD D12). 줄 합계를 먼저 만들고 깎으면 화면의 `할인 단가 × 수량`이 `줄 합계`와 어긋나는 줄이 생긴다.
- **반올림이 아니라 버림(`Math.floor`)**. 응답의 모든 금액 필드는 **정수**이며 소수가 실리는 경우는 없다.
- **줄 단위 독립 판정** (PRD 12.4 / D14). 다른 줄의 수량이나 `totalQuantity`는 아무 영향도 주지 않는다. 6개짜리 + 5개짜리(합 11개)는 **두 줄 다 할인 없음** — 실제 검증됨 (§5-3).
- **줄 전체 적용** (PRD 12.3 / D11). 10번째 초과분만 깎는 방식이 아니다. `19000 × 10`은 **171,000원**이며 188,100원이 나오면 틀린 구현이다.

### ⚠️ 경계값 9 vs 10 — 눈으로는 절대 못 잡는 구간

`price: 19000`에서 **수량 9와 수량 10의 `lineTotal`이 둘 다 171,000원으로 우연히 같다.** 총액만 보면 경계가 한 칸 밀려 있어도 정상처럼 보인다.

| quantity | discountApplied | lineSubtotal | discountedUnitPrice | discountAmount | **lineTotal** |
|---|---|---|---|---|---|
| 9 | **false** | 171000 | 19000 | 0 | **171000** |
| **10** | **true** ← 경계 | 190000 | **17100** | 19000 | **171000** ← 값은 같지만 계산 경로가 다르다 |
| 11 | true | 209000 | 17100 | 20900 | 188100 |
| 99 | true | 1881000 | 17100 | 188100 | 1692900 |

**판정은 반드시 `discountApplied` 필드로 한다.** `lineTotal` 값이나 화면 금액으로 할인 여부를 단언하면 이 구간에서 오탐/미탐이 난다 (qa-agent 주의).

### 할인 상태가 바뀌는 순간

- `PATCH`로 9 → 10이면 켜지고, 10 → 9면 꺼진다 (PRD 12.7). 둘 다 응답 스냅샷에 즉시 반영된다 — 실제 검증됨 (§5-3).
- `POST` 합산으로 10에 도달해도 동일하다 (6개 담고 4개 더 담기 → 10개 → 할인 켜짐, PRD 12.8).
- 할인이 켜지고 꺼져도 **줄의 순서(위치)는 바뀌지 않는다.**

---

## 2I. DELETE /api/cart — 장바구니 전체 비우기 (3차 신규)

### 요청

```
DELETE /api/cart HTTP/1.1
Host: localhost:3000
Cookie: cartId=...        ← 없으면 서버가 발급한다 (에러 아님)
```

- 요청 body **없음**. `Content-Type`도 불필요.
- **쿼리 파라미터도 없다.** 경로는 정확히 `/api/cart`다.

### 응답 (200) — **204가 아니다**

```json
{ "cart": { "items": [], "totalQuantity": 0, "totalPrice": 0 } }
```

- **항상 200 + body**다 (PRD 13.1). `204 No Content`를 반환하지 않는다 — 프론트가 비워진 스냅샷을 **그대로 다시 그려야** 하기 때문이다 (`DELETE /api/cart/items/:productId`와 같은 이유).
- **§2H와 완전히 동일한 `{ cart }` shape**이다. 프론트는 기존 렌더 함수를 그대로 재사용한다 (PRD 13.5).
- 배지 값도 응답의 `cart.totalQuantity`(= `0`)를 그대로 쓰면 된다 (PRD 11.3).

### 멱등성 (PRD 13.2) — **에러 케이스가 하나도 없다**

| 상황 | 응답 |
|---|---|
| 항목이 있는 장바구니 | **200** + 빈 장바구니 |
| **이미 비어 있는 장바구니** | **200** + 빈 장바구니 (404도 400도 **아니다**) |
| 3번, 10번 연속 호출 | 매번 **200** + 동일한 빈 장바구니 |
| **`cartId` 쿠키 없이 호출** | **200** + 빈 장바구니 + `Set-Cookie: cartId=...` (PRD 13.3) |

> 이 엔드포인트는 **400/404를 반환하는 경로가 존재하지 않는다.** 프론트는 실패 분기를 네트워크 오류/5xx에 대해서만 준비하면 된다 (PRD 11.6 — 실패 시 화면의 줄·합계를 비우기 전 상태 그대로 유지할 것. **낙관적 갱신 금지**).

### 서버 상태를 실제로 비운다 (PRD 11.7)

화면만 지우는 것이 아니라 서버 메모리의 해당 `cartId` 줄 배열이 비워진다. 비운 뒤 새로고침하거나 다른 화면을 거쳐 돌아와도 빈 상태다. **다른 `cartId`(다른 브라우저/시크릿 창)의 장바구니에는 영향이 없다** — 실제 검증됨 (§5-3).

### ⚠️ 라우팅 — `DELETE /api/cart/items/:productId`와 충돌하지 않는다 (PRD 13.4)

`server.js`에서 `DELETE /api/cart`를 **`DELETE /api/cart/items/:productId`보다 먼저 등록**했다. 실제 동작은 아래와 같이 검증되었다.

| 요청 | 결과 |
|---|---|
| `DELETE /api/cart` | **200** 전체 비우기 |
| `DELETE /api/cart/` (끝 슬래시) | **200** 전체 비우기 (Express 기본 non-strict 라우팅 — 같은 엔드포인트로 취급) |
| `DELETE /api/cart/items/p1` | 줄 삭제 (없으면 **404** `장바구니에 해당 상품이 없습니다.`) — **전체 비우기로 새지 않는다** |
| `DELETE /api/cart/items/` (뒤가 빈 경로) | **404** `존재하지 않는 API 경로입니다.` — 전체 비우기로 **동작하지 않는다** ✅ |
| `DELETE /api/cart/items` | **404** 동일 |

### frontend-agent 주의 (PRD 11.1)

- **`DELETE /api/cart`를 한 번** 호출한다. 줄 개수만큼 `DELETE /api/cart/items/:productId`를 반복 호출하는 방식으로 구현하지 **말 것** — 요청이 N개로 늘고, 중간에 하나가 실패하면 절반만 비워진 상태가 된다.
- 확인 다이얼로그(`window.confirm` 등)를 만들지 **말 것** (PRD D10 / 11.4). 클릭 한 번이 곧 실행이다.

---

## 3. 상품 목록 응답 계약 요약 — 여기가 1차의 경계면 버그 지점이다

| 결정 | 확정값 | 절대 하지 말 것 |
|---|---|---|
| 목록 래핑 | **`{ "items": [...] }`** | top-level 배열(`[ {...} ]`)로 파싱하지 말 것. `res.json()`의 결과는 배열이 아니라 객체다 |
| 빈 목록 | `{ "items": [] }` + **200** | 404·500으로 처리하거나 `items`를 `null`로 두지 않는다 |
| 에러 | `{ "error": { "message" } }` + **5xx** | `{ "message": ... }` 처럼 한 겹 벗겨서 기대하지 말 것. `error`는 **객체**이고 그 안에 `message`가 있다 |
| 필드 네이밍 | **camelCase** (`imageUrl`) | `image_url`, `img`, `thumbnail` 아님 |
| 가격 | `price` — **정수(number), 원(KRW)** | 문자열 아님(`"19000"` 아님), 소수 아님, `unitPrice`/`amount` 아님. `12,000원` 포맷팅은 **프론트 책임** |
| 필드 개수 | 각 item은 정확히 **5개 필드** | 5개 모두 항상 존재하며 `null`/누락 없음. 6번째 필드는 없다(재고·카테고리·할인가 없음) |

### 필드 상세

| 필드 | 타입 | 필수 | 비고 |
|---|---|---|---|
| `id` | string | O | `"p1"` ~ `"p8"`. 숫자가 아니라 **문자열**. `data-product-id="{id}"`에 그대로 넣으면 된다 |
| `name` | string | O | 상품명 (한글) |
| `price` | integer | O | 원 단위 정수. 예: `19000` → 화면 `19,000원` |
| `imageUrl` | string | O | 같은 오리진의 절대 경로(`/images/p1.svg`). `<img src>`에 그대로 넣으면 된다 |
| `description` | string | O | 80자 이내 한 줄 설명. 표시 여부는 프론트 재량 (PRD 1.2) |

### 프론트 참고 스니펫 (계약과 1:1로 일치하는 형태)

```js
const res = await fetch('/api/products');
if (!res.ok) {
  // 5xx → 에러 상태
  throw new Error('상품을 불러오지 못했습니다');
}
const data = await res.json();   // { items: [...] }  ← 배열 아님!
const items = data.items;        // 항상 배열 (0개면 빈 배열)
if (items.length === 0) {
  // 빈 상태
}
```

---

## 4. 테스트 훅 (개발/QA 전용)

프론트의 빈 상태(PRD 2.2)와 에러 상태(PRD 2.3)를 **코드 수정 없이** 확인할 수 있도록 쿼리 파라미터 훅을 두었다. **새 엔드포인트가 아니라 같은 `/api/products`이며, 쿼리를 붙이지 않으면 언제나 정상 목록을 반환한다.**

| 요청 | 결과 | 용도 |
|---|---|---|
| `GET /api/products` | 200 `{ "items": [ 8개 ] }` | 기본 동작 |
| `GET /api/products?simulate=empty` | 200 `{ "items": [] }` | 빈 상태 UI 검증 (PRD 2.2) |
| `GET /api/products?simulate=error` | 500 `{ "error": { "message": "상품 목록을 불러오지 못했습니다." } }` | 에러 상태 UI 검증 (PRD 2.3) |

> **frontend-agent에게**: 프로덕션 코드에서 이 쿼리를 붙이지 말 것. `fetch('/api/products')`만 호출하면 된다. 이 훅은 브라우저 주소창/curl로 직접 상태를 재현할 때만 쓴다.

---

## 5. 검증 기록 (실제 실행 결과)

`npm start`로 서버를 띄운 뒤 curl로 확인한 결과:

| 검증 항목 | 명령 | 결과 |
|---|---|---|
| 정상 응답 상태/타입 | `curl -s -o /dev/null -w "%{http_code} %{content_type}" localhost:3000/api/products` | `200 application/json; charset=utf-8` ✅ |
| top-level이 배열이 아님 | JSON 파싱 후 `Array.isArray(body)` | `false` ✅ |
| top-level 키 | `Object.keys(body)` | `["items"]` ✅ |
| 상품 개수 ≥ 6 | `body.items.length` | `8` ✅ (PRD 3.5) |
| 각 item 5개 필드 전부 존재, `null` 없음 | 전수 검사 | 통과 ✅ (PRD 3.3) |
| `price` 정수 여부 | `Number.isInteger` 전수 검사 | 통과 ✅ |
| `description` 80자 이내 | 길이 전수 검사 | 통과 ✅ |
| 빈 목록 | `curl "…/api/products?simulate=empty"` | `200` / `{"items":[]}` ✅ (PRD 3.2) |
| 서버 오류 | `curl "…/api/products?simulate=error"` | `500` / `{"error":{"message":"상품 목록을 불러오지 못했습니다."}}` ✅ (PRD 3.4) |
| 범위 밖 엔드포인트 | `curl localhost:3000/api/cart` | `404` / `{"error":{"message":"존재하지 않는 API 경로입니다."}}` ✅ (PRD 3.6) |
| 이미지 정적 서빙 | `curl -o /dev/null -w "%{http_code} %{content_type}" localhost:3000/images/p1.svg` | `200 image/svg+xml` ✅ |

### 5-2. 2차 검증 기록 (2026-08-08, 실제 실행 결과)

쿠키를 파일에 보존하며(`-c`로 저장 / `-b`로 전송) 연속 호출해 검증했다. **`-b`/`-c` 없이 curl을 부르면 매 요청이 새 장바구니가 되므로 반드시 쿠키 항아리를 써야 한다.**

**상품 상세 (PRD 9.1 / 9.2)**

| 검증 항목 | 명령 | 결과 |
|---|---|---|
| 정상 조회 | `curl -s localhost:3000/api/products/p1` | `200` / `{"item":{"id":"p1","name":"베이직 코튼 티셔츠","price":19000,"imageUrl":"/images/p1.svg","description":"사계절 입기 좋은 부드러운 기본 반팔 티셔츠"}}` ✅ |
| `item` 래핑 | 위 응답 top-level 키 | `["item"]` ✅ (top-level 상품 객체 아님) |
| 없는 id | `curl -s localhost:3000/api/products/nope` | `404` / `{"error":{"message":"상품을 찾을 수 없습니다."}}` ✅ |

**쿠키 발급·재사용 (PRD 8.2 / 8.5 / 9.11)**

| 검증 항목 | 명령 | 결과 |
|---|---|---|
| 최초 요청 시 발급 | `curl -s -c cookie.txt -D - -o /dev/null localhost:3000/api/cart` | `Set-Cookie: cartId=0e764b61-...; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800` ✅ (`Secure` 없음) |
| 쿠키 재사용 시 **재발급 안 함** | `curl -s -b cookie.txt -c cookie.txt -D - -o /dev/null -X POST … /api/cart/items` | 응답의 `Set-Cookie` 헤더 **0개** ✅ |
| 쿠키로 장바구니 유지 | `curl -s -b cookie.txt localhost:3000/api/cart` | 직전에 담은 `p1 x2`가 그대로 조회됨 ✅ (PRD 8.3) |
| 쿠키 없으면 다른 장바구니 | 같은 요청을 `-b` **없이** 실행 | `{"cart":{"items":[],"totalQuantity":0,"totalPrice":0}}` ✅ (PRD 8.5 브라우저별 분리) |

**장바구니 CRUD (PRD 9.3~9.8)**

| 검증 항목 | 명령 (모두 `-b jar.txt -c jar.txt` 동반) | 결과 |
|---|---|---|
| 빈 장바구니 조회 | `curl … localhost:3000/api/cart` | `200` / `{"cart":{"items":[],"totalQuantity":0,"totalPrice":0}}` ✅ (404 아님) |
| 담기 | `-H 'Content-Type: application/json' -d '{"productId":"p1","quantity":2}' … /api/cart/items` | `200` / `totalQuantity:2`, `totalPrice:38000`, `lineTotal:38000` ✅ |
| `quantity` 생략 → 1 | `-d '{"productId":"p7"}' … /api/cart/items` | `200` / `p7`의 `quantity:1` ✅ (PRD 9.4) |
| 서버 합산 정확성 | `curl … /api/cart` | `19000×2 + 89000×1` → `totalQuantity:3`, `totalPrice:127000` ✅ |
| 재담기 = 수량 합산 | `-d '{"productId":"p1","quantity":3}' … /api/cart/items` | `p1` 줄이 **1개 유지**, `quantity:5`, `lineTotal:95000` ✅ (PRD 6.6 / D8) |
| PATCH가 **절대값** | `-X PATCH -d '{"quantity":3}' … /api/cart/items/p1` | `5` → **`3`** (8이 아님) ✅ (PRD 7.2) |
| DELETE가 200 + body | `-X DELETE … /api/cart/items/p7` | `200` / 갱신된 스냅샷 반환 ✅ (204 아님, PRD 9.6) |
| 마지막 줄 삭제 | `-X DELETE … /api/cart/items/p1` | `200` / `{"cart":{"items":[],"totalQuantity":0,"totalPrice":0}}` ✅ (PRD 7.8) |
| 4개 응답 shape 동일 | 위 4종 응답의 top-level 키 전수 확인 | 전부 `["cart"]` ✅ (PRD 9.7) |

**검증 규칙 400 (PRD 9.9)** — 전부 `{"error":{"message":...}}` 동반

| 요청 | 결과 |
|---|---|
| `{"productId":"p1","quantity":0}` | `400` / `수량은 1 이상 99 이하의 정수여야 합니다.` ✅ **(삭제로 처리되지 않음)** |
| `{"productId":"p1","quantity":100}` | `400` ✅ |
| `{"productId":"p1","quantity":2.5}` (소수) | `400` ✅ |
| `{"productId":"p1","quantity":"2"}` (문자열) | `400` ✅ |
| `{"quantity":1}` (productId 누락) | `400` / `상품 ID(productId)가 필요합니다.` ✅ |
| `{"productId":123}` (비문자열) | `400` ✅ |
| `PATCH {"quantity":0}` | `400` ✅ **(삭제로 처리되지 않음)** |
| 깨진 JSON body (`{not json`) | `400` / `요청 본문(JSON)을 해석할 수 없습니다.` ✅ (500 아님) |

**없는 대상 404 (PRD 9.10)**

| 요청 | 결과 |
|---|---|
| `POST {"productId":"ZZZ"}` (시드에 없음) | `404` / `상품을 찾을 수 없습니다.` ✅ |
| `PATCH /api/cart/items/p3` (장바구니에 없음) | `404` / `장바구니에 해당 상품이 없습니다.` ✅ |
| `DELETE /api/cart/items/p3` (장바구니에 없음) | `404` / `장바구니에 해당 상품이 없습니다.` ✅ |

**99 상한 — 조용히 깎지 않고 거절 (PRD 9.9)**

| 요청 | 결과 |
|---|---|
| `p2` 90개 담기 | `200` / `quantity:90` ✅ |
| 이어서 `p2` 15개 추가 (90+15=105) | `400` / `한 상품의 수량은 99개를 넘을 수 없습니다.` ✅ |
| 직후 `GET /api/cart` | `quantity`가 **90 그대로** ✅ (99로 잘리지 않음, 실패 요청은 장바구니를 변경하지 않음) |
| 이어서 `p2` 9개 추가 (90+9=99) | `200` / `quantity:99` ✅ (경계값 통과) |

**1차 회귀 (하나도 깨지지 않았는지)**

| 검증 항목 | 결과 |
|---|---|
| `GET /api/products` | `200 application/json; charset=utf-8`, top-level 키 `["items"]`, `isArray:false`, 상품 `8`개 ✅ |
| `GET /api/products?simulate=empty` | `200` ✅ |
| `GET /api/products?simulate=error` | `500` ✅ |
| `POST /api/checkout` (범위 밖) | `404` / `{"error":{"message":"존재하지 않는 API 경로입니다."}}` ✅ (PRD 9.12) |
| ~~`DELETE /api/cart` (범위 밖, 전체 비우기)~~ | ~~`404` / 동일 ✅ — 줄 단위 삭제만 존재~~ → 🔁 **[3차] 폐기. 이제 200 + 빈 장바구니다** (§2I / §5-3) |
| `GET /images/p1.svg` | `200 image/svg+xml` ✅ |

---

### 5-3. 3차 검증 기록 (2026-08-09, 실제 실행 결과)

검증 환경: `npm start` (Node v22.23.1 / Express 4, `http://localhost:3000`), 쿠키 항아리 `jarA.txt` 유지.

#### (1) 🔴 최고 위험 — 경계값 9 vs 10 (PRD 12.2)

```bash
# 수량 9 — 할인 미적용이어야 한다
curl -s -c jarA.txt -b jarA.txt -X POST http://localhost:3000/api/cart/items \
  -H 'Content-Type: application/json' -d '{"productId":"p1","quantity":9}'
```

```json
{"cart":{"items":[{"productId":"p1","name":"베이직 코튼 티셔츠","price":19000,"imageUrl":"/images/p1.svg",
  "quantity":9,"lineSubtotal":171000,"discountApplied":false,"discountPercent":0,
  "discountedUnitPrice":19000,"discountAmount":0,"lineTotal":171000}],
  "totalQuantity":9,"totalPrice":171000}}
```

```bash
# 같은 줄을 수량 10으로 — 할인이 켜져야 한다
curl -s -c jarA.txt -b jarA.txt -X PATCH http://localhost:3000/api/cart/items/p1 \
  -H 'Content-Type: application/json' -d '{"quantity":10}'
```

```json
{"cart":{"items":[{"productId":"p1","name":"베이직 코튼 티셔츠","price":19000,"imageUrl":"/images/p1.svg",
  "quantity":10,"lineSubtotal":190000,"discountApplied":true,"discountPercent":10,
  "discountedUnitPrice":17100,"discountAmount":19000,"lineTotal":171000}],
  "totalQuantity":10,"totalPrice":171000}}
```

**`lineTotal`은 두 경우 모두 171000이지만 계산 경로가 다르다** — 9개는 `19000 × 9`(할인 없음), 10개는 `17100 × 10`(할인 적용). 구분되는 필드는 `discountApplied`(false→true)와 `discountedUnitPrice`(19000→17100)와 `lineSubtotal`(171000→190000)이다. ✅ PRD 예시와 **완전 일치**.

```bash
# 10 → 9로 되돌리면 할인이 꺼진다 (PRD 12.7)
curl -s -c jarA.txt -b jarA.txt -X PATCH http://localhost:3000/api/cart/items/p1 \
  -H 'Content-Type: application/json' -d '{"quantity":9}'
# → discountApplied:false, discountPercent:0, discountedUnitPrice:19000, discountAmount:0, lineTotal:171000 ✅
```

#### (2) 여러 줄 합계 — `totalPrice`에 할인이 반영되는가 (PRD 12.6)

```bash
curl -s -c jarA.txt -b jarA.txt -X POST http://localhost:3000/api/cart/items \
  -H 'Content-Type: application/json' -d '{"productId":"p7","quantity":1}'
```

| 줄 | quantity | discountApplied | lineSubtotal | lineTotal |
|---|---|---|---|---|
| p1 (19,000) | 10 | true | 190000 | **171000** |
| p7 (89,000) | 1 | false | 89000 | **89000** |
| **cart** | `totalQuantity: 11` | — | (할인 전 합 279000) | **`totalPrice: 260000`** ✅ |

할인 전 합(279,000)이 아니라 **할인 후 합(260,000)** 이 나온다. PRD "3차 추가분" 응답 예시와 **완전 일치**. ✅

#### (3) 줄 단위 독립 판정 (PRD 12.4 / D14)

```bash
curl -s -b jarA.txt -X PATCH http://localhost:3000/api/cart/items/p1 -H 'Content-Type: application/json' -d '{"quantity":6}'
curl -s -b jarA.txt -X PATCH http://localhost:3000/api/cart/items/p7 -H 'Content-Type: application/json' -d '{"quantity":5}'
```

→ `[('p1',6,discountApplied=False), ('p7',5,discountApplied=False)]`, `totalQuantity=11`, `totalPrice=559000`
**총 수량이 11이어도 두 줄 다 할인 없음** ✅ (총 수량 기준으로 판정하지 않는다)

#### (4) 전수 불변식 검증 — 상품 8개 × 수량 1~99 (총 792줄)

스크립트로 모든 줄에 대해 아래를 검사: 필드 11개가 **순서까지** 일치 / `lineSubtotal == price*quantity` / `lineTotal == discountedUnitPrice*quantity` / `discountAmount == lineSubtotal-lineTotal` / `discountApplied == (quantity>=10)` / 미적용 줄의 5개 값 / 금액 필드에 소수 없음 / `totalPrice == Σ lineTotal` / `totalQuantity == Σ quantity` / `cart`의 키가 `items,totalQuantity,totalPrice` 3개뿐.

```
products: 8   quantities swept: 1..99  → 총 792 줄 검사
위반 건수: 0
PRD 예시(p1 x10) 완전 일치: True
```

#### (5) `DELETE /api/cart` — 비우기 · 멱등성 · 쿠키

```bash
# 채워진 장바구니(2줄, totalQuantity=104) 비우기
curl -s -i -b jarA.txt -X DELETE http://localhost:3000/api/cart
```

```
HTTP/1.1 200 OK
{"cart":{"items":[],"totalQuantity":0,"totalPrice":0}}
```

```bash
# 이미 빈 장바구니에 재호출 (멱등, PRD 13.2) — 2회, 3회 모두 동일
curl -s -w "\nHTTP=%{http_code}\n" -b jarA.txt -X DELETE http://localhost:3000/api/cart
# → {"cart":{"items":[],"totalQuantity":0,"totalPrice":0}}  HTTP=200   ✅ (404/400 아님)

# 비운 뒤 조회 — 서버 상태가 실제로 비었는지 (PRD 11.7)
curl -s -b jarA.txt http://localhost:3000/api/cart
# → {"cart":{"items":[],"totalQuantity":0,"totalPrice":0}}  ✅

# 쿠키 없이 호출 (PRD 13.3)
curl -s -i -X DELETE http://localhost:3000/api/cart
```

```
HTTP/1.1 200 OK
Set-Cookie: cartId=ea546714-96b7-4904-b805-9df316f69b99; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800
{"cart":{"items":[],"totalQuantity":0,"totalPrice":0}}
```

#### (6) 라우팅 충돌 (PRD 13.4)

| 요청 | 결과 | 판정 |
|---|---|---|
| `DELETE /api/cart` | `200` + 빈 장바구니 | ✅ |
| `DELETE /api/cart/` | `200` + 빈 장바구니 (같은 엔드포인트) | ✅ |
| `DELETE /api/cart/items/` | `404` `존재하지 않는 API 경로입니다.` | ✅ 전체 비우기로 새지 않음 |
| `DELETE /api/cart/items` | `404` 동일 | ✅ |
| `DELETE /api/cart/items/p1` (없는 줄) | `404` `장바구니에 해당 상품이 없습니다.` | ✅ |

#### (7) 장바구니 격리 — 비우기가 남의 장바구니를 건드리지 않는가 (PRD 8.5)

세션 B(p1×3), 세션 C(p7×12)를 만든 뒤 **B만 비움** → C는 그대로: `p7 quantity=12, discountApplied=true, discountedUnitPrice=80100, lineTotal=961200, totalPrice=961200` ✅
(89000 − floor(89000×10/100)=89000−8900=80100 → ×12 = 961200)

#### (8) 2차·1차 회귀 (기존 6개 엔드포인트)

| 요청 | 결과 |
|---|---|
| `GET /api/products` | `200`, `items` 8개, 키 `[id,name,price,imageUrl,description]` ✅ |
| `GET /api/products/p1` | `200` `{"item":{...}}` ✅ |
| `GET /api/products/nope` | `404` `상품을 찾을 수 없습니다.` ✅ |
| `GET /api/products?simulate=empty` | `200` `{"items":[]}` ✅ |
| `GET /api/products?simulate=error` | `500` `상품 목록을 불러오지 못했습니다.` ✅ (문구 그대로 유지) |
| `PATCH .../p7 {"quantity":0}` | `400` `수량은 1 이상 99 이하의 정수여야 합니다.` ✅ |
| `PATCH .../p7 {"quantity":100}` | `400` 동일 ✅ |
| `POST /api/cart/items {"productId":"zzz"}` | `404` `상품을 찾을 수 없습니다.` ✅ |
| `POST /api/cart/items` (productId 누락) | `400` `상품 ID(productId)가 필요합니다.` ✅ |

**기존 엔드포인트의 경로·상태 코드·에러 문구·래핑이 하나도 바뀌지 않았음을 확인했다.**

---

## 6. 파일 위치

| 파일 | 역할 |
|---|---|
| `package.json` | `npm start` → `node server.js`, 의존성 `express@^4.19.2` (**2차에서 새 의존성 추가 없음**) |
| `server.js` | Express 앱. 정적 서빙 + `express.json()` + **API 7개**(3차: `DELETE /api/cart` 추가) + 장바구니 저장소(`Map`) + 할인 계산(`buildCartLine`/`buildCartSnapshot`) + 에러 핸들러. **3차에서도 새 파일·새 의존성 없음** |
| `data/products.js` | 시드 상품 8개 (`module.exports = { products }`) — **2차에서 변경 없음** |
| `public/images/p1.svg` … `p8.svg` | 상품 플레이스홀더 이미지 (백엔드 생성, 외부 네트워크 불필요) |
| `public/index.html` | frontend-agent가 만든 목록 화면. `/`에서 서빙 중 |
| `public/product.html`, `public/cart.html` | **frontend-agent가 만들 2차 파일.** `public/`에 두기만 하면 자동 서빙됨 (서버 수정 불필요, PRD D9) |

> 상품을 추가·수정하려면 `data/products.js`만 고치면 된다. 응답 shape은 `server.js`가 필드를 명시적으로 매핑하므로 시드에 필드를 추가해도 API 응답에는 5개 필드만 나간다.

### 2차 구현 메모 (backend-agent → qa-agent / frontend-agent)

- **장바구니 저장소는 `server.js` 안의 `Map<cartId, CartItem[]>`**이다. 별도 파일·DB·의존성(`cookie-parser` 포함)을 추가하지 않았다 — 쿠키는 `req.headers.cookie`를 직접 파싱하고, 발급은 `crypto.randomUUID()`(Node 내장)를 쓴다.
- 담을 때 상품의 `name`/`price`/`imageUrl`을 **줄에 복사(비정규화)해 저장**한다. 따라서 장바구니 응답은 상품 API를 다시 조회하지 않고 만들어진다.
- 신규 라우트는 전부 **`/api` catch-all 404 핸들러보다 위에** 등록되어 있다. 아래로 내려가면 catch-all이 먼저 잡아 전부 404가 되므로, 라우트를 추가할 때 순서를 반드시 지킬 것.
- **서버 재시작 = 모든 장바구니 초기화.** 허용된 동작이며 버그가 아니다 (PRD 8.7). qa-agent는 이를 검증 항목으로 삼지 않는다.
- qa-agent가 브라우저 없이 curl로 검증할 때는 **`-c`/`-b`로 쿠키 항아리를 유지**해야 한다. 없으면 매 요청이 새 장바구니라 "담았는데 비어 있다"로 보인다.
- ⚠️ **zsh 함정 (검증 중 실제로 겪음):** curl 옵션을 셸 변수에 담아 `curl $OPTS ...`로 쓰면 **zsh는 단어 분리를 하지 않아** 전체가 인자 **하나**로 전달된다. 그 결과 `-c`가 먹지 않아 쿠키가 저장되지 않고(→ 매 요청 새 장바구니), `-H`도 뭉개져 `Content-Type`이 안 붙어(→ body 미파싱 → `productId` 누락 400) **서버 버그처럼 보이는 가짜 실패**가 난다. 옵션은 **리터럴로 직접 쓰거나** 배열(`opts=(-b jar.txt -c jar.txt)` → `"${opts[@]}"`)로 전달할 것.

### 3차 구현 메모 (backend-agent → qa-agent / frontend-agent)

- **할인 계산은 `server.js`의 `buildCartLine()` 한 곳에서만** 이뤄지고, `buildCartSnapshot()`이 그것을 5개 엔드포인트에 공통으로 쓴다 (PRD 3차 스택 보강). 엔드포인트마다 계산이 복제되지 않으므로 "어떤 조작에서만 금액이 다르다"는 버그가 구조적으로 생길 수 없다.
- 할인 값은 **저장하지 않고 응답 시점에 계산**한다. 저장하면 수량이 바뀔 때 낡은 할인 값이 남는다. 서버 내부 저장 형태는 2차 그대로 `{ productId, name, price, imageUrl, quantity }`다.
- 상수는 `DISCOUNT_MIN_QUANTITY = 10`, `DISCOUNT_PERCENT = 10` 두 개뿐이다 (PRD 12.15). **프론트는 이 숫자를 하드코딩하지 말고 응답의 `discountPercent`를 문구에 쓸 것** (`10개 이상 10% 할인 적용`).
- `DELETE /api/cart`는 **`DELETE /api/cart/items/:productId`보다 먼저** 등록했다 (PRD 13.4). 라우트를 더 추가할 일이 생기면 이 순서와, 2차 메모의 "`/api` catch-all 404 핸들러보다 위" 규칙을 함께 지킬 것.
- 비울 때 `items.length = 0`으로 **같은 배열 참조를 유지**한다. 새 배열로 갈아끼우면 `Map`과 다른 곳이 서로 다른 참조를 들게 될 여지가 생긴다.
- 🐛 **`docs/bug-history/` BUG-2026-08-08-02(M5, 공용 에러 핸들러 문구) 반영.** 이번에 추가한 `DELETE /api/cart`가 기존 공용 500 핸들러를 그대로 물려받으면, 장바구니 요청이 실패해도 "상품 목록을 불러오지 못했습니다."가 나가는 M5의 재발 조건에 정확히 해당한다. 그래서 핸들러를 **경로별로 분기**했다.

  | 경로 | 500 `error.message` |
  |---|---|
  | `/api/products*` | `상품 목록을 불러오지 못했습니다.` (1차부터 문서화된 문구 — **그대로 유지**) |
  | `/api/cart*` | `장바구니 요청을 처리하지 못했습니다.` (신규) |
  | 그 외 `/api/*` | `요청을 처리하지 못했습니다.` (기능명 없는 중립 문구 — 다음에 API가 늘어도 안 고쳐도 된다) |

  상태 코드(500)와 응답 shape(`{ error: { message } }`)은 **바뀌지 않았다.** 다음 사이클에서 `POST /api/checkout`을 추가하는 사람은 결제용 문구 분기를 한 줄 더 넣기만 하면 된다.
- 🐛 **BUG-2026-08-08-01(M4, 쿠키 최초 발급 경쟁 조건)은 이번 범위에서 재발 조건이 아니다.** 비우기는 사용자의 명시적 클릭 1회로 발생하는 **단발 요청**이고, 할인은 기존 스냅샷 응답에 필드만 추가한 것이라 **페이지 로드 시 병렬 호출을 새로 만들지 않는다.** 다만 **M4는 여전히 미수정 상태**이므로, frontend-agent는 장바구니 화면에서 "진입과 동시에 `GET /api/cart` + 다른 상태 확인"을 **병렬로** 쏘는 구조를 새로 만들지 말 것 (기존대로 배지도 같은 응답의 `totalQuantity`를 재사용하면 호출이 늘지 않는다).

---

## 변경 이력

| 날짜 | 변경 내용 | 사유 |
|---|---|---|
| 2026-08-05 | 최초 작성 — `GET /api/products` 스펙 확정 및 실서버 curl 검증 | PRD 3.1~3.6 구현 완료 |
| 2026-08-08 | **2차 사이클 추가** — `GET /api/products/:id`(§2A), 장바구니 공통 규약·쿠키(§2B), `GET /api/cart`(§2C), `POST /api/cart/items`(§2D), `PATCH /api/cart/items/:productId`(§2E), `DELETE /api/cart/items/:productId`(§2F), 장바구니 계약 요약(§2G), 2차 검증 기록(§5-2) 추가. §1 엔드포인트 목록을 6개로 갱신 | PRD 9.1~9.13 구현 완료. **§2(`GET /api/products`)의 스펙과 구현은 변경 없음** — 1차 회귀 검증도 §5-2에 기록 |
| 2026-08-09 | **3차 사이클 추가** — ① **`CartItem` 재정의(§2H)**: 할인 필드 5개(`lineSubtotal`·`discountApplied`·`discountPercent`·`discountedUnitPrice`·`discountAmount`) 추가로 필드 6개 → **11개**, **`lineTotal`의 의미를 "할인 후 최종 금액"으로 변경**, `totalPrice`는 할인 반영 합계. ② **`DELETE /api/cart`(§2I)** 신규 — 200 + 빈 스냅샷, 멱등, 에러 케이스 없음, 라우팅 충돌 검증. ③ 문서 최상단에 **파괴적 변경 경고 배너** 추가, §1 목록을 7개로 갱신, §2B의 2차 예시·표에 "옛 버전" 표시, §5-2의 "`DELETE /api/cart`는 404" 항목 폐기 표시. ④ **3차 검증 기록(§5-3)** — 9 vs 10 경계, 전수 불변식 792줄, 멱등성, 라우팅, 격리, 1·2차 회귀. ⑤ 공용 500 핸들러 문구를 경로별로 분기 (bug-history M5 반영) | PRD 11~14장 / 13.1~13.9 구현 완료. **기존 6개 엔드포인트의 경로·메서드·상태 코드·에러 문구·래핑은 하나도 바뀌지 않았다** — 회귀 검증을 §5-3 (8)에 기록. `lineTotal` 의미 변경은 이름이 같아 조용히 틀리는 유형이라 배너·§2H·§2B 세 곳에 중복 명시 |
