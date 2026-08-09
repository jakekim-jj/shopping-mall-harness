# 프론트엔드 화면 명세 — 상품 목록(홈)

> 작성: frontend-agent / 2026-08-05
> 입력: `_workspace/01_planner_prd.md`, `_workspace/02_backend_api-spec.md`
> 이 문서는 qa-agent가 화면을 검증할 때의 기준이다. 화면이 호출하는 API와 기대 shape을 그대로 적었다.

---

## 1. 구현한 화면 목록

| 화면 | 경로 | 호출 API | 상태 |
|---|---|---|---|
| 상품 목록(홈) | `/` | `GET /api/products` | ✅ 구현 완료 |

**이번 사이클의 화면은 이 1개가 전부다** (PRD D3). 상세/장바구니/결제 화면은 만들지 않았고, 해당 API를 호출하는 코드도 없다.

---

## 2. 화면 — 상품 목록(홈)

### 화면명 — 호출 API — 기대 응답 shape

```
상품 목록(홈)  —  GET /api/products  —  200 { "items": [ { id, name, price, imageUrl, description } ] }

정상   200  { "items": [ …8개… ] }        → 카드 그리드 렌더
빈 목록 200  { "items": [] }                → empty-state (에러 아님)
에러   5xx  { "error": { "message": … } }  → error-state
네트워크 실패(fetch reject)                 → error-state
```

- 호출은 `fetch('/api/products')` 한 번. 같은 오리진이라 절대 URL·CORS 설정 없음.
- 쿼리 파라미터를 붙이지 않는다 (`?simulate=…`는 QA 전용 훅이므로 프로덕션 코드에 없음 — API 스펙 §4 지시 준수).
- **성공/실패 판정은 `res.ok`(상태 코드)로만 한다.** body 내용으로 성공을 판정하지 않는다.
- `error.message`는 `body.error.message`로 한 겹 안에서 읽는다. 화면에는 PRD 2.3 문구("상품을 불러오지 못했습니다")를 쓰고, 서버 메시지는 콘솔에 남긴다.

### API shape ↔ 화면 모델 매핑 지점 (shape이 바뀌면 여기만 고친다)

`public/app.js` 상단의 3개 함수가 유일한 매핑 지점이다. 응답 객체를 화면에 그대로 흘려보내지 않는다.

| 함수 | 역할 |
|---|---|
| `mapProductListResponse(body)` | `{ items: [...] }` 래핑을 벗기는 **유일한** 지점. `Array.isArray(body.items)`가 아니면 계약 위반으로 보고 에러 상태로 넘긴다 |
| `mapProduct(item)` | item 5개 필드 → 카드 모델(`{ id, name, priceText, imageUrl, description }`). 여기서 `price`(정수) → `priceText`("19,000원")로 변환 |
| `readErrorMessage(body)` | `{ error: { message } }` 중첩을 벗기는 **유일한** 지점 |

가격 포맷: `Math.round(price).toLocaleString('ko-KR') + '원'` → `19000` → `19,000원` (소수점 없음, PRD 1.3).

### 화면 구성

- 마스트헤드: 스토어 워드마크 + 우측에 로드 상태/상품 수(`판매 중 8점`) 표시
- 상품 그리드: `grid-template-columns: repeat(auto-fill, minmax(210px, 1fr))` — 375px 폭에서 1열로 접힘 (PRD 1.5)
- 카드: 고정 비율(4:5) 이미지 패널 + 상품명 + 한 줄 설명 + 점선 리더 + 가격
  - 설명(`description`)은 표시하기로 결정 (PRD 1.2에서 프론트 재량)
  - 이미지 패널은 `aspect-ratio`로 높이가 고정되어 있어 **이미지 로드 실패 시에도 레이아웃이 밀리지 않는다.** `img`의 `error` 이벤트에서 패널에 `is-broken`을 붙여 "이미지 준비 중" 대체 영역을 노출하고, `img` 요소 자체는 DOM에 남긴다(`data-testid="product-image"` 유지) — PRD 1.4
- **클릭 가능한 요소가 화면에 하나도 없다** — `<a href>`, `<button>`, `onclick` 없음. 카드를 클릭해도 아무 일도 일어나지 않는다 (PRD 1.6). 링크는 `<link rel=stylesheet>` 하나뿐.

  > 🔁 **[2차 사이클 개정 — 2026-08-08] 이 줄은 폐기되었다.** PRD 1.6 해제에 따라 카드는 `/product.html?id={id}`로 가는 실제 `<a href>` 링크가 되었고, 헤더에 장바구니 링크가 추가되었다. **`<button>`이 0개인 것은 그대로 유지된다.** 상세는 아래 8.1절 참고. 이 절(1~6)의 나머지 내용은 전부 그대로 유효하다.

### 상태 처리 (PRD 2.1~2.4)

`showOnly(name)` 한 함수가 4개 컨테이너의 `hidden`을 동시에 설정한다. 구조적으로 2개가 동시에 보일 수 없다.

| 상태 | 조건 | 화면 |
|---|---|---|
| 로딩 | 초기 렌더 ~ 응답 도착 전 | 스켈레톤 카드 8개 (`loading-state`). 스켈레톤에는 `data-testid="product-card"`를 붙이지 않았다 → 로딩 중 카드 수는 0 |
| 목록 | `items.length > 0` | `product-list` 그리드 |
| 빈 상태 | `items.length === 0` | "판매 중인 상품이 없습니다" (`empty-state`), 카드 0개 |
| 에러 | `!res.ok` 또는 fetch reject 또는 shape 위반 | "상품을 불러오지 못했습니다" (`error-state`), 이전 카드는 비움 |

`[hidden] { display: none !important; }`를 CSS에 명시해 속성/스타일 어느 쪽으로 봐도 숨김이 일관된다.

### data-testid (PRD 4.1~4.4)

| 요소 | 선택자 | 위치 |
|---|---|---|
| 목록 컨테이너 | `data-testid="product-list"` | `<ul>` (index.html) |
| 상품 카드 | `data-testid="product-card"` + `data-product-id="{id}"` | `<li>` (app.js) |
| 상품명 | `data-testid="product-name"` | `<h2>` |
| 가격 | `data-testid="product-price"` | `<span>` — 텍스트는 `19,000원` 형식 |
| 이미지 | `data-testid="product-image"` | `<img>` — 로드 실패 시에도 DOM에 남음 |
| 로딩 | `data-testid="loading-state"` | index.html |
| 빈 상태 | `data-testid="empty-state"` | index.html |
| 에러 | `data-testid="error-state"` | index.html |

`data-product-id`에는 API의 `id` 문자열(`"p1"`)을 변환 없이 그대로 넣는다.

---

## 3. 파일

| 파일 | 역할 |
|---|---|
| `public/index.html` | 화면 뼈대 + 4개 상태 컨테이너 + testid |
| `public/styles.css` | 팔레트/타이포 토큰, 그리드, 카드, 스켈레톤, 빈/에러 상태 |
| `public/app.js` | fetch 1회, 매핑 3함수, 상태 전환, 카드 렌더 |

백엔드 파일(`server.js`, `data/products.js`, `public/images/*`)은 **건드리지 않았다.**

---

## 4. 검증 기록

### 4.1 정적 서빙

| 검증 | 명령 | 결과 |
|---|---|---|
| 홈 진입 (이전엔 404) | `curl -o /dev/null -w "%{http_code}" localhost:3000/` | `200 text/html` ✅ |
| CSS | `… localhost:3000/styles.css` | `200 text/css` ✅ |
| JS | `… localhost:3000/app.js` | `200 application/javascript` ✅ |

### 4.2 3개 상태 실제 렌더 검증 (브라우저 없이)

브라우저 도구가 없어, **최소 DOM 스텁 위에서 `public/app.js`를 실제로 실행하고 `fetch`는 구동 중인 실서버로 보내** 만들어지는 DOM을 그대로 찍어봤다 (고정 fixture가 아니라 실제 응답 사용).

| 요청 | 보이는 상태 요소 | 카드 수 | 비고 |
|---|---|---|---|
| `GET /api/products` | `product-list` **1개만** | 8 | 가격 `19,000원 / 59,000원 / 78,000원 / 32,000원 / 45,000원 / 24,000원 / 89,000원 / 28,000원`, `data-product-id` = `p1…p8` |
| `GET /api/products?simulate=empty` | `empty-state` **1개만** | 0 | 200을 에러로 오인하지 않음 |
| `GET /api/products?simulate=error` | `error-state` **1개만** | 0 | 500 + 중첩 `error.message` 파싱 확인 |

같이 확인한 것:
- 매 케이스에서 노출 상태 요소가 정확히 1개 → PRD 2.4 상호 배타성이 코드 구조상 보장됨
- 카드 DOM에 8개 testid가 모두 기대 위치에 존재
- `img`의 `error` 핸들러를 강제 호출 → 패널에 `is-broken`이 붙고 `img`는 DOM에 남음 (PRD 1.4 경로 동작)
- 정적 검사: `index.html`/`app.js`/`styles.css` 어디에도 `<a href>`(스타일시트 제외)·`<button>`·`onclick`·cart/checkout 문자열 없음 → PRD 1.6, 3.6 준수

### 4.3 아직 확인 못 한 것 (⚠️ 남은 작업)

아래는 **코드로는 확인할 수 없고 실제 브라우저 스크린샷이 필요하다.** 이 화면을 "완료"로 보기 전에 qa-agent의 시각 확인이 있어야 한다.

- 실제 픽셀 렌더 — 카드 그리드 정렬, 여백/타이포 균형, 점선 리더 위치
- 375px 모바일 폭에서 카드가 잘리거나 겹치지 않는지 (PRD 1.5) — CSS상 1열로 접히도록 짰으나 눈으로 확인 필요
- SVG 이미지가 패널 안에서 의도대로 `contain` 되는지
- 로딩 스켈레톤의 체감 (로컬 응답이 빨라 순간적으로 지나감 — 네트워크 스로틀 상태로 확인 권장)

---

## 5. product-planner에게 — 확인 필요한 프론트 재량 결정 1건

PRD에 **스토어 이름이 없어서** 마스트헤드에 임시로 `HARU STORE / 하루상점 · 매일 쓰는 것들`을 넣었다. 화면 상단에 아무 이름도 없으면 랜딩 페이지로 성립하지 않아 넣은 것이며, **기능·API·testid와 무관한 표시 문구**다. 다른 이름을 원하면 `public/index.html`의 `.mark` 블록 한 곳만 고치면 된다.

같이 정한 재량 사항: `description`은 카드에 표시(PRD 1.2가 프론트 재량으로 남겨둔 항목).

---

## 6. backend-agent에게 — 계약 불일치 없음

API 스펙 문서(`02_backend_api-spec.md`)의 shape과 실제 응답이 일치했고, 프론트는 문서대로 구현했다. **shape 불일치로 회신할 사항 없음.** 추측으로 채운 필드도 없다(문서에 명시된 5개 필드만 사용).

---

---
---

# 2차 사이클 — 상품 상세 / 장바구니 (2026-08-08)

> 작성: frontend-agent / 2026-08-08
> 입력: `_workspace/01_planner_prd.md` 5~10장, `_workspace/02_backend_api-spec.md` §2A~§2G
> **1~4장(위 문서)은 재구현하지 않았다.** 목록 화면은 아래 7절의 "1차 개정분" 한 가지만 바뀌었고, 나머지는 그대로다.

## 7. 이번 사이클에 만든 것

| 화면 | 경로 | 호출 API | 상태 |
|---|---|---|---|
| 상품 목록(홈) | `/` | `GET /api/products` + `GET /api/cart`(배지용) | 🔁 **부분 개정** (카드 링크 + 헤더 배지) |
| **상품 상세** | `/product.html?id={id}` | `GET /api/products/:id`, `POST /api/cart/items` | ✅ **신규** |
| **장바구니** | `/cart.html` | `GET /api/cart`, `PATCH /api/cart/items/:productId`, `DELETE /api/cart/items/:productId` | ✅ **신규** |

스택은 1차 그대로다 — 정적 다중 페이지(HTML/CSS/바닐라 JS), 프레임워크·번들러·SPA 라우터 없음. `public/`에 파일을 두는 것만으로 `express.static`이 서빙하므로 **`server.js`를 한 줄도 건드리지 않았다** (PRD D9).

### 파일

| 파일 | 역할 | 신규/수정 |
|---|---|---|
| `public/cart-badge.js` | **세 화면 공용.** 장바구니 4개 엔드포인트 호출기 + `{ cart: {...} }` 두 겹을 벗기는 유일한 지점 + 헤더 배지 갱신 | 신규 |
| `public/product.html` / `public/product.js` | 상품 상세 화면 | 신규 |
| `public/cart.html` / `public/cart.js` | 장바구니 화면 | 신규 |
| `public/index.html` | 헤더에 `cart-link`/`cart-count` 추가, `cart-badge.js` 로드 | 수정(추가만) |
| `public/app.js` | 카드 내용을 `<a href>`로 감쌈, 진입 시 `refreshBadge()` 호출 | 수정 |
| `public/styles.css` | 기존 규칙은 그대로 두고 **파일 하단에만 2차 블록을 덧붙임** | 수정(추가만) |

백엔드 파일(`server.js`, `data/products.js`, `public/images/*`)은 이번에도 **건드리지 않았다.**

---

## 8. 화면명 — 호출 API — 기대 응답 shape

### 8.1 상품 목록(홈) `/` — 1차 개정분

```
상품 목록(홈)  —  GET /api/products  —  200 { "items": [...] }        ← 1차와 동일, 변경 없음
              +  GET /api/cart      —  200 { "cart": { …totalQuantity } }   ← 배지용, 추가
```

- **1.6 해제 (PRD 5.1):** 카드 내용을 `<a class="card__link" href="/product.html?id={id}">`로 감쌌다. **JS `onclick`이 아니라 실제 `<a href>`**라서 새 탭 열기·뒤로가기가 브라우저 기본 동작으로 된다.
- **선택자 위치는 그대로다 (PRD 5.3):** `data-testid="product-card"`와 `data-product-id`는 여전히 `<li>`에 있고, `product-name`/`product-price`/`product-image`도 카드 안에 그대로 있다. 링크는 `<li>`와 내부 요소들 **사이에** 끼워 넣었다.
- **카드에 "장바구니 담기" 버튼은 없다 (PRD 5.2 / D7).** 목록 화면 전체에 `<button>`이 0개다 — 카드의 클릭 대상은 상세 이동 하나뿐.
- 배지용 `GET /api/cart`는 `loadProducts()`와 **완전히 분리된 경로**로 돈다. 실패하면 `cart-badge.js` 안에서 잡아 배지만 숨기고 예외를 밖으로 던지지 않는다 → 장바구니 조회 실패가 목록을 에러 상태로 만들 수 없다 (PRD 5.7).

### 8.2 상품 상세 `/product.html?id={id}`

```
상품 상세  —  GET /api/products/:id  —  200 { "item": { id, name, price, imageUrl, description } }
                                          ← 단수 "item", 한 겹. 목록의 "items"가 아니다
              404 { "error": { "message": … } }   → not-found 상태 (에러 상태가 아니다)
              5xx / 네트워크 실패                  → error 상태

담기      —  POST /api/cart/items   body { "productId": "p1", "quantity": 2 }
              200 { "cart": { items, totalQuantity, totalPrice } }   ← 두 겹
              400/404 { "error": { "message": … } }                  → 인라인 에러, 배지 미갱신
```

| 항목 | 구현 |
|---|---|
| 상태 4종 | `showOnly()` 한 함수가 `detail-loading` / `product-detail` / `detail-not-found` / `detail-error`의 `hidden`을 동시에 설정 → 구조적으로 2개가 동시에 보일 수 없다 (PRD 6.10) |
| 404 vs 5xx | `res.status === 404`면 not-found, 그 외 `!res.ok`면 error로 **명확히 갈라놨다** (PRD 6.8) |
| `?id` 없음/빈 값 | `fetch`를 **아예 호출하지 않고** 곧바로 not-found (PRD 6.9) — 검증에서 실제 요청 0건 확인 |
| 수량 | `min=1 max=99` 정수. 경계에서 버튼을 `disabled`로 만들고 핸들러에서도 한 번 더 막는 **이중 방어**. 직접 타이핑(`0`/`150`/`abc`)도 `change`·`blur`에서 클램프 |
| 담기 성공 | 성공 피드백 표시 + 배지를 응답의 `cart.totalQuantity`로 갱신. **자동 이동 없음** (PRD 6.5) |
| 담기 실패 | 인라인 에러 문구(서버 `error.message` 그대로) + **배지를 건드리지 않음** (PRD 6.7). 상세 화면 자체는 그대로 남는다(`detail-error`로 넘어가지 않음) |
| 목록 링크 | 상단 뒤로가기 링크 + not-found/error 안에도 목록 링크 (PRD 6.11 / 6.8) |
| 결제 | 관련 버튼·문구·엔드포인트 **없음** (PRD 6.12) |

### 8.3 장바구니 `/cart.html`

```
조회  —  GET    /api/cart
변경  —  PATCH  /api/cart/items/{productId}   body { "quantity": 3 }   ← 절대값. delta 아님
삭제  —  DELETE /api/cart/items/{productId}   (body 없음)

세 엔드포인트 모두 200 → { "cart": { "items": [ { productId, name, price, imageUrl, quantity, lineTotal } ],
                                     "totalQuantity": N, "totalPrice": N } }
        4xx → { "error": { "message": … } }
```

| 항목 | 구현 |
|---|---|
| 렌더 함수 | 조회·변경·삭제 응답 전부 `renderCart(cart)` **하나**로 다시 그린다 (PRD 9.7 / 스펙 §2B) |
| 합계 | `lineTotal` / `totalQuantity` / `totalPrice`는 **서버 값을 표시 포맷만 입혀 그대로 출력.** `cart.js`에는 이 값들을 만드는 산술이 **한 줄도 없다** (PRD 7.6 / 9.8) |
| 상태 4종 | `cart-loading` / `cart-list` / `cart-empty` / `cart-error` — `showOnly()` 하나가 동시에 설정 (PRD 7.9) |
| 합계 요약 | `cart-summary`는 `cart-list`일 때만 보인다. 빈 상태·에러 상태에서는 숨김 (PRD 7.7) |
| 마지막 줄 삭제 | DELETE 응답이 곧 빈 장바구니 스냅샷이므로, **추가 `GET /api/cart` 없이** 그대로 빈 상태로 전환 (PRD 7.8) |
| 줄 이미지 | 응답의 `imageUrl`을 그대로 씀. **줄마다 `GET /api/products/:id`를 호출하지 않는다** (N+1 없음) — 검증에서 상품 API 호출 0건 확인 |
| 배지 | 매 응답의 `cart.totalQuantity`로 즉시 갱신 (PRD 5.6) |
| 연타 방지 | 요청 진행 중에는 줄의 모든 버튼을 `disabled`. 응답이 오면 `renderCart()`가 목록을 다시 그리며 수량 경계에 맞춰 `disabled`를 새로 계산한다 |
| 결제 | 관련 버튼 **없음** (PRD 7.10) |

---

## 9. ⭐ 감소(−)를 1에서 눌렀을 때 — 선택한 방식

**선택: 감소 버튼을 `disabled`로 비활성화한다. DELETE로 우회 라우팅하지 않는다.**

| 후보 | 채택 여부 |
|---|---|
| **수량 1에서 감소 버튼 `disabled`** | ✅ **채택** |
| 감소-from-1 클릭을 `DELETE /api/cart/items/:productId`로 라우팅 | ❌ 탈락 |

사유:

1. **PRD 7.4가 명시적으로 "수량이 1인 줄에서 감소(−) 조작은 동작하지 않아야 한다"** 라고 적었다. 감소를 삭제로 바꿔 태우면 "동작하지 않아야 한다"를 어기는 것이고, 게다가 **7.5가 정한 "항목 제거는 삭제 버튼으로만"** 이라는 단일 경로도 깨진다.
2. 같은 결과(줄 제거)에 이르는 UI 경로가 둘이 되면, QA가 "− 를 눌렀는데 줄이 사라졌다"를 버그로 볼지 사양으로 볼지 갈린다. 백엔드가 `quantity: 0`을 400으로 막아 경로를 하나로 좁힌 결정(PRD 9.9)과 같은 이유로, 프론트에서도 경로를 하나로 유지한다.
3. 상세 화면의 수량 감소(PRD 6.3)와 **동일한 규칙**이라 사용자가 두 화면에서 다른 동작을 학습하지 않는다.

구현은 **이중 방어**다 — `quantity <= 1`이면 버튼에 `disabled`를 걸고, 클릭 핸들러 안에서도 `if (quantity <= MIN_QTY) return;`으로 한 번 더 막는다. 그 결과 **`PATCH { "quantity": 0 }`이 나가는 경로가 코드상 존재하지 않는다** (검증 C-4에서 요청 0건 확인). 증가 쪽도 대칭으로 99에서 막는다.

---

## 10. API shape ↔ 화면 모델 매핑 지점 (2차)

**두 겹(`cart.items`)과 한 겹(`items`)을 섞지 않기 위해, 벗기는 함수를 아예 다른 파일·다른 이름으로 분리했다.**

| 함수 | 파일 | 벗기는 것 |
|---|---|---|
| `mapProductListResponse(body)` | `app.js` | `{ items: [...] }` — **한 겹**. 목록 전용. 1차 그대로, 재사용하지 않음 |
| `mapDetailResponse(body)` | `product.js` | `{ item: {...} }` — **한 겹, 단수**. 상세 전용 |
| `mapCartResponse(body)` | `cart-badge.js` | `{ cart: { items: [...] } }` — **두 겹**. 장바구니 4개 엔드포인트 공용, **여기 한 곳뿐** |
| `mapCartItem(item)` | `cart-badge.js` | 줄 1개 → 화면 모델(`priceText`/`lineTotalText` 추가). `lineTotal`은 서버 값 그대로, 다시 곱하지 않음 |
| `readErrorMessage(body)` | `cart-badge.js` | `{ error: { message } }` 중첩 |

- 줄 식별자는 **`productId`** 하나다. `id`·`cartItemId`를 기대하는 코드가 없다.
- 단가 필드는 **`price`** (`unitPrice` 아님).
- 가격 포맷은 `Math.round(n).toLocaleString('ko-KR') + '원'` 한 곳(`HaruCart.formatPrice`)으로 통일 — 세 화면이 같은 함수를 쓴다.

### 쿠키

`document.cookie`를 **읽지도 쓰지도 않는다.** `credentials` 옵션도 쓰지 않는다 (같은 오리진이라 기본값으로 쿠키가 오간다 — PRD 8.6 / 스펙 §2B). `localStorage`·`sessionStorage`·전역 장바구니 변수도 **없다** — 화면은 항상 서버 응답만 그린다 (PRD 8.1 / D4). 소스 전수 grep으로 확인했다.

---

## 11. data-testid (PRD 10.1~10.13)

| 화면 | 선택자 | 위치 |
|---|---|---|
| 공통 헤더 | `cart-link` | 세 HTML의 `<a href="/cart.html">` |
| 공통 헤더 | `cart-count` | 그 안의 `<span>`. **0이면 `hidden`만 붙고 DOM에서 제거되지 않는다.** 텍스트는 숫자만 (`5`) |
| 상세 | `product-detail` (+ `data-product-id`), `detail-name`, `detail-price`, `detail-image`, `detail-description` | `product.html` |
| 상세 | `quantity-input`, `quantity-increase`, `quantity-decrease`, `add-to-cart`, `add-to-cart-success` | `product.html` |
| 상세 | `detail-loading`, `detail-not-found`, `detail-error` | `product.html` |
| 장바구니 | `cart-list`, `cart-summary`, `cart-total-quantity`, `cart-total-price` | `cart.html` |
| 장바구니 | `cart-loading`, `cart-empty`, `cart-error` | `cart.html` |
| 장바구니 줄 | `cart-item` (+ `data-product-id`), `cart-item-name`, `cart-item-price`(단가), `cart-item-quantity`, `cart-item-total`(줄 합계), `cart-item-increase`, `cart-item-decrease`, `cart-item-remove` | `cart.js`가 생성 |

PRD가 정한 이름을 **하나도 바꾸지 않았다.** 다만 아래 1개를 **추가**했다 (10장에 없는 것 → product-planner 확인 요청, 13절).

| 추가한 선택자 | 이유 |
|---|---|
| `add-to-cart-error` | PRD 6.7("담기 실패 시 에러 메시지 표시 + 배지 미갱신")을 qa-agent가 검증할 앵커가 10.6에 없었다. `detail-error`(로드 실패 상태)와는 **다른 것**이다 — 담기 실패는 상세 화면을 유지한 채 인라인으로만 표시된다 |

---

## 12. 검증 기록 (2차)

### 12.1 정적 서빙

| 검증 | 결과 |
|---|---|
| `GET /product.html?id=p1` | `200 text/html; charset=UTF-8` ✅ |
| `GET /cart.html` | `200 text/html; charset=UTF-8` ✅ |
| `GET /product.js` / `/cart.js` / `/cart-badge.js` | 전부 `200 application/javascript` ✅ |
| `GET /` / `/app.js` / `/styles.css` (1차 회귀) | 전부 `200` ✅ |
| 세 HTML의 정적 testid 전수 확인 | index 6개 / product 15개 / cart 9개 **전부 존재** ✅ |
| `cart-count` 초기 마크업 | 세 화면 모두 `<span … data-testid="cart-count" hidden>` ✅ (PRD 10.2) |

`server.js`는 수정하지 않았다 — `express.static`이 그대로 서빙했다 (PRD D9 확인).

### 12.2 상태 전환·계산 검증 — 실서버 대상 DOM 스텁 실행

브라우저 도구가 없어 1차와 같은 방식을 썼다: **최소 DOM 스텁 위에서 `public/*.js`를 있는 그대로 실행하고, `fetch`는 구동 중인 실서버(`localhost:3000`)로 내보내** 만들어지는 DOM을 그대로 검사했다. **고정 fixture를 쓰지 않았다 — 모든 수치는 실제 서버 응답에서 나온 값이다.**

쿠키만은 하네스가 항아리로 관리했다(브라우저가 자동으로 하던 일을 대신). **프로덕션 코드는 쿠키를 전혀 만지지 않는다.**

**A. 목록 화면 (16개 항목 전부 통과)**

| 검증 | 결과 |
|---|---|
| 보이는 상태 요소 정확히 1개 = `product-list`, 카드 8개 | ✅ (1차 회귀) |
| 카드가 `<a href="/product.html?id=p1">`로 감싸짐, 8개 href가 `p1`~`p8`로 매핑 | ✅ (PRD 5.1) |
| `data-testid="product-card"` / `data-product-id`가 여전히 `<li>`에, name/price/image가 카드 내부에 | ✅ (PRD 5.3) |
| 목록 화면 전체 `<button>` **0개**, 담기 버튼 없음 | ✅ (PRD 5.2) |
| `cart-link` → `/cart.html`, `cart-count`는 0일 때 DOM에 남고 `hidden` | ✅ (PRD 10.1/10.2) |
| 진입 시 `GET /api/cart` 1회 | ✅ (PRD 5.7) |
| **`GET /api/cart`를 강제 실패시켜도** 카드 8개 정상 렌더, 배지만 숨김 | ✅ (PRD 5.7) |
| `?simulate=error` → `error-state` 하나만 / `?simulate=empty` → `empty-state` 하나만 + 카드 0개 | ✅ (1차 회귀 2.2/2.3/2.4) |

**B. 상품 상세 (28개 항목 전부 통과)**

| 검증 | 결과 |
|---|---|
| `?id=p1` → `product-detail` 하나만, `data-product-id="p1"` | ✅ |
| 4개 필드 표시: `베이직 코튼 티셔츠` / `19,000원` / `/images/p1.svg` / 설명 전문 | ✅ (PRD 6.1/6.2) |
| 수량 초기값 1, 1에서 감소 버튼 `disabled`·클릭해도 1 유지 | ✅ (PRD 6.3) |
| 증가 2회 → 3, 감소 1회 → 2 | ✅ |
| 직접 `150` 입력 → `99` 클램프 + 증가 `disabled`, `0` → `1`, `abc` → `1` | ✅ |
| `?id=nope` → `detail-not-found` 하나만 + 목록 링크 | ✅ (PRD 6.8) |
| `?id` 없음 / `?id=` → `detail-not-found`, **`/api/products` 요청 0건** | ✅ (PRD 6.9) |
| 5xx → `detail-error` 하나만 (404와 구분) | ✅ (PRD 6.10) |
| 담기: `POST /api/cart/items` body `{"productId":"p1","quantity":2}` | ✅ (PRD 6.4) |
| 담기 성공 → 성공 문구 표시 + 배지 `2`, **화면은 상세에 그대로** | ✅ (PRD 6.5) |
| 같은 쿠키로 상세 재진입 → 배지가 서버 값 `2`로 채워짐 | ✅ (PRD 8.3) |
| `p1` 2개 뒤 3개 재담기 → 배지 **`5`** (줄이 2개가 되지 않고 합산) | ✅ (PRD 6.6 / D8) |
| **담기 실패:** `p2` 99개 담기(배지 99) 후 1개 추가 → 실서버 400 | ✅ |
| ↳ 에러 문구 `한 상품의 수량은 99개를 넘을 수 없습니다.` 표시, **배지 99 그대로**, 성공 문구 숨김, 상세 화면 유지 | ✅ (PRD 6.7) |

**C. 장바구니 (40개 항목 전부 통과)**

| 검증 | 결과 |
|---|---|
| 빈 장바구니 → `cart-empty` 하나만, **합계 요약 숨김**, 목록 링크 있음, 배지 hidden | ✅ (PRD 7.7) |
| 결제/주문 버튼 문구 없음 | ✅ (PRD 7.10) |
| `p1×2 + p7×1` → 줄 2개, `data-product-id` = `p1`,`p7` (담은 순서) | ✅ |
| 줄 표시: 이미지 `/images/p1.svg` / `베이직 코튼 티셔츠` / 단가 `19,000원` / 수량 `2` / 줄합계 `38,000원` | ✅ (PRD 7.1) |
| 합계 `3` / `127,000원`, 배지 `3` — 전부 서버 값 | ✅ (PRD 7.6) |
| **줄마다 `GET /api/products/:id` 호출 0건** (요청은 `GET /api/cart` 1건뿐) | ✅ |
| 증가 → `PATCH /api/cart/items/p1` body **`{"quantity":3}`** (delta `+1`이 아님) | ✅ (PRD 7.2) |
| ↳ 줄 수량 `3`, 줄합계 `57,000원`, 총 `4` / `146,000원`, 배지 `4`, **줄 순서 유지** | ✅ (PRD 7.3 / 5.6) |
| 감소 2회 → `1`, 감소 버튼 `disabled` | ✅ (PRD 7.4) |
| **1에서 감소 클릭 → 요청 0건.** 줄이 사라지지 않고 수량 1 유지, 상태도 `cart-list` 유지 | ✅ (9절 결정) |
| 전 구간에서 `"quantity":0`을 보낸 요청 **0건** | ✅ (PRD 9.9) |
| 수량 99인 줄 → 증가 버튼 `disabled`, 클릭해도 요청 0건 (100을 보내지 않음) | ✅ |
| 삭제 → `DELETE /api/cart/items/p7`, 줄 1개 남고 합계 `1` / `19,000원`, 배지 `1` | ✅ (PRD 7.5) |
| 마지막 줄 삭제 → **새로고침 없이** `cart-empty` 하나만, 요약 숨김, 배지 `0`+hidden, 줄 0개 | ✅ (PRD 7.8) |
| 조회 실패(네트워크) → `cart-error` 하나만, 요약 숨김 | ✅ (PRD 7.9) |
| **변경 실패(실서버 404):** 화면 뒤에서 줄을 지운 뒤 증가 클릭 → `cart-error` 하나만 + 서버 문구 `장바구니에 해당 상품이 없습니다.` | ✅ (PRD 7.9) |
| ↳ "다시 불러오기" 클릭 → 서버 실제 상태(빈 장바구니)로 복구 | ✅ |
| 같은 쿠키로 상세→장바구니 이동 시 `p5×4` 그대로 유지 | ✅ (PRD 8.3) |

**D. 금지 패턴 전수 grep** (`public/*.js`, `public/*.html`)

`localStorage` / `sessionStorage` / `document.cookie` / `credentials` / `/api/checkout` / `api/orders` — **실행 코드에 0건** (매칭된 2건은 "쓰지 않는다"고 적은 주석뿐). ✅ (PRD 8.1 / 8.6 / 9.12)

### 12.3 아직 확인 못 한 것 (⚠️ qa-agent의 브라우저 확인 필요)

DOM 스텁으로는 **로직·상태·데이터만** 확인된다. 아래는 실제 브라우저가 있어야 한다.

- **실제 픽셀 렌더** — 상세 2단 레이아웃, 장바구니 줄 정렬, 헤더 배지 위치/대비
- **375px 모바일 폭** — 상세는 620px 이하에서 1단, 장바구니 줄은 520px 이하에서 접히도록 CSS를 짰으나 눈으로 봐야 한다 (PRD 1.5와 같은 기준)
- **1차 목록 화면의 시각적 회귀** — 헤더에 장바구니 링크가 추가되면서 마스트헤드가 2줄로 접히는지
- **실제 쿠키 왕복** — 스텁에서는 하네스가 쿠키를 대신 관리했다. 브라우저의 `HttpOnly`/`SameSite=Lax` 쿠키가 실제로 붙는지, **다른 브라우저/시크릿 창이 서로 다른 장바구니를 갖는지**(PRD 8.5)는 브라우저 2개로 확인해야 한다
- **실제 F5 새로고침 유지** (PRD 8.3) — 스텁에서는 "페이지 재로드"를 새 스텁 인스턴스로 흉내 냈다
- 카드 링크의 **새 탭 열기·뒤로가기** 기본 동작 (`<a href>`라 구조적으로는 보장되나 실제 확인 필요)
- 담기 성공 문구는 **5초 뒤 자동으로 사라진다** — qa-agent가 이 시간 안에 확인해야 한다 (오래 남기는 편이 검증에 유리하면 `product.js`의 `SUCCESS_VISIBLE_MS` 한 곳만 고치면 된다)

---

## 13. product-planner에게 — 확인 필요한 프론트 재량 결정 2건

1. **`data-testid="add-to-cart-error"` 추가** (11절). PRD 10.6에는 성공 피드백(`add-to-cart-success`)만 있고 실패 쪽 앵커가 없어, 6.7을 검증할 수 있도록 추가했다. **PRD가 정한 이름은 하나도 바꾸지 않았고 추가만 했다.** 불필요하다면 지우면 된다.
2. **장바구니 화면의 "다시 불러오기" 버튼**. 7.9가 네 상태의 배타성을 요구하므로 조작 실패 시 목록이 숨겨지고 `cart-error`만 남는데, 그러면 사용자가 복구할 방법이 없어 재조회 버튼을 뒀다. 결제 버튼이 아니므로 7.10과 무관하다.

기존 1차 재량(스토어 이름 `HARU STORE / 하루상점`, 카드에 `description` 표시)은 그대로 유지했다.

---

## 14. backend-agent에게 — 계약 불일치 없음

`02_backend_api-spec.md` §2A~§2G에 적힌 shape·상태 코드·검증 규칙이 **실서버 응답과 전부 일치했다.** 특히 다음을 실제 호출로 확인했다:

- 장바구니 4개 엔드포인트가 전부 `{ "cart": {...} }` **두 겹** — 렌더 함수 하나로 처리됨 (§2B / PRD 9.7)
- 상세는 `{ "item": {...} }` **단수·한 겹** — 목록의 `items`와 혼동 없이 별도 매핑 함수로 분리
- `PATCH`가 **절대값** — `5 → {"quantity":3}` 요청 시 결과 `3` (8이 아님)
- `DELETE`가 **200 + body** — 응답 스냅샷만으로 빈 상태 전환 가능 (204 아님)
- `POST` 재담기 시 **수량 합산**, 99 초과는 조용히 깎지 않고 **400 + 장바구니 불변**
- `lineTotal`/`totalQuantity`/`totalPrice`가 전부 응답에 포함 — 프론트에서 재합산하지 않음

**shape 불일치로 회신할 사항 없음.** 추측으로 채운 필드도 없다.

---

# 3차 사이클 — 장바구니 비우기 / 수량 할인 표시 (2026-08-09)

> 1~14절(1·2차 명세)은 **하나도 고치지 않았다.** 아래 15절 이후가 3차 추가분이다.
> 이번 사이클에 만진 파일은 **`public/cart.html` / `public/cart.js` / `public/cart-badge.js` / `public/styles.css` 네 개뿐**이고,
> `index.html` / `app.js` / `product.html` / `product.js` / `server.js`는 **한 글자도 건드리지 않았다** (파일 타임스탬프로 확인 — 19절 S11).

## 15. 이번 사이클에 만든 것 — 그리고 **일부러 고치지 않은 것**

| # | 한 일 | 파일 |
|---|---|---|
| 1 | **장바구니 비우기 버튼**(`cart-clear`) 추가 — `DELETE /api/cart` **1회** 호출, 확인 다이얼로그 없음 | `cart.html`, `cart.js`, `cart-badge.js`(`clearCart()`), `styles.css` |
| 2 | **줄 단위 할인 표시** — 원가 취소선 + `cart-item-discounted-price` + `cart-item-discount-notice` | `cart.js`(`createLine()`), `cart-badge.js`(`mapCartItem()`), `styles.css` |

### ⚠️ 고치지 않은 것 — `cart-item-total` (이번 사이클의 최대 함정)

백엔드 스펙 최상단 🚨 배너대로 **`lineTotal`은 "필드 이름은 그대로, 뜻만 바뀐"** 케이스다(할인 전 → **할인 후 최종 금액**).
2차 코드는 이미 **서버가 준 값을 그대로 그리는 구조**(프론트 계산 0)였으므로, **줄 합계를 그리는 코드는 한 글자도 바꾸지 않았고 바꿔서도 안 된다.**

```js
// cart.js — 2차와 완전히 동일. 3차에 손대지 않았다.
total.setAttribute('data-testid', 'cart-item-total');
total.textContent = item.lineTotalText;

// cart-badge.js mapCartItem() — 참조 필드도 그대로 lineTotal
lineTotal: Number(item.lineTotal),
lineTotalText: formatPrice(item.lineTotal)
```

- 서버가 새 값을 보내기 시작한 순간 **자동으로 할인 반영 금액이 표시된다.** (19절 S4/S5에서 실측 확인)
- `lineSubtotal`(할인 전 금액)은 매핑에는 담되 **화면에 그리지 않는다** — 취소선은 **단가 자리 한 곳뿐**이다 (PRD 12.12).
- 같은 이유로 `totalPrice`를 그리는 코드도 2차 그대로다. 이 값이 곧 할인 반영 총액이 된다 (PRD 12.6 / 7.6).

## 16. 화면명 — 호출 API — 기대 응답 shape (장바구니 화면 3차 갱신분)

**장바구니 `/cart.html`** — 호출 API가 3개 → **4개**가 되었다. 네 개 모두 같은 shape이라 **렌더 함수는 여전히 `renderCart()` 하나**다 (PRD 13.5).

| 조작 | 호출 | body |
|---|---|---|
| 진입 | `GET /api/cart` | — |
| 수량 ± | `PATCH /api/cart/items/{productId}` | `{ "quantity": 변경 후 절대 수량 }` |
| 줄 삭제 | `DELETE /api/cart/items/{productId}` | — |
| **전체 비우기 (신규)** | **`DELETE /api/cart`** | — (쿼리·body 없음) |

기대 응답(4개 공통, 스펙 §2H) — `CartItem` 필드 **11개**, 할인 미적용 줄에서도 5개 필드가 항상 존재하므로 **`undefined` 방어 코드를 쓰지 않았다**:

```
200 { "cart": { "items": [ { productId, name, price, imageUrl, quantity,
                             lineSubtotal, discountApplied, discountPercent,
                             discountedUnitPrice, discountAmount, lineTotal } ],
                "totalQuantity": N, "totalPrice": N } }      ← 두 겹
5xx/네트워크 오류 → 에러 상태로 전환 (DELETE /api/cart는 4xx 경로가 없다 — 스펙 §2I)
```

**화면 모델 매핑은 `cart-badge.js`의 `mapCartItem()` / `mapCartResponse()` 한 곳뿐**이다(2차와 동일한 지점). 3차에 추가한 것은 필드 5개의 **전달과 포맷팅뿐이고, 산술은 한 줄도 없다.**

| 화면 요소 | 그리는 서버 필드 |
|---|---|
| `cart-item-price` | `price` (**언제나 원래 단가.** 할인 줄에서는 취소선 스타일만 추가) |
| `cart-item-discounted-price` | `discountedUnitPrice` |
| `cart-item-discount-notice` | 문구의 숫자는 `discountPercent` |
| `cart-item-total` | `lineTotal` (**변경 없음** — 15절) |
| `cart-total-price` / `cart-total-quantity` / 헤더 배지 | `totalPrice` / `totalQuantity` (**변경 없음**) |
| (표시 안 함) | `lineSubtotal`, `discountAmount` — 확정된 표시 사양에 자리가 없다 |

## 17. 할인 표시 판정 — `discountApplied` 하나로만 (PRD 12.11)

```js
if (item.discountApplied) {              // ← 서버가 준 boolean. 이것이 유일한 분기 조건이다
  price.classList.add('line__price--struck');
  ... cart-item-discounted-price 생성 ...
  ... cart-item-discount-notice 생성 ...
}
// else 분기는 없다: 두 요소를 만들지 않으면 그대로 "부재"다 (PRD 14.4)
```

- **프론트는 `quantity >= 10`을 다시 판정하지 않는다.** 판정이 두 벌이면 서버 경계와 조용히 어긋나고, 하필 `19,000원`에서는 **수량 9와 10의 줄 합계가 둘 다 171,000원**이라 금액으로는 눈에 띄지도 않는다 (스펙 §2H 경계값 표).
- 기준 수량 `10`은 응답에 실려오지 않으므로 문구 접두사(`DISCOUNT_NOTICE_PREFIX = '10개 이상 '`)로만 두었고, **조건 분기에는 쓰지 않는다.** 할인율은 하드코딩하지 않고 `discountPercent`를 쓴다 (PRD 12.15) → 실제 출력 `10개 이상 10% 할인 적용`.
- 줄은 스냅샷을 받을 때마다 통째로 다시 그려지므로, 할인이 꺼지면 두 요소는 **hidden이 아니라 DOM에서 사라진다.**

### 비우기 버튼의 표시 규칙 — 할인 요소와 **반대**다

| 요소 | 항목 0개일 때 | 근거 |
|---|---|---|
| `cart-clear` | **DOM에 남고 `hidden`** | PRD 11.5 / 14.1 (`cart-count`와 같은 규칙) |
| `cart-item-discounted-price` / `cart-item-discount-notice` | **DOM에서 부재** | PRD 14.4 |

`hidden` 토글은 `showOnly()` 한 곳에서 `cart-summary`와 같은 방식으로 처리한다(목록 상태일 때만 보임).
`styles.css`의 **`[hidden] { display: none !important; }` 규칙에 의존**하며, 이 규칙은 건드리지 않았다 (지우면 배지·요약·비우기 버튼이 한꺼번에 새어 나온다).

### 비우기 동작 규칙

- **`DELETE /api/cart` 한 번.** 줄 수만큼 `DELETE /api/cart/items/:productId`를 반복하지 않는다 (PRD 11.1) — 검증에서 요청 로그로 확인(19절 S8).
- **확인 다이얼로그 없음.** `confirm`/`alert`/커스텀 모달 어느 것도 만들지 않았다 (PRD D10 / 11.4). 소스 grep으로도 0건 확인(S10).
- **낙관적 갱신 없음** (PRD 11.6). 화면은 응답 스냅샷을 `renderCart()`로 다시 그릴 때만 바뀐다. 실패하면 2차부터 쓰던 에러 상태로 전환되며, **줄과 합계는 DOM에 그대로 보존된다**(상태 배타성 때문에 숨겨질 뿐 — bug-history M2가 말한 "DOM에 있는지 ≠ 보이는지"). "다시 불러오기"로 서버 실제 상태로 복구된다.
- 요청 중에는 비우기 버튼도 `disabled`(연타 방지). 목록 버튼들과 마찬가지로 `renderCart()`에서 해제된다.

## 18. data-testid (PRD 14.1~14.6)

| PRD | 선택자 | 위치 | 규칙 |
|---|---|---|---|
| 14.1 | `cart-clear` | `cart.html` 정적 마크업 (목록과 요약 사이) | 항상 DOM에 존재, 빈 장바구니면 `hidden` |
| 14.2 | `cart-item-discounted-price` | 줄 내부, `cart-item-price` 바로 아래 | **할인 줄에만 존재** |
| 14.3 | `cart-item-discount-notice` | 줄 내부, 할인가 아래 | **할인 줄에만 존재**, 텍스트 `10개 이상 10% 할인 적용` |
| 14.6 | `cart-item-name` / `cart-item-price` / `cart-item-quantity` / `cart-item-total` | 2차와 동일 | **이름·위치·의미 전부 불변** (`cart-item-price`=원가, `cart-item-total`=`lineTotal`) |

10.1~10.13의 기존 선택자도 전부 그대로 남아 있다(S1에서 전수 확인). **새로 만든 재량 선택자는 없다.**

## 19. 검증 기록 (3차) — 실서버 대상 DOM 스텁, **77개 항목 전부 통과**

2차와 같은 방식이다: **최소 DOM 스텁 위에서 `public/cart.html` + `cart-badge.js` + `cart.js`를 있는 그대로 실행하고, `fetch`는 구동 중인 실서버(`http://localhost:3000`)로 내보내** 만들어지는 DOM을 검사했다. **고정 fixture 없음 — 화면에 나온 모든 수치는 실제 서버 응답과 대조했다.** 쿠키만 하네스가 항아리로 관리했다(브라우저 대행).

**판정 원칙:** 할인 여부는 **금액이 아니라 `discountApplied` 필드와 새 선택자의 존재/부재**로 단언했다. `19,000원`은 수량 9와 10의 줄 합계가 둘 다 `171,000원`이라 금액으로 단언하면 off-by-one이 그대로 통과해버린다.

| # | 시나리오 | 결과 |
|---|---|---|
| S1 | 정적 마크업: `cart-clear` 존재 + 초기 `hidden` + `<button type="button">`, 할인 요소는 정적 HTML에 0개, 10.x 선택자 전수 존재 | ✅ 6/6 |
| S2 | 빈 장바구니: 보이는 상태 요소 = `cart-empty` 하나, `cart-clear` **DOM 존재 + hidden**, 요약 숨김, 배지 hidden, 진입 요청은 `GET /api/cart` **1건뿐** | ✅ 5/5 |
| S3 | **수량 9 (할인 미적용)**: 서버 `discountApplied:false` / 화면에 할인 요소 **0개**, 취소선 없음, 단가 `19,000원`, 줄 합계 `171,000원`(서버 `lineTotal`과 일치), `cart-clear` 보임 | ✅ 8/8 |
| S4 | **9 → 10 경계 (증가 버튼 클릭)**: `PATCH` body `{"quantity":10}`(절대값) / 서버 `discountApplied:true`, `discountedUnitPrice:17100` / 화면: 할인가 `17,100원`, 문구 `10개 이상 10% 할인 적용`, 원가 `19,000원`+취소선, **줄 합계는 9개일 때와 같은 `171,000원`** — 판정은 요소 존재로 함 | ✅ 9/9 |
| S5 | **10 → 11**: 서버 `lineTotal 188100`(할인 전 209,000 아님) — 화면 값 일치, 할인 UI 유지 | ✅ 3/3 |
| S6 | **두 줄(p1×11 할인, p7×1 정가)**: 할인 요소 개수 = **1** (할인 줄 수와 일치), p7 줄엔 부재, 총액 `277,100원` = 서버 `totalPrice` 그대로(프론트 재합산 없음), 줄 순서 유지, 요청 1건 | ✅ 7/7 |
| S7 | **11 → 10 → 9 (감소 버튼)**: 10에서는 할인 유지, 9로 내리면 서버 `discountApplied:false` + **화면에서 할인 요소 2개가 DOM에서 사라짐**(hidden 아님), 취소선 제거 | ✅ 5/5 |
| S8 | **비우기 성공**: 클릭 → 요청 **정확히 1건**이며 `DELETE /api/cart`, 줄 단위 DELETE **0건**, body 없음 / 새로고침 없이 `cart-empty` 하나만, 줄 0개, 요약 숨김, `cart-clear` **DOM 존재 + hidden**, 배지 `0`+hidden / **서버 상태도 실제로 빔** | ✅ 10/10 |
| S9 | **비우기 실패(네트워크 오류 강제)**: 에러 상태 + 문구 `장바구니를 비우지 못했습니다` / **줄 2개와 합계가 DOM에 그대로 보존**(낙관적 갱신 없음) / 서버 장바구니도 그대로(`totalQuantity 14`) / "다시 불러오기"로 복구, `cart-clear` 재표시 | ✅ 8/8 |
| S10 | **소스 금지 패턴**: `confirm`/`alert`/`prompt` 0건, `quantity >= 10` 류 재판정 0건, 할인 산술(`price *`, `* 0.9`) 0건, `lineSubtotal` 화면 출력 0건, **`cart-item-total`이 여전히 `lineTotal`을 읽음**, `localStorage`/`sessionStorage`/`document.cookie`/`credentials` 0건, `checkout`/`coupon`/`orders` 호출 0건, **`[hidden]{display:none!important}` 규칙 유지** | ✅ 8/8 |
| S11 | **1·2차 회귀**: `index.html`/`app.js`/`product.html`/`product.js` 타임스탬프 **2026-08-08 그대로**, 공용 모듈 API 9종 유지(+`clearCart`), 목록 화면 배지가 서버 `totalQuantity`(11)로 채워짐, 배지 갱신 요청 1건 | ✅ 6/6 |

정적 서빙도 재확인: `/cart.html` `/cart.js` `/cart-badge.js` `/styles.css` `/index.html` `/product.html` 전부 `200`. **`server.js`는 수정하지 않았다.**

### 19.1 아직 확인 못 한 것 (⚠️ qa-agent의 브라우저 확인 필요)

- **실제 취소선 렌더** — `line-through`는 CSS로만 붙는다. 스텁에서는 `line__price--struck` **클래스 부착**까지만 확인했다 (PRD 14.5도 "판정 근거는 스타일이 아니라 요소 존재"라고 못 박고 있다).
- **비우기 버튼의 실제 위치·대비·터치 영역**, 375px 폭에서 줄 안 할인 2줄(할인가 + 안내 문구)이 추가되며 생기는 세로 높이 변화
- **실제 쿠키 왕복** — `DELETE /api/cart`가 브라우저의 `HttpOnly` 쿠키로 자기 장바구니만 비우는지(격리)는 브라우저 2개로 확인해야 한다
- 비운 뒤 **F5 새로고침·다른 화면 경유 후 복귀**가 빈 상태인지 (PRD 11.7) — 스텁에서는 새 인스턴스 + 서버 재조회로만 확인
- **연타**(비우기 버튼 빠르게 2회) — 코드상 `busy` 플래그 + `disabled`로 막히지만 실제 입력 타이밍은 브라우저에서 확인 필요

## 20. `docs/bug-history/` 확인 결과 (작업 전 RAG)

세 문서를 모두 읽었다. **이번 작업 범위와의 관계는 아래와 같다.**

| ID | 제목 | 이번 범위 관련성 | 조치 |
|---|---|---|---|
| **BUG-2026-08-08-01 (M4)** | 장바구니 쿠키 최초 발급 경쟁 조건 | **재발 조건에 해당하지 않음 — 단, 그 조건을 새로 만들지 않도록 설계했다.** 재발 조건은 "페이지 로드 시 여러 곳에서 각자 장바구니/세션 API를 병렬 호출하는 패턴"이다 | 비우기는 **사용자 클릭 1회의 단발 요청**이고, 할인은 기존 스냅샷에 필드만 추가된 것이라 새 호출이 없다. 비우기 버튼의 표시 여부·배지 값도 **같은 응답의 `cart` 스냅샷**에서 가져와 `GET /api/cart`를 추가로 쏘지 않는다. 검증에서 **장바구니 화면 진입 시 요청이 정확히 1건**임을 단언했다(S2/S6) |
| **BUG-2026-08-08-02 (M5)** | 공용 에러 핸들러가 엉뚱한 문구를 내보냄 | **간접 관련.** 프론트는 서버 `error.message`를 그대로 화면에 노출하므로 서버 문구가 틀리면 화면도 틀린다 | backend-agent가 3차에서 경로별 분기로 이미 수정(`/api/cart*` → `장바구니 요청을 처리하지 못했습니다.`, 스펙 §5-3 구현 메모). 프론트는 기존대로 `readErrorMessage()`로 서버 문구를 표시하되, **화면 자체의 제목은 조작별로 따로 준다**(`장바구니를 비우지 못했습니다`) — 서버 문구가 다시 어긋나도 사용자가 "무슨 조작이 실패했는지"는 화면에서 알 수 있다 |
| **BUG-2026-08-NOTES (M1/M2/M3)** | 경미 기록 | **M2가 직접 관련.** "요소가 DOM에 존재하는지"와 "지금 보이는지"를 구분해 단언하라는 항목 | 이번 사이클은 정확히 이 구분이 사양이다 — `cart-clear`는 **존재+hidden**, 할인 요소 2개는 **부재**. 검증 코드도 두 가지를 각각 다른 방식으로 단언했다(S1/S2/S8 vs S3/S7). M1(서버가 상황별 문구를 보내기 시작하면 프론트도 함께 노출)도 위 M5 조치에 반영되어 있다 |

## 21. backend-agent에게 — 계약 불일치 없음

스펙 §2H(할인 필드 11개)·§2I(`DELETE /api/cart`)에 적힌 shape·상태 코드가 **실서버 응답과 전부 일치했다.** 실제 호출로 확인한 것:

- 5개 엔드포인트가 전부 같은 `{ "cart": {...} }` 두 겹 — 렌더 함수 하나로 처리됨 (PRD 13.5)
- 할인 미적용 줄에서도 **필드 5개가 항상 존재** — `undefined` 방어 코드를 한 줄도 쓰지 않았다 (PRD 13.6)
- `DELETE /api/cart` → **200 + 빈 스냅샷**(204 아님), body·쿼리 불필요
- 수량 9 → `discountApplied:false`, 수량 10 → `true`/`discountedUnitPrice:17100`, **양쪽 `lineTotal`이 둘 다 171000** — 배너가 경고한 그대로였다
- `totalPrice`가 할인 반영 합(`277,100원`)으로 내려옴 — 프론트 재합산 없이 그대로 출력

**추측으로 채운 필드 없음. 회신할 불일치 없음.**

## 22. product-planner에게 — 확인 필요한 프론트 재량 1건

**할인 안내 문구의 "10개 이상" 부분.** PRD 12.15는 "숫자를 HTML에 직접 박아넣지 말고 응답의 `discountPercent`를 쓰라"고 하는데, **기준 수량(10)은 응답에 실려오지 않는다.** 그래서 할인율은 `discountPercent`를 쓰되, 기준 수량은 `cart.js`의 문구용 상수 한 곳(`DISCOUNT_NOTICE_PREFIX`)에만 두었다. **이 상수는 조건 분기에 쓰이지 않으므로 판정이 두 벌이 되지는 않지만**, 서버의 `DISCOUNT_MIN_QUANTITY`가 바뀌면 문구만 낡을 수 있다. 둘 중 하나를 정해주면 반영하겠다.

1. 지금처럼 유지 (문구에만 존재, 판정과 무관)
2. 문구에서 기준 수량을 빼기 (`10% 할인 적용`) — 응답 값만으로 문구가 완성되어 드리프트가 원천 차단됨
3. 응답에 `discountMinQuantity`를 추가 (요구사항 추가 필요 — 이번 범위 밖이라 임의로 요청하지 않았다)

기존 재량(스토어 이름, 카드 `description` 표시, `add-to-cart-error`, "다시 불러오기" 버튼)은 그대로 유지했다.

## 변경 이력

| 날짜 | 변경 내용 | 사유 |
|---|---|---|
| 2026-08-05 | 최초 작성 — 상품 목록(홈) 화면 구현 및 3개 상태 검증 | PRD 1.x / 2.x / 4.x 구현 |
| 2026-08-08 | **2차 사이클 추가(7~14절)** — 상품 상세(`product.html`)·장바구니(`cart.html`) 화면 신규 구현, 목록 카드 링크화 + 공통 헤더 배지 추가, 공용 모듈 `cart-badge.js` 분리. 1~6절(1차 목록 화면 명세)은 그대로 두고 아래에 덧붙임 | PRD 5~10장 / API 스펙 §2A~§2G 구현 |
| 2026-08-09 | **3차 사이클 추가(15~22절)** — 장바구니 화면에 ① 전체 비우기 버튼(`cart-clear`, `DELETE /api/cart` 1회, 확인 다이얼로그 없음) ② 줄 단위 할인 표시(원가 취소선 + `cart-item-discounted-price` + `cart-item-discount-notice`, 판정은 `discountApplied` 하나) 추가. `cart-badge.js`에 `clearCart()`와 할인 필드 5개 매핑 추가. **`cart-item-total`/`cart-total-price`를 그리는 코드는 의도적으로 무변경** — `lineTotal`의 의미만 바뀌었고 참조 필드는 그대로이므로 서버 값이 바뀌는 즉시 할인 금액이 자동 반영된다. 1~14절은 그대로 두고 아래에 덧붙임 | PRD 11~14장 / API 스펙 §2H·§2I 구현. 실서버 대상 DOM 스텁 검증 77개 항목 전부 통과(19절), `docs/bug-history/` M4·M5·M2 확인 결과는 20절 |
