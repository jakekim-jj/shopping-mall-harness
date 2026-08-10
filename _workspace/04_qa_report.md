# QA 검증 리포트 — 상품 목록(홈) 랜딩 페이지

> 작성: qa-agent / 2026-08-05
> 입력: `_workspace/01_planner_prd.md`, `_workspace/02_backend_api-spec.md`, `_workspace/03_frontend_screens.md`,
> `server.js`, `data/products.js`, `public/index.html`, `public/app.js`, `public/styles.css`
> 검증 방식: **두 에이전트의 자기보고를 신뢰하지 않고**, 원본 코드 양쪽 동시 읽기 + 구동 중인 실서버(`http://localhost:3000`) curl + 실브라우저(Chromium) 렌더 검증

## 결론

**Critical 0건 / Important 0건.** 경계면(백엔드 응답 ↔ 프론트 파싱) 불일치는 **발견되지 않았다.**
PRD 기능 요구사항 16개 항목(1.1~1.6, 2.1~2.4, 3.1~3.6) 및 테스트 선택자 9개 전부 통과.
Minor 3건 + 정보성 2건만 아래에 기록한다. 재작업 지시 사항 없음.

---

## 1. 검증 방법 (재현 가능)

에이전트 자기보고를 배제하기 위해 다음 3단계를 직접 실행했다.

| 단계 | 내용 |
|---|---|
| A. 원본 교차 읽기 | `server.js` / `data/products.js`(생산자)와 `public/app.js` / `index.html`(소비자)를 나란히 열고 필드명·래핑·에러 shape을 1:1 대조 |
| B. 실서버 curl | 3개 엔드포인트를 직접 호출해 원시 JSON·상태코드·Content-Type 확인 (문서에 적힌 값이 아니라 실제 응답) |
| C. 실브라우저 실행 | Chromium(Playwright)으로 `http://localhost:3000/` 로드. 정상/빈/에러/로딩/이미지실패 5개 시나리오를 **실서버 응답으로** 재현하고 DOM·지오메트리·스크린샷 확보. 추가로 app.js를 Node DOM 스텁 위에서 실서버 fetch로 단독 실행 |

`?simulate=empty` / `?simulate=error`는 `page.route()`로 프론트의 `fetch('/api/products')`를 실서버의 시뮬레이션 쿼리로 리라이트해 재현했다 — 고정 fixture가 아니라 **실제 서버가 만든 응답**이다.

### 1.1 실서버 원시 응답 (직접 curl 결과)

```
GET /api/products                  → 200  application/json; charset=utf-8
  Array.isArray(body) = false      Object.keys(body) = ["items"]      body.items.length = 8
  각 item keys = id,name,price,imageUrl,description  (8개 전부 정확히 5개, null 없음)
  price = 19000/59000/78000/32000/45000/24000/89000/28000  (전부 number, Number.isInteger = true)

GET /api/products?simulate=empty   → 200  {"items":[]}
GET /api/products?simulate=error   → 500  {"error":{"message":"상품 목록을 불러오지 못했습니다."}}
GET /api/cart                      → 404  {"error":{"message":"존재하지 않는 API 경로입니다."}}
GET / , /styles.css , /app.js , /images/p1.svg → 200 (서빙 파일 = 디스크 파일과 바이트 동일함을 diff로 확인)
```

### 1.2 실브라우저 시나리오 결과

| 시나리오 | 보이는 상태 컨테이너 | 카드 수 | 콘솔 에러 |
|---|---|---|---|
| 정상 (1280px) | `product-list` **1개만** | 8 | 없음 |
| 정상 (375px) | `product-list` **1개만** | 8 | 없음 |
| `{"items":[]}` | `empty-state` **1개만** | 0 | 없음 |
| 500 + `{error:{message}}` | `error-state` **1개만** | 0 | 없음 (의도된 `console.error` 1건만) |
| 응답 2.5초 지연 | `loading-state` **1개만** | 0 | 없음 |
| 네트워크 실패(fetch reject) | `error-state` **1개만** | 0 | 의도된 로그만 |
| 이미지 전부 로드 실패 | `product-list` **1개만** | 8 (레이아웃 유지) | 없음 |

**모든 시나리오에서 노출된 상태 컨테이너가 정확히 1개** — PRD 2.4가 구조가 아니라 실제 렌더에서 확인됐다.

---

## 2. 통합 정합성 검증 (양쪽 동시 읽기) — 핵심

지시받은 6개 교차 검증 항목. **전부 통과.**

### 2.1 응답 래핑 — `{ items: [...] }` 언래핑 ✅ PASS

| 생산자 (backend) | 소비자 (frontend) |
|---|---|
| `server.js:51-59` — `res.status(200).json({ items: items.map(...) })` | `public/app.js:38-44` — `mapProductListResponse(body)`가 `Array.isArray(body.items)` 확인 후 `body.items.map(mapProduct)` |

- 프론트 코드 전체에서 응답을 **배열로 가정하는 지점이 한 곳도 없다.** `body.map(` / `data.map(` / `res.json().then(arr => arr.` 패턴 없음.
- 언래핑 지점이 `mapProductListResponse()` **한 곳으로 단일화**되어 있어 shape 변경 시 수정 지점이 1개다 (`app.js:166-167`에서만 호출).
- 오히려 계약 위반 방어까지 되어 있다 — `items`가 배열이 아니면 `throw`해서 에러 상태로 넘어간다(`app.js:39-42`). 백엔드가 실수로 top-level 배열을 반환해도 화면이 백지가 되지 않고 에러 상태가 뜬다.
- 실측: `Object.keys(body) = ["items"]`, `Array.isArray(body) = false`, 브라우저에서 카드 8개 렌더.

### 2.2 필드명 일치 (`id`/`name`/`price`/`imageUrl`/`description`) ✅ PASS

| 필드 | backend (`data/products.js` / `server.js:53-57`) | frontend (`app.js:29-33`) | 결과 |
|---|---|---|---|
| `id` | `p.id` → `"p1"` (string) | `String(item.id)` → `data-product-id`(`app.js:81`) | ✅ 일치 |
| `name` | `p.name` | `String(item.name)` → `product-name`(`app.js:108`), `img.alt`(`app.js:91`) | ✅ 일치 |
| `price` | `p.price` (integer) | `formatPrice(item.price)`(`app.js:31`) | ✅ 일치 |
| `imageUrl` | `p.imageUrl` (camelCase) | `String(item.imageUrl)` → `img.src`(`app.js:90`) | ✅ 일치 |
| `description` | `p.description` | `item.description`(`app.js:33`) | ✅ 일치 |

- **오타·case 불일치 0건.** `image_url` / `img` / `thumbnail` / `unitPrice` / `amount` / `productId` 등 오염 필드명은 프론트 코드에 존재하지 않는다.
- 프론트가 참조하는 필드가 5개를 초과하지 않는다 — 백엔드가 안 주는 필드(재고·카테고리·할인가)를 추측으로 읽는 코드 없음.
- 실브라우저 실측: `data-product-id` = `p1`~`p8`, 이름 8개 전부 시드값과 문자 단위 일치, 이미지 src = `/images/p1.svg`~`p8.svg` 전부 200.

### 2.3 에러 핸들링 — 중첩 `error.message` + HTTP 상태 판정 ✅ PASS

| 생산자 | 소비자 |
|---|---|
| `server.js:86-88` — 5xx + `{ error: { message: "..." } }` (message는 **error 객체 안에 중첩**) | `app.js:47-52` — `readErrorMessage(body)`가 `body.error && typeof body.error.message === 'string'`으로 **한 겹 안에서** 읽음 |
| `server.js:51` — 성공은 항상 200. 에러를 200으로 내리는 경로 없음 | `app.js:157` — `if (!res.ok)` **상태 코드로만** 성공/실패 판정. body 내용으로 성공을 판정하는 코드 없음 |

- 프론트에 `body.message` / `data.message` 같은 **top-level `message` 참조가 존재하지 않는다** (grep 확인). 흔한 "한 겹 벗기기" 실수 없음.
- 실측 증거: 500 시나리오에서 콘솔에 찍힌 문구가 `상품 목록을 불러오지 못했습니다.`(**마침표 있음 = 서버가 보낸 `error.message`**)였다. 만약 top-level `message`를 읽었다면 `readErrorMessage`가 빈 문자열을 반환해 프론트 자체 문구 `상품을 불러오지 못했습니다`(마침표 없음)로 폴백됐을 것이다 — 이 한 글자 차이로 중첩 파싱이 실제 동작함을 확인했다.
- 에러 응답 body가 JSON이 아니어도 안전하다 — `app.js:159`의 `.catch(() => null)`로 파싱 실패를 흡수하고 기본 문구로 폴백한다.
- 네트워크 자체 실패(fetch reject)도 최종 `.catch`(`app.js:180-185`)에서 동일하게 에러 상태로 수렴 — 죽은 포트로 요청을 돌려 실측 확인했다.

### 2.4 빈 상태 트리거 조건 ✅ PASS

- 트리거는 `app.js:169`의 `products.length === 0`이며, 이 `products`는 **실제 `{ items: [] }` 응답을 `mapProductListResponse()`로 언래핑한 결과**다. `body.length` / `!body` / `!data` 같은 엉뚱한 조건이 아니다.
- 200을 에러로 오인하는 경로가 없다 — `res.ok`가 true이므로 에러 분기(`app.js:157`)를 타지 않고 정상 경로로 들어와 빈 상태로 분기한다.
- `app.js:170`에서 `renderProducts([])`로 리스트를 **먼저 비우고** 빈 상태를 켠다 → PRD 2.2의 "카드 0개" 보장.
- 실측: 실서버 `{"items":[]}` → `empty-state`만 노출, 카드 0개, 마스트헤드 `판매 중 0점`, 화면 문구 `판매 중인 상품이 없습니다`.

### 2.5 data-testid 9개 전수 확인 ✅ PASS

| PRD | testid | 실제 위치 | 확인 |
|---|---|---|---|
| 4.1 | `product-list` | `public/index.html:47` (`<ul>`) | ✅ |
| 4.2 | `product-card` | `public/app.js:80` (`<li>`) | ✅ 브라우저에서 8개 |
| 4.2 | `data-product-id="{id}"` | `public/app.js:81` | ✅ `p1`~`p8`, 변환 없이 원본 문자열 |
| 4.3 | `product-name` | `public/app.js:107` (`<h2>`) | ✅ |
| 4.3 | `product-price` | `public/app.js:119` (`<span>`) | ✅ |
| 4.3 | `product-image` | `public/app.js:89` (`<img>`) | ✅ 이미지 실패 시에도 DOM 잔존 확인 |
| 4.4 | `loading-state` | `public/index.html:25` | ✅ |
| 4.4 | `empty-state` | `public/index.html:37` | ✅ |
| 4.4 | `error-state` | `public/index.html:42` | ✅ |

**9/9 존재하며 철자·대소문자가 PRD와 정확히 일치.** 오타(`product_list`, `productCard`, `productList` 등) 없음.
로딩 스켈레톤(`index.html:27-34`)에는 `product-card`를 붙이지 않아 **로딩 중 카드 수가 0**임도 실측 확인 (2.4/2.2 오염 방지).

### 2.6 PRD 1.6 — 링크/버튼/장바구니 없음 ✅ PASS (자기보고가 아니라 렌더된 DOM에서 확인)

정적 grep + 실브라우저 DOM 조회 두 방법으로 확인했다.

- 정적 grep (`index.html`, `app.js`, `styles.css`): `<a `·`href=`·`<button`·`onclick`·클릭 계열 `addEventListener`·`role="link|button"`·`cursor: pointer`·`location.`·`window.open` → **`index.html:8`의 `<link rel="stylesheet">` 단 1건 외 전무.**
- 실브라우저 렌더 후 DOM 조회: `a[href], button, [onclick], [role=link], [role=button], input, form` → **0개**. `getComputedStyle(el).cursor === 'pointer'`인 엘리먼트 → **0개**.
- 실제 클릭 테스트: 첫 카드를 클릭해도 URL이 `http://localhost:3000/`에서 변하지 않음(1280px·375px 양쪽).
- 범위 밖 문자열 grep(`cart`, `checkout`, `장바구니`, `결제`, `products/`) → **0건**. 프론트가 미구현 엔드포인트를 호출하는 코드 없음(PRD 3.6, API 스펙 §1 지시 준수).
- `?simulate=` 문자열도 프로덕션 코드에 없음 — API 스펙 §4의 "훅을 프로덕션에 쓰지 말 것" 지시 준수. 실측 fetch 호출 URL은 `/api/products` 하나뿐.

---

## 3. PRD 요구사항별 판정

### 3.1 상품 목록(홈) 화면

| # | 요구사항 | 판정 | 근거 (파일:라인 / 실측) |
|---|---|---|---|
| 1.1 | `/` 접속 시 서버 조회 후 카드 나열 | ✅ PASS | `app.js:154` `fetch('/api/products')` → `app.js:176` `renderProducts()` → `index.html:47` 그리드. 실브라우저 카드 8개 |
| 1.2 | 카드에 이미지·상품명·가격 필수 표시 | ✅ PASS | 이미지 `app.js:87-96`, 상품명 `app.js:105-108`, 가격 `app.js:117-120`. `description`도 표시(프론트 재량, `app.js:128-133`) |
| 1.3 | 천 단위 구분 기호, 소수점 없음 | ✅ PASS | `app.js:55-59` `Math.round(n).toLocaleString('ko-KR')+'원'`. 실측 8개 전부 `/^\d{1,3}(,\d{3})*원$/` 매치: `19,000원 / 59,000원 / 78,000원 / 32,000원 / 45,000원 / 24,000원 / 89,000원 / 28,000원` |
| 1.4 | 이미지 실패 시 레이아웃 유지 + 대체 영역 | ✅ PASS | `app.js:94-96` error 핸들러 + `styles.css:136-166`(`aspect-ratio: 4/5`, `.is-broken`). **모든 이미지 요청을 abort시킨 실측**: 패널 8개 전부 `is-broken` 적용, 패널 높이 전부 319px로 동일(정상 시와 같음), 카드 높이 전부 414px로 동일, `이미지 준비 중` 대체 문구 8개 노출, `product-image` 8개 DOM 잔존 |
| 1.5 | 그리드 배치, 375px에서 잘림/겹침 없음 | ✅ PASS | `styles.css:121-128`. **실브라우저 지오메트리 실측** — 375px: 1열, 카드폭 343px = 리스트폭 343px, 겹침 0, 리스트 밖 삐져나온 카드 0, `scrollWidth(375) == clientWidth(375)`(가로 스크롤 없음). 1280px: 4열, 카드폭 256px, 겹침 0 |
| 1.6 | 클릭해도 이동 없음, 링크/장바구니 버튼 없음 | ✅ PASS | §2.6 참조. 렌더된 DOM에 클릭 가능 요소 0개, 실제 클릭 시 URL 불변 |

### 3.2 상태 처리

| # | 요구사항 | 판정 | 근거 |
|---|---|---|---|
| 2.1 | 응답 대기 중 로딩 표시 | ✅ PASS | `index.html:25` 로딩 컨테이너가 초기 HTML에서 `hidden` 없이 노출(JS 실행 전에도 보임) + `app.js:151` `showOnly('loading')`. **응답 2.5초 지연 실측**: `loading-state`만 노출, 스켈레톤 8개, 카드 0개 |
| 2.2 | 상품 0개 → 에러 아닌 빈 상태, 카드 0개 | ✅ PASS | `app.js:169-174`. 실서버 `{"items":[]}` 실측: `empty-state`만 노출, 카드 0개, `판매 중인 상품이 없습니다` |
| 2.3 | 호출 실패(네트워크/5xx) → 에러 메시지, 백지 아님 | ✅ PASS | `app.js:157-163`(5xx) / `app.js:180-185`(reject). 실서버 500 실측 및 죽은 포트 실측 모두 `error-state`만 노출, `상품을 불러오지 못했습니다` + 안내문 렌더(백지 아님) |
| 2.4 | 로딩/빈/에러 상호 배타 | ✅ PASS | `app.js:63-69` `showOnly()`가 4개 컨테이너 `hidden`을 한 번에 설정 + `styles.css:43` `[hidden]{display:none!important}`. **7개 시나리오 전부 노출 컨테이너 정확히 1개** (실브라우저 `isVisible()` 측정) |

### 3.3 상품 목록 API

| # | 요구사항 | 판정 | 근거 |
|---|---|---|---|
| 3.1 | 200 + `{items:[...]}`, top-level 배열 금지 | ✅ PASS | `server.js:51-59`. 실측 `Array.isArray(body)=false`, `Object.keys(body)=["items"]` |
| 3.2 | 0개일 때도 200 + `{items:[]}` | ✅ PASS | `server.js:48`. 실측 `?simulate=empty` → `200` / `{"items":[]}` |
| 3.3 | 각 요소 5개 필드 전부, 생략·null 금지 | ✅ PASS | `server.js:52-58`이 5개 필드를 **명시적으로 매핑**(시드에 필드가 추가돼도 응답 shape이 안 새는 구조). 실측 8/8 items가 정확히 `id,name,price,imageUrl,description`, null 없음, `price` 전부 `Number.isInteger` |
| 3.4 | 5xx + `{error:{message}}`, 200으로 에러 금지 | ✅ PASS | `server.js:78-93` 에러 핸들러. 실측 `?simulate=error` → `500` / `{"error":{"message":"상품 목록을 불러오지 못했습니다."}}`, Content-Type JSON |
| 3.5 | 시드 6개 이상 | ✅ PASS | `data/products.js:16-73` — **8개** |
| 3.6 | `GET /api/products` 외 API 없음 | ✅ PASS | `server.js`에 라우트는 `/api/products` 하나. `server.js:68-72`가 나머지 `/api/*`를 404 JSON으로 처리. 실측 `/api/cart` → 404 JSON. 프론트에도 호출 코드 없음 |

### 3.4 테스트 선택자

| # | 판정 | 근거 |
|---|---|---|
| 4.1 / 4.2 / 4.3 / 4.4 | ✅ PASS | §2.5 표 참조 — 9/9 존재, 명칭 정확 |

---

## 4. Minor / 정보성 기록 (수정 필수 아님)

### [Minor] M1 — 서버가 보낸 `error.message`가 사용자 화면에 노출되지 않음

- 위치: `public/app.js:161` (읽기) ↔ `public/index.html:43-44` (표시)
- 내용: `readErrorMessage(body)`로 서버 메시지를 정확히 꺼내지만, 그 값은 `throw new Error(...)`를 거쳐 `console.error`(`app.js:184`)에만 남고, 화면에는 `index.html:43`의 고정 문구가 뜬다.
- 판단: **결함 아님.** `02_backend_api-spec.md:155`가 "PRD 2.3 문구를 프론트가 자체적으로 쓰는 것도 무방하다"고 명시했고 PRD 2.3도 문구를 지정한다. 현재 서버는 상황과 무관하게 같은 문구 하나만 보내므로 실질 손실도 없다.
- 향후 지침: 백엔드가 사유별로 다른 `error.message`(예: 점검 중, 일시적 과부하)를 보내기 시작하면 `index.html`의 고정 문구 대신 `readErrorMessage()` 결과를 노출하도록 바꿔야 한다. 그때 **양쪽 에이전트에 동시에 알릴 것.**

### [Minor] M2 — 빈/에러/로딩 상태에서 `product-list`는 DOM에 있으나 `hidden`이다

- 위치: `public/app.js:67` (`el.list.hidden = name !== 'list'`) + `public/styles.css:43`
- 내용: PRD 2.4(상호 배타) 때문에 정상 동작이지만, 이후 E2E 테스트가 `expect(locator('[data-testid=product-list]')).toBeVisible()`를 무조건 기대하면 빈/에러 케이스에서 오탐(false fail)이 난다.
- 수정 방향: 코드 수정 불필요. **테스트 작성 시 `product-list`는 "DOM 존재"로, 상태 판정은 4개 컨테이너 중 무엇이 `visible`인지로** 단언할 것. 카드 수는 `[data-testid=product-card]`의 count로 센다(로딩 스켈레톤에는 이 testid가 없어 항상 0으로 나온다).

### [Minor] M3 — `img`의 error 리스너가 `src` 할당보다 뒤에 등록됨

- 위치: `public/app.js:90`(`img.src = ...`) vs `public/app.js:94`(`addEventListener('error', ...)`)
- 내용: 이미지 로드는 비동기라 같은 동기 태스크 안에서 등록되는 리스너가 이벤트를 놓치지 않는다. **실측으로도 이미지 8개 전부 abort 시 패널 8/8에 `is-broken`이 적용됨을 확인했다 — 현재 동작에 문제 없음.**
- 수정 방향(선택): 견고성 차원에서 `addEventListener('error', ...)`를 `img.src = ...` 앞으로 옮기면 향후 동기 캐시 경로 변화에도 안전하다. 우선순위 낮음.

### [정보] I1 — `loading="lazy"`로 마지막 카드 이미지는 스크롤 시 로드됨

- 위치: `public/app.js:92`
- 375px 뷰포트 초기 로드 시 `p8` 이미지만 `naturalWidth = 0`(미로드) 상태였다. 스크롤하면 8/8 모두 로드되며, **이때 `is-broken` 패널은 0개** — 지연 로딩이 PRD 1.4의 실패 대체 표시를 잘못 트리거하지 않음을 확인했다. 의도된 최적화 동작이며 결함 아님.

### [정보] I2 — 스토어 이름은 PRD에 없는 프론트 재량 문구 (product-planner 확인 필요)

- 위치: `public/index.html:13-16` — `HARU STORE / 하루상점 · 매일 쓰는 것들`
- frontend-agent가 `03_frontend_screens.md:139`에서 이미 신고한 항목. 기능·API·testid와 무관한 표시 문구이며 QA 결함이 아니다. **product-planner의 승인 또는 다른 이름 지정만 필요**하고, 바꿀 경우 `index.html`의 `.mark` 블록 한 곳만 고치면 된다.

---

## 5. 회귀 위험 (다음 사이클에 코드를 건드릴 때 주의)

| 위험 지점 | 내용 |
|---|---|
| `public/styles.css:43` `[hidden] { display: none !important; }` | **삭제 금지.** `.skeletons`(`styles.css:218`)와 `.grid`(`styles.css:121`)가 `display: grid`라서, 이 규칙이 없으면 브라우저 기본 `[hidden]` 스타일을 이겨버려 **로딩 스켈레톤과 상품 그리드가 동시에 보이는 PRD 2.4 위반**이 즉시 발생한다. 지금 통과하는 이유가 이 한 줄이다 |
| `public/app.js:38-44` `mapProductListResponse()` | 응답 래핑을 벗기는 **유일한** 지점. 백엔드가 shape을 바꾸면 여기만 고치면 되지만, 반대로 여기 밖에서 `body.items`를 직접 읽는 코드가 새로 생기면 단일 지점 이점이 사라진다 |
| `public/app.js:47-52` `readErrorMessage()` | 에러 중첩을 벗기는 유일한 지점. `body.message`(한 겹) 형태를 새로 추가하려는 시도가 있으면 백엔드 계약(`02_backend_api-spec.md:165`)과 충돌한다 |
| `server.js:52-58` 명시적 필드 매핑 | 시드(`data/products.js`)에 6번째 필드를 추가해도 응답에는 안 나가는 구조. 새 필드를 노출하려면 PRD 데이터 모델 → API 스펙 → `server.js` 매핑 → 프론트 순서로 갱신할 것 |

---

## 6. 미검증 항목

없음. `03_frontend_screens.md:126-133`이 "브라우저 스크린샷 필요"로 남겨둔 4개 항목(실제 픽셀 렌더, 375px 레이아웃, SVG `contain`, 로딩 스켈레톤 체감)은 이번 QA에서 Chromium 실렌더로 **전부 확인 완료**했다.

- 실제 픽셀 렌더 / SVG `contain`: 1280px 스크린샷 — 4열 그리드 정렬, 이미지가 패널 안에 `contain`으로 들어감, 점선 리더가 카드 좌측에서 가격까지 이어짐. 깨진 곳 없음
- 375px: 1열, 잘림/겹침/가로 스크롤 없음 (§3.1의 1.5 실측치)
- 로딩 스켈레톤: 응답 2.5초 지연으로 강제 노출해 스켈레톤 8개 렌더 확인
- 이미지 실패 화면: 전체 이미지 abort 상태에서 `이미지 준비 중` 대체 영역 8개, 카드 높이 불변 확인

---

## 7. 양쪽 에이전트에게 전달할 사항

- **backend-agent**: 회신 사항 없음. `02_backend_api-spec.md`에 적힌 shape·상태코드·필드가 실서버 응답과 **전부 일치**했다(문서가 실제와 다른 곳 0건). 문서를 신뢰 가능한 계약으로 유지한 점이 이번 사이클에 경계면 버그가 0건인 직접적 원인이다.
- **frontend-agent**: 회신 사항 없음. `03_frontend_screens.md`의 자기보고 내용이 실제 코드·실브라우저 렌더와 **전부 일치**했다(과장·누락 0건). 미검증으로 남겨둔 4개 항목은 §6에서 QA가 대신 확인했고 모두 통과다. 참고로 M2(테스트 작성 시 `product-list` 가시성 단언 주의)와 M3(리스너 등록 순서, 선택)만 인지해 두면 된다.
- **product-planner**: I2(스토어 이름 `HARU STORE / 하루상점`) 승인 여부만 회신 필요.

---

## 변경 이력

| 날짜 | 변경 내용 |
|---|---|
| 2026-08-05 | 최초 작성 — PRD 1.1~1.6 / 2.1~2.4 / 3.1~3.6 / 4.1~4.4 전수 검증. 실서버 curl + Chromium 실렌더 교차 검증. Critical 0 / Important 0 / Minor 3 |

---
---

# QA 검증 리포트 — 2차 사이클 (상품 상세 + 장바구니)

> 작성: qa-agent / 2026-08-08
> 입력: `_workspace/01_planner_prd.md`(5~10장 신규), `_workspace/02_backend_api-spec.md`(§2A~§2G 신규),
> `_workspace/03_frontend_screens.md`(7~14절 신규), `server.js`,
> `public/product.html`, `public/product.js`, `public/cart.html`, `public/cart.js`, `public/cart-badge.js`,
> `public/index.html`·`public/app.js`·`public/styles.css`(개정분)
> 검증 방식: **두 에이전트의 자기보고(§5-2 curl 기록, 12.2 스텁 실행 기록)를 신뢰하지 않고 전부 다시 실행**했다.
> 원본 코드 양쪽 동시 읽기 + 실서버(`http://localhost:3000`) curl(쿠키 항아리 2개) + 자체 DOM 스텁 위 실코드 실행 + 실브라우저(Chromium/Playwright) 조작.
> 범위: 상품 상세 + 장바구니(담기/조회/수량변경/삭제) 신규분과 1차 랜딩 회귀. **결제는 범위 밖이므로 부재를 결함으로 잡지 않았다.**

## 결론 (2차)

**Critical 0건 / Important 0건.** 이번 사이클 최대 위험으로 지목된 **응답 깊이(shape depth) 불일치는 실제 버그가 아니었다** — 한 겹(`{items}`) / 한 겹 단수(`{item}`) / 두 겹(`{cart:{...}}`) 세 가지를 벗기는 함수가 각각 다른 파일에 분리되어 있고, 전부 올바른 깊이를 쓴다(§2.1).

- PRD 2차 기능 요구사항 **5.1~5.7 / 6.1~6.12 / 7.1~7.10 / 8.1~8.7 / 9.1~9.13 전부 통과**
- 2차 신규 테스트 선택자 **30개 전부 정확한 이름으로 존재**(10.1~10.13), 1차 8개도 위치 불변
- 1차 랜딩(1.1~1.5 / 2.1~2.4 / 3.1~3.5 / 4.1~4.4) **회귀 없음**
- Minor 2건 + 정보성 3건만 아래 §4에 기록. **재작업 지시 사항 없음**(Minor는 다음 사이클 반영 권고).

---

## 1. 검증 방법 (재현 가능)

| 단계 | 내용 |
|---|---|
| A. 원본 교차 읽기 | 생산자(`server.js` 신규 5개 라우트)와 소비자(`cart-badge.js` / `cart.js` / `product.js` / `app.js`)를 나란히 열고 **래핑 깊이·필드명·상태코드 판정 조건**을 1:1 대조 |
| B. 실서버 curl | 6개 엔드포인트를 쿠키 항아리(`-c`/`-b`) 2개로 직접 호출. 정상/400 8종/404 3종/99 상한/쿠키 발급·재사용·격리 전수 확인 (백엔드 §5-2를 그대로 믿지 않고 재실행) |
| C. DOM 스텁 위 실코드 실행 | `public/*.js`를 **수정 없이** 최소 DOM 스텁 위에서 실행하고 `fetch`는 구동 중인 실서버로 내보냄. 요청 method/URL/body를 전수 기록해 "무엇을 보냈는가"를 직접 확인 (프론트 12.2의 자기보고를 재현·검증) |
| D. 실브라우저 조작 | Chromium으로 목록→상세→담기→장바구니→수량변경→삭제 전 흐름을 **실제 클릭**으로 수행. 네트워크 요청 body를 가로채 절대값 여부 확인, 컨텍스트 2개로 쿠키 격리 확인, 375px 레이아웃·스크린샷 확보 |

자동 검증 결과: 스텁 실행 **83/83 통과**(목록 12 / 상세 29 / 장바구니 32 / 상태전환 10), 실브라우저 **25/25 통과**(콘솔 에러는 의도된 `?id=zzz`의 404 1건뿐 — 정상 경로 3화면 콘솔 에러 0건).

---

## 2. 경계면 정합성 — 이번 사이클 최대 위험 4종

### 2.1 [통과] 응답 깊이 불일치 — **실제 버그 아님**

가장 터지기 쉬운 지점(래핑 깊이 3종 혼용)을 함수 단위로 대조했다. **잘못된 unwrap 복붙은 한 건도 없었다.**

| 엔드포인트 | 서버 실제 응답 (curl 원문) | 프론트 벗기는 지점 | 판정 |
|---|---|---|---|
| `GET /api/products` | `{"items":[...]}` — 한 겹 | `app.js:45-51` `mapProductListResponse()` → `body.items` | ✅ 일치 |
| `GET /api/products/:id` | `{"item":{...}}` — 한 겹 **단수** | `product.js:56-61` `mapDetailResponse()` → `body.item` | ✅ 일치 |
| `GET/POST/PATCH/DELETE 장바구니 4종` | `{"cart":{"items":[],"totalQuantity":0,"totalPrice":0}}` — **두 겹** | `cart-badge.js:62-74` `mapCartResponse()` → `body.cart.items` | ✅ 일치 |

- 세 함수가 **서로 다른 파일**에 있고 이름도 다르다(`…ListResponse` / `…DetailResponse` / `…CartResponse`). `cart.js`·`product.js` 어디에도 장바구니 응답을 직접 벗기는 코드가 없다 — 두 겹을 벗기는 지점은 `cart-badge.js` **한 곳뿐**(PRD 349행 지시 준수).
- 실증: 장바구니 4개 엔드포인트 응답의 top-level 키가 전부 `["cart"]`, 상세는 `["item"]`, 목록은 `["items"]`임을 curl로 확인. 프론트가 이 응답으로 실제로 화면을 그리는 것을 스텁·실브라우저에서 확인(줄 2개 / 합계 `3` · `127,000원` / 배지 `3`).
- `data.items`(한 겹)를 장바구니 응답에 잘못 쓰면 `undefined`가 되어 즉시 Critical이 됐을 자리인데, **그 코드가 존재하지 않는다.**

### 2.2 [통과] PATCH 절대값 semantics (PRD 7.2 / 9.5)

- 프론트: `cart.js:219` 증가 → `setQuantity(productId, quantity + 1)`, `cart.js:225` 감소 → `setQuantity(productId, quantity - 1)`. **현재 수량을 DOM(`cart-item-quantity`)에서 읽어 계산한 뒤 "변경 후 절대값"을 보낸다.** delta(`+1`/`-1`)를 보내는 코드 없음.
- 실증(실브라우저 요청 가로채기): 수량 2인 `p3` 줄에서 `+` 클릭 → `PATCH /api/cart/items/p3` body **`{"quantity":3}`**. 응답 수량 `3`(delta였다면 5가 됐을 자리). 줄 합계 `234,000원`, 총계·배지 동시 갱신, **줄 순서 유지**.
- 서버: `server.js:337` `target.quantity = quantity`(덮어쓰기). curl로 `5 → {"quantity":3}` → 결과 `3` 확인(8 아님).

### 2.3 [통과] `quantity: 0` 차단 — 서버·프론트 양쪽

- 서버: `server.js:190-193` `isValidQuantity()`가 `Number.isInteger && 1..99`. curl `PATCH {"quantity":0}` → **400** `{"error":{"message":"수량은 1 이상 99 이하의 정수여야 합니다."}}`, 직후 `GET /api/cart`에서 수량 **불변**(삭제로 처리되지 않음).
- 프론트 이중 방어: `cart.js:104` `dec.disabled = item.quantity <= MIN_QTY`(렌더 시) + `cart.js:224` `if (quantity <= MIN_QTY) return;`(핸들러). 상세도 동일(`product.js:90`, `product.js:98`).
- 실증: 스텁·실브라우저 전 구간 요청 로그에서 **`"quantity":0`을 담은 요청 0건**. 수량 1에서 감소 버튼을 `force` 클릭해도 요청 0건, 줄이 사라지지 않고 상태도 `cart-list` 유지. 99에서 증가 클릭도 요청 0건(100 미발송).

### 2.4 [통과] 금액 계산 주체 = 서버뿐 (PRD 7.6 / 9.8)

- `public/*.js` 전수 grep: `price * quantity`, `reduce`, `+=` 등 **합산·곱셈 산술 0건**. `cart.js`가 화면에 쓰는 값은 전부 서버 필드다 — `cart.js:153-155`(`totalQuantity` / `totalPriceText`), `cart-badge.js:47-58`(`lineTotal`을 그대로 받아 포맷만 입힘).
- 프론트에 남은 산술은 PATCH 절대값 계산(`quantity ± 1`)과 표시 포맷(`Math.round().toLocaleString()`)뿐이며, 둘 다 금액이 아니다.
- 실증: 서버 `lineTotal:156000` / `totalPrice:156000` ↔ 화면 `156,000원` 일치. 수량 3으로 바꾼 뒤 `234,000원`도 서버 값과 일치.

---

## 3. PRD 요구사항별 판정

### 3.1 목록 화면 개정분 (5.x)

| # | 판정 | 근거 |
|---|---|---|
| 5.1 카드 클릭 → `/product.html?id={id}` | ✅ | `app.js:92-94` 실제 `<a href>`. 8개 href가 `p1`~`p8`로 정확히 매핑. 실브라우저에서 `p3` 카드 클릭 → `http://localhost:3000/product.html?id=p3` 이동 확인 (JS `location` 조작 아님) |
| 5.2 카드에 담기 버튼 없음 | ✅ | 목록 화면 전체 `<button>` **0개**. 카드의 클릭 대상은 링크 하나뿐 |
| 5.3 기존 선택자 위치 불변 | ✅ | `product-card`·`data-product-id`는 여전히 `<li>`(`app.js:87-88`), `product-name`/`price`/`image`는 카드 내부. 링크는 `<li>`와 내부 요소 사이에 삽입 |
| 5.4 세 화면 헤더에 장바구니 링크 | ✅ | `index.html:19`, `product.html:20`, `cart.html:20` — 전부 `cart-link` + `cart-count` |
| 5.5 0이면 배지 숨김, >0이면 숫자 | ✅ | `cart-badge.js:132-143`. 0 → `hidden` + DOM 유지, 2줄(2+3) → `5` 표시. `styles.css:43` `[hidden]{display:none!important}`가 `display:inline-flex`를 이겨 실제로 안 보임(실브라우저 `isVisible()=false` 확인) |
| 5.6 담기/변경/삭제 후 즉시 갱신 | ✅ | 값은 전부 응답의 `cart.totalQuantity`. 담기 후 `2`, PATCH 후 `4`, 삭제 후 `0`+숨김 — 새로고침 없이 갱신 |
| 5.7 장바구니 조회 실패해도 목록 정상 | ✅ | `cart-badge.js:154-165` `refreshBadge()`가 catch 후 배지만 숨기고 예외를 삼킴. 배지용 호출만 500으로 갈아끼운 실행에서 **카드 8개 정상 렌더 + `product-list`만 노출**, 배지만 숨김 |

### 3.2 상품 상세 (6.x)

| # | 판정 | 근거 |
|---|---|---|
| 6.1 이미지·이름·가격·설명 4종 | ✅ | 실브라우저 `p3`: `오버핏 후드 집업` / `78,000원` / `/images/p3.svg` / 설명 전문 표시 |
| 6.2 가격 포맷 | ✅ | `19000` → `19,000원`(소수점 없음), `HaruCart.formatPrice` 공용 |
| 6.3 수량 1~99, 경계에서 무동작 | ✅ | 초기값 `1` + 감소 `disabled`. 증가 2회 → `3`, 감소 → `2`. 직접 입력 `150`→`99`(+증가 disabled), `0`→`1`, `abc`→`1` (`product.js:81-93`) |
| 6.4 POST body | ✅ | 실브라우저 가로채기: `POST /api/cart/items` `{"productId":"p3","quantity":2}` |
| 6.5 성공 피드백 + 배지 갱신 + 자동 이동 없음 | ✅ | `add-to-cart-success` 노출, 배지 `2`, URL이 `product.html` 그대로 |
| 6.6 재담기 = 수량 합산 | ✅ | 2개 후 3개 재담기 → 배지 `5`, 서버 줄 **1개**·수량 `5`(`server.js:285-291`) |
| 6.7 실패 시 배지 미갱신 | ✅ | 99인 상태에서 1개 추가 → 실서버 400. `add-to-cart-error`에 서버 문구 표시, **배지 `99` 그대로**, 성공 문구 숨김, 상세 화면 유지 |
| 6.8 없는 id → not-found + 목록 링크 | ✅ | `product.js:210-213`이 `status===404`만 not-found로 분기. `detail-not-found` 하나만 노출 + 목록 링크 |
| 6.9 id 없음/빈 값 → 호출 없이 not-found | ✅ | `product.js:201-204`. `?id` 없음/`?id=` 둘 다 `/api/products*` 요청 **0건** |
| 6.10 4상태 배타 | ✅ | `product.js:65-71` `showOnly()`. 정상/404/5xx 각 케이스에서 노출 상태 요소 정확히 1개 |
| 6.11 목록 링크 | ✅ | `product.html:30` 상단 + not-found/error 내부에도 각각 존재 |
| 6.12 결제 버튼 없음 | ✅ | 상세 화면 텍스트·코드에 결제/구매/checkout 문자열 0건 |

### 3.3 장바구니 화면 (7.x)

| # | 판정 | 근거 |
|---|---|---|
| 7.1 줄 5요소 | ✅ | `/images/p1.svg` · `베이직 코튼 티셔츠` · 단가 `19,000원` · 수량 `2` · 줄합계 `38,000원`. 줄마다 `GET /api/products/:id` 호출 **0건**(N+1 없음) |
| 7.2 PATCH 절대값 | ✅ | §2.2 |
| 7.3 줄·총계 동시 갱신 = 응답 스냅샷 재렌더 | ✅ | `cart.js:147-162` `renderCart()` 하나로 조회/변경/삭제 모두 처리. 수량 `3`·줄합계 `57,000원`·총 `4`/`146,000원`·배지 `4`, 줄 순서 유지 |
| 7.4 1~99, 1에서 감소 무동작 | ✅ | §2.3 |
| 7.5 삭제 버튼 → DELETE | ✅ | `DELETE /api/cart/items/p7` 1건, 줄 사라지고 합계 갱신 |
| 7.6 총액은 서버 값 그대로 | ✅ | §2.4 |
| 7.7 빈 상태 + 요약 숨김 | ✅ | `cart-empty` 하나만, `cart-summary` 숨김(`cart.js:45`), 목록 링크 존재 |
| 7.8 마지막 삭제 → 즉시 빈 상태 | ✅ | DELETE 응답만으로 전환(추가 `GET /api/cart` **0건**), 요약 숨김, 배지 `0`+숨김, 줄 0개 |
| 7.9 실패 시 에러 + 4상태 배타 | ✅ | 조회 실패(500) → `cart-error` 하나만. 변경 실패(실서버 404) → `cart-error` 하나만 + 서버 문구 `장바구니에 해당 상품이 없습니다.`, 요약 숨김 |
| 7.10 결제 버튼 없음 | ✅ | 장바구니 화면에 결제/주문 문자열 0건 (`cart-retry`는 재조회 버튼 — §4 I5) |

### 3.4 세션·영속성 (8.x)

| # | 판정 | 근거 |
|---|---|---|
| 8.1 서버 저장, 프론트 보관 금지 | ✅ | `public/*.js`·`*.html` 전수 grep: `localStorage`/`sessionStorage`/전역 장바구니 변수 **0건**(매칭 2건은 "쓰지 않는다"는 주석) |
| 8.2 쿠키 없으면 발급 | ✅ | `GET /api/cart` 최초 호출에 `Set-Cookie: cartId=…` (`server.js:136-148`). POST 최초 호출에서도 발급 확인 |
| 8.3 새로고침·화면 이동 후 유지 | ✅ | 실브라우저 F5 후 배지 `2` 유지, 상세→장바구니 이동 후 줄 유지 |
| 8.4 쿠키 7일 | ✅ | `Max-Age=604800`, `Path=/`, `HttpOnly`, `SameSite=Lax`, **`Secure` 없음** — 실헤더로 확인 |
| 8.5 브라우저별 분리 | ✅ | 쿠키 항아리 2개(curl): `jarA=p2x4` / `jarB=p5x1` / 쿠키 없음=빈 장바구니. 실브라우저 컨텍스트 2개: 2번째는 빈 장바구니, 1번째는 그대로 유지. `cartId` UUID 상이 |
| 8.6 `document.cookie` 미사용 | ✅ | 전수 grep 0건, `credentials` 옵션도 없음 |
| 8.7 서버 재시작 후 초기화 허용 | — | 검증 대상 아님(PRD 명시) |

### 3.5 신규 API (9.x) — 실서버 curl 전수

| # | 판정 | 실측 |
|---|---|---|
| 9.1 / 9.2 상세 | ✅ | 200 `{"item":{…5필드}}`(top-level 키 `["item"]`), 없는 id → 404 `{"error":{"message":"상품을 찾을 수 없습니다."}}`. 이 라우트는 쿠키를 발급하지 않음(스펙 §2A 주장 확인) |
| 9.3 조회 항상 200 | ✅ | 빈 장바구니도 200 `{"cart":{"items":[],"totalQuantity":0,"totalPrice":0}}` |
| 9.4 담기 / quantity 생략 시 1 | ✅ | `{"productId":"p7"}` → `quantity:1`. 성공 시 전체 스냅샷 |
| 9.5 PATCH 절대값 | ✅ | `5 → {"quantity":3}` → `3` |
| 9.6 DELETE 200 + body | ✅ | 204 아님. 마지막 줄 삭제 시 빈 스냅샷 |
| 9.7 4개 응답 shape 동일 | ✅ | 4종 top-level 키 전부 `["cart"]` |
| 9.8 서버 계산 | ✅ | `19000×2 + 89000×1` → `totalQuantity:3` / `totalPrice:127000` / `lineTotal` 각각 정확 |
| 9.9 400 규칙 | ✅ | `0`/`100`/`2.5`/`"2"`/`productId` 누락/`productId:123`/깨진 JSON — **8종 전부 400 + `{"error":{"message"}}`**. 99 상한: 90+15 → 400이고 장바구니는 90 **불변**, 90+9 → 200/99 |
| 9.10 404 규칙 | ✅ | 시드에 없는 `productId` POST, 장바구니에 없는 줄 PATCH/DELETE 전부 404 |
| 9.11 쿠키 속성 | ✅ | 위 8.4. 쿠키가 있으면 재발급 없음(`Set-Cookie` 0개) |
| 9.12 범위 제한 | ✅ | `POST /api/checkout`, `DELETE /api/cart` 둘 다 404 `존재하지 않는 API 경로입니다.` — 프론트에도 호출 코드 0건 |
| 9.13 에러 shape | ✅ | 전 케이스 `{"error":{"message":…}}` + 4xx/5xx. 200으로 에러를 내보내는 경로 없음 |

### 3.6 테스트 선택자 (10.x) — 30개 전수 확인

| PRD | 선택자 | 위치 | 판정 |
|---|---|---|---|
| 10.1 | `cart-link` | `index.html:19` / `product.html:20` / `cart.html:20` | ✅ 3화면 전부 |
| 10.2 | `cart-count` | 같은 3곳. 0일 때 DOM 유지 + `hidden`, 텍스트는 숫자만 | ✅ |
| 10.3 | `product-detail` + `data-product-id` | `product.html:55` (값은 `product.js:141`이 주입, 실측 `p1`/`p3`) | ✅ |
| 10.4 | `detail-name` / `detail-price` / `detail-image` / `detail-description` | `product.html:62-64,57` | ✅ |
| 10.5 | `quantity-input` / `quantity-increase` / `quantity-decrease` | `product.html:70,73,68` | ✅ |
| 10.6 | `add-to-cart` / `add-to-cart-success` | `product.html:77,81` | ✅ |
| 10.7 | `detail-loading` / `detail-not-found` / `detail-error` | `product.html:33,43,49` | ✅ |
| 10.8 | `cart-list` | `cart.html:53` | ✅ |
| 10.9 | `cart-item` + `data-product-id` | `cart.js:60-61` | ✅ |
| 10.10 | `cart-item-name` / `-price`(단가) / `-quantity` / `-total`(줄합계) | `cart.js:85,90,108,132` | ✅ |
| 10.11 | `cart-item-increase` / `-decrease` / `-remove` | `cart.js:114,99,126` | ✅ |
| 10.12 | `cart-summary` / `cart-total-quantity` / `cart-total-price` | `cart.html:56,60,65` | ✅ |
| 10.13 | `cart-loading` / `cart-empty` / `cart-error` | `cart.html:33,39,45` | ✅ |

**이름을 임의로 바꾼 것 0건.** 추가된 것 1개(`add-to-cart-error`)는 §4 I4.

### 3.7 1차 회귀 (재확인)

| 항목 | 판정 |
|---|---|
| 1.1~1.3 카드 8개·이미지/이름/가격·`19,000원` 포맷 | ✅ 실브라우저 8개 카드, 가격 8종 전부 정확 |
| 1.4 이미지 실패 시 레이아웃 유지 | ✅ `app.js:107-109` `is-broken` 경로 그대로 |
| 1.5 375px 레이아웃 | ✅ 3화면 모두 가로 스크롤 없음(`scrollWidth=375`), 목록은 1열 8행·카드 겹침 0·카드 폭 343px |
| 2.1~2.4 로딩/빈/에러 배타 | ✅ `?simulate=empty` → `empty-state` 하나만+카드 0개, `?simulate=error` → `error-state` 하나만 |
| 3.1~3.5 목록 API | ✅ `["items"]`, `isArray:false`, 8개, 5필드 전부 존재, `price` 정수 |
| 4.1~4.4 선택자 | ✅ 위치·이름 불변(링크 삽입으로 이동하지 않음) |
| 카드 → 상세 URL 매핑 | ✅ 8개 href가 실제 상품 id `p1`~`p8`과 정확히 일치 |
| 콘솔 에러 | ✅ 3화면 정상 경로 0건 |

---

## 4. 발견 사항 (Minor 2 / 정보성 3)

### [Minor] M4 — 쿠키 최초 발급 경쟁 조건: 첫 방문에서 동시 요청 시 장바구니가 갈릴 수 있다

- 위치: `server.js:136-148` `ensureCartId()` ↔ `product.js:234-235`(`loadProduct()`와 `refreshBadge()`가 동시에 출발)
- 문제: 서버는 쿠키가 없는 **모든** 장바구니 요청마다 새 `cartId`를 발급한다. 쿠키가 아직 없는 첫 방문자가 **두 개의 장바구니 요청을 동시에** 보내면 서로 다른 UUID 두 개가 발급되고, 브라우저는 나중에 도착한 `Set-Cookie` 하나만 보관한다. 담기가 A 장바구니에 들어갔는데 브라우저가 B를 들고 다니면 **담은 상품이 사라진 것처럼 보인다.**
- 재현(실측): 쿠키 없이 `GET /api/cart`와 `POST /api/cart/items`를 동시에 실행 → `Set-Cookie: cartId=83393298-…` / `cartId=9652b7a7-…` **서로 다른 두 개** 발급 확인.
- 실제 도달 경로: (a) 첫 방문이 `/product.html`로 바로 진입한 뒤 배지용 `GET /api/cart` 응답이 오기 전에 "담기"를 누르는 경우, (b) 첫 방문에서 카드를 새 탭으로 여러 개 동시에 여는 경우. 로컬(RTT 수 ms)에서는 창이 매우 좁아 이번 검증의 정상 흐름에서는 재현되지 않았고, 이후 요청은 한 쿠키로 수렴하므로 **영구 손상은 아니다.** 그래서 Minor.
- 수정 방향(둘 중 하나면 충분): ① 서버가 `public/*.html` 정적 응답 시점에도 `cartId`를 발급하도록 미들웨어를 하나 두어 **첫 API 요청 전에 쿠키가 이미 존재**하게 한다(권장 — 프론트 무수정). ② `product.js`에서 `refreshBadge()`가 끝나기 전까지 `add-to-cart`를 `disabled`로 둔다(프론트만 수정하나 첫 클릭이 늦어짐). **어느 쪽이든 한쪽만 고치고 반대편에 알리지 않으면 다음 사이클에 재발한다.**

### [Minor] M5 — 장바구니 경로의 500 에러 문구가 "상품 목록을 불러오지 못했습니다."

- 위치: `server.js:394-398`(공용 에러 핸들러) ↔ `cart.js:188` / `cart-badge.js:85`(서버 `error.message`를 사용자에게 그대로 표시)
- 문제: `/api/*`에서 예외가 나면 경로와 무관하게 항상 `{"error":{"message":"상품 목록을 불러오지 못했습니다."}}`를 반환한다. 프론트는 계약대로 이 문구를 그대로 화면에 그리므로, **장바구니 화면 에러 영역에 "상품 목록을 불러오지 못했습니다"가 뜬다.** 실증: `GET /api/cart`를 500으로 갈아끼운 실행에서 `cart-error` 본문이 정확히 그 문구였다.
- shape(PRD 9.13)은 위반이 아니고 정상 동작에서는 노출되지 않으므로 Minor.
- 수정 방향: 에러 핸들러에서 요청 경로로 문구를 나누거나(`/api/cart*` → "장바구니 요청을 처리하지 못했습니다.") 중립 문구("요청을 처리하지 못했습니다.")로 바꾼다. 프론트는 수정 불필요.

### [정보] I3 — `carts` Map이 단조 증가한다 (이번 범위에서는 결함 아님)

- 위치: `server.js:151-158` `getCartItems()`
- 쿠키 없는 요청이 올 때마다 새 `cartId` 엔트리(빈 배열)를 만들고 **아무것도 지우지 않는다.** 크롤러·헬스체크·QA 반복 실행마다 엔트리가 쌓인다. PRD Out of scope에 "장바구니 TTL/만료 정리 배치"가 명시되어 있고 프로세스 재시작으로 초기화되므로(D6/8.7) **이번 사이클 결함이 아니다.** 다음 사이클에 DB/영속화를 넣을 때 TTL과 함께 다뤄야 할 항목으로만 기록한다.

### [정보] I4 — `data-testid="add-to-cart-error"` 추가 (product-planner 승인 필요)

- 위치: `product.html:83`. PRD 10.6에는 성공 앵커만 있고 실패 앵커가 없어 frontend-agent가 6.7 검증용으로 추가했다(`03_frontend_screens.md:409`에서 이미 신고). **PRD가 정한 이름은 하나도 바뀌지 않았고 추가만 됐다.** QA 관점에서는 6.7 검증에 실제로 유용했으므로 **유지 권고.** planner 승인만 필요.

### [정보] I5 — 장바구니 "다시 불러오기" 버튼 (product-planner 승인 필요)

- 위치: `cart.html:49` `#cart-retry`. 7.9의 상태 배타성 때문에 조작 실패 시 목록이 숨겨지므로 복구 수단으로 추가됐다(`03_frontend_screens.md:410`에서 신고). 결제 버튼이 아니므로 7.10과 무관하고, 실측에서 실패 후 서버 실제 상태로 복구되는 것을 확인했다. **유지 권고.**
- 함께 기록: 조작(PATCH/DELETE) 실패 시 화면이 통째로 `cart-error`로 대체되어 담긴 목록이 잠시 사라진다. 이는 PRD 7.9(4상태 배타) 준수의 결과이며 사양 위반이 아니다. 다음 사이클에 "인라인 에러 + 목록 유지"로 바꾸고 싶다면 **PRD 7.9부터 고쳐야 한다.**

---

## 5. 회귀 위험 (다음 사이클에 코드를 건드릴 때 주의)

| 위험 지점 | 내용 |
|---|---|
| `cart-badge.js:62-74` `mapCartResponse()` | **두 겹(`cart.items`)을 벗기는 유일한 지점.** 이 함수 밖에서 `body.cart`를 직접 읽는 코드가 새로 생기면 이번 사이클에 버그가 0건이었던 이유가 사라진다. 특히 `app.js`의 `mapProductListResponse()`(한 겹)를 장바구니에 재사용하려는 유혹이 가장 위험하다 |
| `cart.js`에 산술이 없다는 사실 | `lineTotal`/`totalQuantity`/`totalPrice`를 프론트에서 한 줄이라도 계산하기 시작하면 PRD 7.6/9.8 위반이며, 서버 값과 어긋났을 때 어느 쪽이 정답인지 판정 불가능해진다. `quantity ± 1`(PATCH 절대값 계산)만 허용된 산술이다 |
| `cart.js:104` / `cart.js:224` 이중 방어 | 둘 중 하나만 남기면 `PATCH {"quantity":0}`이 나가는 경로가 부활한다(서버는 400으로 막지만 사용자에게 에러 화면이 뜬다). 상세의 `product.js:90`/`:98`도 같은 쌍이다 |
| `styles.css:43` `[hidden]{display:none!important}` | 1차 리포트에 이어 여전히 **삭제 금지.** 이번 사이클에 `.cart-link__count`(`display:inline-flex`), `.lines`/`.summary`(`display:grid`/`flex`)가 추가되어 이 한 줄에 의존하는 요소가 더 늘었다. 지우면 5.5(배지 숨김)와 7.7(요약 숨김)이 즉시 깨진다 |
| `server.js:377-381` `/api` catch-all 순서 | 신규 라우트를 이 아래에 등록하면 전부 404가 된다. 결제 엔드포인트를 추가할 다음 사이클에 가장 밟기 쉬운 함정 |
| `server.js:262-279` 검증 순서(400 → 404) | 스펙 §2D에 문서화된 순서다. 뒤집으면 "없는 상품 + 잘못된 수량" 요청의 상태 코드가 달라져 프론트 분기(`product.js:210`의 404 전용 처리)와 어긋난다 |

---

## 6. 미검증 항목

없음. `03_frontend_screens.md:393-403`이 "브라우저 확인 필요"로 남긴 6개 항목을 이번 QA에서 **전부 실브라우저로 확인**했다.

- 실제 픽셀 렌더(상세 2단, 장바구니 줄 정렬, 배지 위치): 1280px 스크린샷 3장 확보 — 깨진 곳 없음
- 375px 모바일: 3화면 모두 가로 스크롤 없음, 상세는 1단, 장바구니 줄은 접힘, 목록은 1열 8행·겹침 0
- 실제 쿠키 왕복 + 브라우저 2개 격리(8.5): Chromium 컨텍스트 2개로 확인 — 2번째는 빈 장바구니, 1번째는 유지
- 실제 F5 새로고침 유지(8.3): 확인
- 카드 링크의 새 탭/뒤로가기: 실제 `<a href>` 이동으로 URL 변경 확인(`onclick` 아님)
- 담기 성공 문구 5초 자동 소멸(`product.js:19`): 확인. **테스트 자동화는 5초 안에 단언해야 한다** — 자동화 편의를 위해 늘리고 싶다면 `SUCCESS_VISIBLE_MS` 한 곳만 고치면 된다

---

## 7. 양쪽 에이전트에게 전달할 사항 (2차)

- **backend-agent**: 경계면 불일치 회신 **0건**. `02_backend_api-spec.md` §2A~§2G의 shape·상태코드·검증 규칙·쿠키 속성이 실서버 응답과 **전부 일치**했고, §5-2의 자기보고 수치도 재실행 결과와 같았다(과장 0건). 조치 요청 2건: **M4(쿠키 최초 발급 경쟁 — 정적 HTML 응답에서 쿠키를 미리 발급하는 방식 권장)**, **M5(장바구니 경로의 500 문구가 "상품 목록…")**. I3(Map 단조 증가)는 이번 범위 결함이 아니므로 다음 사이클 메모로만.
- **frontend-agent**: 경계면 불일치 회신 **0건**. 특히 **세 가지 래핑 깊이를 서로 다른 파일·다른 이름의 함수로 분리한 결정이 이번 사이클 Critical 0건의 직접적 원인**이다(§2.1). `03_frontend_screens.md` 12.2의 자기보고는 재실행으로 전부 재현됐다(과장·누락 0건). 조치 요청 없음. M4의 대안 ②(배지 로드 전 담기 버튼 비활성화)를 택할 경우에만 `product.js` 수정이 필요하며, 그때는 backend와 합의 후 한쪽만 고칠 것.
- **product-planner**: 승인 요청 2건 — I4(`add-to-cart-error` 선택자 추가, 유지 권고), I5(장바구니 "다시 불러오기" 버튼, 유지 권고). 둘 다 PRD 이름을 바꾸지 않고 추가만 한 것이며 QA 검증에 실제로 유용했다.

---

## 변경 이력 (누적)

| 날짜 | 변경 내용 |
|---|---|
| 2026-08-05 | 최초 작성 — PRD 1.1~1.6 / 2.1~2.4 / 3.1~3.6 / 4.1~4.4 전수 검증. 실서버 curl + Chromium 실렌더 교차 검증. Critical 0 / Important 0 / Minor 3 |
| 2026-08-08 | **2차 사이클 검증 추가** — PRD 5.1~5.7 / 6.1~6.12 / 7.1~7.10 / 8.1~8.7 / 9.1~9.13 / 10.1~10.13 전수 + 1차 회귀. 실서버 curl(쿠키 항아리 2개) + DOM 스텁 위 실코드 실행 83건 + Chromium 실조작 25건. **최대 위험이었던 응답 깊이 불일치는 실제 버그 아님.** Critical 0 / Important 0 / Minor 2 + 정보성 3 |

---
---

# QA 검증 리포트 — 3차 사이클 (장바구니 비우기 + 수량 기반 자동 할인)

> 작성: qa-agent / 2026-08-09
> 대상: PRD 11~14장, API 스펙 §2H/§2I + 🚨 배너, 프론트 15~22절
> 입력 코드: `server.js`(`buildCartLine`/`buildCartSnapshot`/`DELETE /api/cart`/에러 핸들러), `public/cart.html`, `public/cart.js`, `public/cart-badge.js`, `public/styles.css`
> 범위 밖: 결제/체크아웃 (PRD 13.8 — 미구현 확인만 함)

## 결론 (3차)

**Critical 0건 / Important 0건 / Minor 1건 / 정보성 2건.**
3차 범위(비우기 + 수량 할인)는 **PRD·스펙 대비 전 항목 통과**다. 이번 사이클 최대 위험으로 양쪽 에이전트가 독립적으로 지목한 **9-vs-10 경계 함정**과 **`lineTotal` 의미 변경 회귀**는 둘 다 **실서버 + 실브라우저로 직접 재현해 정상 동작을 확인**했다.

| 구분 | 건수 | 내용 |
|---|---|---|
| Critical | **0** | — |
| Important | **0** | — |
| Minor | **1** | M6 — 비우기 실패 시 줄·합계가 DOM엔 남지만 **화면에서는 가려진다** (PRD 11.6 문면 대비) |
| 정보성 | **2** | I6 — `'10개 이상 '` 문구 상수의 드리프트 여지(기획 결정 대기) / I7 — **M4 근본 원인은 여전히 미수정**(재발은 없음) |

**과거 버그 재발 여부 (우선순위 0):** **M4 재발 없음 / M5 실제로 수정됨(검증 완료) / M2 규칙대로 준수됨.** 상세는 §1.

## 1. 우선순위 0 — `docs/bug-history/` 재발 검증 (검증 시작 전 수행)

3개 문서를 전부 읽고, 각 문서의 **"왜 다시 터질 수 있는가"** 에 적힌 패턴이 3차 새 코드에 실제로 나타났는지 확인했다. 자기보고를 믿지 않고 전부 직접 재현했다.

### BUG-2026-08-08-01 (M4, 쿠키 최초 발급 경쟁 조건) — **재발 없음**

문서가 지목한 재발 조건: *"페이지 로드 시 여러 곳에서 각자 쿠키/세션 관련 API를 병렬 호출하는 패턴이 새로 생기면 재발한다."*

**확인 방법 — 실브라우저(Chromium)에서 신규 컨텍스트(쿠키 0개)로 3개 화면을 각각 로드하고, 네트워크 요청을 전수 기록해 `cartId`를 발급하는 요청(=`ensureCartId`를 타는 `/api/cart*`) 개수를 셌다.**

| 화면 | 로드 시 발생한 `/api/*` 요청 | 쿠키 발급 경로(`/api/cart*`) 개수 | 판정 |
|---|---|---|---|
| `/` (목록) | `GET /api/products`, `GET /api/cart` | **1** | ✅ |
| `/product.html?id=p1` (상세) | `GET /api/products/p1`, `GET /api/cart` | **1** | ✅ |
| `/cart.html` (장바구니) | `GET /api/cart` | **1** | ✅ |

- `GET /api/products` / `GET /api/products/:id`는 `server.js`에서 `ensureCartId()`를 호출하지 않으므로 쿠키를 발급하지 않는다 (코드 확인: `server.js:64`, `server.js:267` — 둘 다 `ensureCartId` 미호출). 따라서 로드 시 **쿠키를 발급할 수 있는 요청은 화면당 정확히 1개**다.
- **3차가 새로 추가한 호출은 사용자 클릭에서만 발생하는 `DELETE /api/cart` 1건뿐**이고, 페이지 로드 경로에는 요청이 하나도 늘지 않았다. 할인은 기존 스냅샷 응답에 필드가 추가된 것이라 호출 자체가 없다.
- 비우기 성공 후 배지 갱신도 **같은 응답의 `cart.totalQuantity`를 재사용**한다 (`cart.js:200` → `HaruCart.updateBadge(cart.totalQuantity)`). 배지용 `GET /api/cart`를 따로 쏘지 않는 것을 요청 로그로 확인했다 — 비우기 클릭 시 발생한 요청은 **정확히 1건**(`DELETE /api/cart`).

> **I7 (정보성): M4의 근본 원인은 여전히 살아 있다.** `ensureCartId()`(`server.js:146-158`)는 2차와 동일한 요청 단위 로직 그대로다. 실제로 쿠키 없이 `/api/cart`를 **5개 동시** 요청하면 지금도 **서로 다른 `cartId` 5개가 발급된다**(직접 재현함). 이번 사이클이 그 조건을 새로 만들지 않아 재발하지 않았을 뿐이며, **결제 화면처럼 진입 시 병렬 호출이 생기는 다음 기능에서 즉시 재발한다.** bug-history 문서의 `status: not-fixed`는 그대로 두는 것이 맞다.

### BUG-2026-08-08-02 (M5, 공용 에러 핸들러 문구) — **수정됨 (직접 검증)**

backend-agent가 "경로별 분기로 고쳤다"고 자기보고했으므로, **자기보고를 쓰지 않고 실제로 500을 강제 발생시켜** 확인했다. (`?simulate=error` 훅은 `/api/products`에만 있으므로, 장바구니 경로는 `Cookie: cartId=%E0%A4%A`(깨진 퍼센트 인코딩)로 `parseCookies()`의 `decodeURIComponent`가 던지게 만들어 **진짜 예외 → 공용 500 핸들러 경유**를 만들었다.)

| 강제한 요청 | 실제 응답 | 판정 |
|---|---|---|
| `GET /api/cart` (깨진 쿠키) | `500` `{"error":{"message":"장바구니 요청을 처리하지 못했습니다."}}` | ✅ 수정 확인 |
| `DELETE /api/cart` (깨진 쿠키) | `500` 동일 문구 | ✅ **3차 신규 엔드포인트도 올바른 문구** |
| `DELETE /api/cart/items/p1` (깨진 쿠키) | `500` 동일 문구 | ✅ |
| `POST /api/cart/items` (깨진 쿠키) | `500` 동일 문구 | ✅ |
| `GET /api/products?simulate=error` | `500` `{"error":{"message":"상품 목록을 불러오지 못했습니다."}}` | ✅ **회귀 없음 — 1차 문구 그대로** |
| `POST /api/checkout` (미정의) | `404` `존재하지 않는 API 경로입니다.` | ✅ (500 핸들러 이전에 catch-all이 잡음) |

- 구현 위치: `server.js:484-504`. `req.path` 접두사로 `/api/products` → 상품 문구, `/api/cart` → 장바구니 문구, 그 외 `/api/*` → 중립 문구(`요청을 처리하지 못했습니다.`)로 분기한다. bug-history의 수정 방향 ①과 ②를 **둘 다** 적용한 형태여서, 다음 사이클에 `/api/checkout`이 추가돼도 문구가 틀리지 않는다(최악이라도 중립 문구).
- **상태 코드(500)와 응답 shape(`{ error: { message } }`)은 바뀌지 않았다** — 기존 프론트 `readErrorMessage()`(`cart-badge.js:46`)가 그대로 동작한다.
- **엔드투엔드 확인:** 장바구니 화면에서 `DELETE /api/cart`가 500을 받도록 가로채자, 화면 본문에 서버 문구 `장바구니 요청을 처리하지 못했습니다.`가 그대로 노출됐다. (bug-history M1의 "백엔드가 상황별 문구를 보내기 시작하면 프론트도 같이 노출해야 한다"도 충족.)

### BUG-2026-08-NOTES (M2, DOM 존재 ≠ 보임) — **규칙대로 준수, 본 리포트도 그 규칙으로 단언함**

이번 사이클은 M2의 교훈이 **사양 자체**로 들어왔다(PRD 14.4의 ⚠️ 주석이 M2를 명시적으로 인용). 두 규칙이 **서로 반대**이므로 단언 방식을 나눴다.

| 요소 | 요구 규칙 | 본 QA의 단언 방식 | 결과 |
|---|---|---|---|
| `cart-clear` | 빈 장바구니에서도 **DOM에 존재 + `hidden`** | `count() === 1` **그리고** `isVisible() === false` 를 **각각** 단언 | ✅ |
| `cart-item-discounted-price` / `cart-item-discount-notice` | 미할인 줄에서 **DOM에 부재** | `count() === 0` (가시성이 아니라 **존재 개수**로 단언) | ✅ |

M3(이미지 에러 리스너 순서)은 3차에서 변경 없음(`cart.js:84`의 리스너 등록 순서가 2차 그대로). M1은 위 M5 항목에서 함께 충족됐다.

## 2. 이번 사이클 최대 위험 2종 — 실측 교차 검증

### 2.1 🔴 9-vs-10 경계 함정 (PRD 12.2 / 스펙 §2H 경계값 표) — **통과**

**함정의 구조:** `price=19000`에서 수량 9와 10의 `lineTotal`이 **둘 다 정확히 171,000원**이다. 총액이나 화면 금액만 보고 단언하면 경계가 한 칸 밀린 구현(`> 10`)이 **소리 없이 통과**한다.

실서버 curl 실측(쿠키 항아리 유지):

```bash
curl -s -c jarQ.txt -b jarQ.txt -X POST http://localhost:3000/api/cart/items \
  -H 'Content-Type: application/json' -d '{"productId":"p1","quantity":9}'
```
```json
{"cart":{"items":[{"productId":"p1","name":"베이직 코튼 티셔츠","price":19000,"imageUrl":"/images/p1.svg",
"quantity":9,"lineSubtotal":171000,"discountApplied":false,"discountPercent":0,
"discountedUnitPrice":19000,"discountAmount":0,"lineTotal":171000}],
"totalQuantity":9,"totalPrice":171000}}
```
```bash
curl -s -c jarQ.txt -b jarQ.txt -X PATCH http://localhost:3000/api/cart/items/p1 \
  -H 'Content-Type: application/json' -d '{"quantity":10}'
```
```json
{"cart":{"items":[{"productId":"p1","name":"베이직 코튼 티셔츠","price":19000,"imageUrl":"/images/p1.svg",
"quantity":10,"lineSubtotal":190000,"discountApplied":true,"discountPercent":10,
"discountedUnitPrice":17100,"discountAmount":19000,"lineTotal":171000}],
"totalQuantity":10,"totalPrice":171000}}
```

| 요구 단언 | 수량 9 | 수량 10 | 판정 |
|---|---|---|---|
| `discountApplied` | **`false`** | **`true`** ← 뒤집힘 | ✅ |
| `lineTotal` | `171000` | **`171000`** (같음) | ✅ 함정 재현됨 |
| `discountedUnitPrice` | `19000` | **`17100`** | ✅ |
| `lineSubtotal` | `171000` | **`190000`** | ✅ |
| `discountAmount` | `0` | `19000` | ✅ |

**"총액만 검사하고 `discountApplied`를 안 봐서 틀린 구현이 통과할" 가능성이 있었는가 — 결론: 구조적으로 없다.**
- **서버 측:** 판정식은 `server.js:195`의 `quantity >= DISCOUNT_MIN_QUANTITY` **단 한 줄**이고, `buildCartLine()` 한 곳에서만 계산되어 5개 엔드포인트가 이를 공유한다(`buildCartSnapshot()` `server.js:235-245`). 상수는 `server.js:105-106`에 각각 한 번만 나온다. `> 10`이나 `>= 11` 같은 중복 판정식은 코드 전체에 **존재하지 않는다**(grep 0건).
- **프론트 측:** 화면의 유일한 분기가 `cart.js:160`의 `if (item.discountApplied)`다. 즉 **화면 표시가 금액이 아니라 boolean 필드에 직접 매여 있어**, 경계가 한 칸 밀리면 금액은 같아도 **할인 UI 2요소의 존재/부재가 즉시 어긋난다.** 실제로 그 어긋남을 검출할 수 있는지 확인하려고 **DOM 존재 개수로** 단언했다(§2.2 표 E5~E7 / D1~D2).
- **본 QA의 단언 자체도 금액을 근거로 쓰지 않았다.** 브라우저 단언 62건 중 할인 여부 판정은 전부 `discountApplied` 필드 값 + 요소 개수(`count()`)로 했다.
- **전수 검증:** 상품 8개 × 수량 1~99 = **792줄**에 대해 `discountApplied == (quantity >= 10)`를 포함한 불변식 9종을 스크립트로 전수 대조 → **위반 0건**. 경계가 한 칸이라도 밀렸다면 `quantity=10` 792/99×1 = 8줄에서 즉시 잡혔을 것이다.

### 2.2 🔴 `lineTotal` 의미 변경 회귀 (스펙 🚨 배너 / PRD 12.12) — **통과, 코드 무수정이 정답이었음**

**주장:** "2차 코드가 `lineTotal`을 그대로 읽고 있었으므로, 프론트를 한 글자도 안 고쳐야 자동으로 할인 금액이 표시된다."

**리터럴 코드 확인 (주장 검증):**

```js
// public/cart.js:147-150  ← 2차와 동일, 3차에 미수정
var total = document.createElement('p');
total.className = 'line__total';
total.setAttribute('data-testid', 'cart-item-total');
total.textContent = item.lineTotalText;
```
```js
// public/cart-badge.js:72-74  ← 화면 모델이 참조하는 서버 필드
// ⚠ 3차부터 lineTotal = 할인 후 최종 금액.
lineTotal: Number(item.lineTotal),
lineTotalText: formatPrice(item.lineTotal)
```

`cart-item-total`이 읽는 값은 **여전히 `item.lineTotal`**이며, 새 필드(`lineSubtotal` 등)로 바뀌지 않았다. `lineSubtotal`은 `cart-badge.js:66`에서 화면 모델에 담기기만 하고 **어디에도 출력되지 않는다**(grep: `public/*.js`에서 `lineSubtotal` 출현은 주석 1 + 매핑 1, 렌더 0건).

**실브라우저 실측 (할인 걸린 장바구니):**

| 화면 요소 | 표시된 값 | 서버 필드 | 판정 |
|---|---|---|---|
| `cart-item-price` | `19,000원` (+ 계산된 `text-decoration-line: line-through`) | `price` (원가, 안 깎임) | ✅ 10.10/14.5/14.6 |
| `cart-item-discounted-price` | `17,100원` | `discountedUnitPrice` | ✅ 14.2 |
| `cart-item-total` | **`171,000원`** | `lineTotal`(할인 후) | ✅ **`lineSubtotal`의 190,000원이 아님** |
| `cart-total-price` | `171,000원` | `totalPrice` | ✅ 12.6 |
| 페이지 전체 텍스트 | `190,000` 문자열 **미출현** | — | ✅ 12.12 (취소선은 단가 자리 한 곳뿐) |

수량 11로 올려 값이 갈라지는 구간도 확인: `cart-item-total` = **`188,100원`** (할인 전 209,000원이 아니고, "초과분만 할인" 오구현이었다면 나왔을 값도 아님). ✅

## 3. PRD 요구사항별 판정 (11~14장)

### 11장 — 장바구니 전체 비우기

| # | 요구사항 | 검증 방법 | 판정 |
|---|---|---|---|
| 11.1 | 버튼 존재 + `DELETE /api/cart` **1회** (줄 단위 반복 금지) | 실브라우저에서 버튼 클릭 → 네트워크 요청 전수 기록: **총 1건**, 내용 `DELETE /api/cart`, `/api/cart/items` 요청 **0건** | ✅ |
| 11.2 | 새로고침 없이 즉시 7.7 빈 상태, `cart-summary` 숨김 | 클릭 후 리로드 없이 `cart-empty` 표시, 줄 0개, `cart-summary` 비가시 | ✅ |
| 11.3 | 배지 0 + 숨김, 값은 응답 `totalQuantity` | 배지 텍스트 `0`, `isVisible()==false`. 배지용 추가 요청 없음 | ✅ |
| 11.4 | 확인 다이얼로그 금지 (D10) | Playwright `dialog` 이벤트 리스너를 세션 전체에 걸어둠 — **한 번도 발화하지 않음**. 소스 grep도 `confirm`/`alert`/`prompt` 호출 0건(주석 1건만) | ✅ |
| 11.5 | 0개일 때 버튼은 **DOM 존재 + hidden**, 1개 이상이면 표시 | 빈 상태: `count()==1` && `isVisible()==false` / 1줄: `isVisible()==true` (M2 규칙대로 분리 단언) | ✅ |
| 11.6 | 실패 시 에러 표시 + 줄·합계 유지, 낙관적 갱신 금지 | `DELETE /api/cart`를 네트워크 실패로 가로챔 → 에러 표시, 줄 2개 **DOM에 그대로**, 서버 `totalQuantity=14` 불변, `cart-empty` 미표시 | ✅ (단 **M6** 참고) |
| 11.7 | 서버 상태를 실제로 비움 (F5·화면 이동 후에도) | 비운 뒤 `GET /api/cart` → 빈 스냅샷 / F5 후 빈 상태 / `/` 경유 후 복귀해도 빈 상태 | ✅ |
| 11.8 | 비우기 버튼은 장바구니 화면에만 | `/`와 `/product.html`에서 `cart-clear` **count 0** | ✅ |

### 12장 — 수량 기반 자동 할인

| # | 요구사항 | 검증 방법 | 판정 |
|---|---|---|---|
| 12.1 | `quantity >= 10`이면 10% 자동 적용, 사용자 조작 없음 | 792줄 전수 + 브라우저 실조작 | ✅ |
| 12.2 | **경계 `>= 10`** (9 미적용 / 10 적용) | §2.1 (curl + 브라우저 + 792줄 전수) | ✅ |
| 12.3 | 줄 **전체**에 적용 (초과분만 아님) | `19000 × 10` → `lineTotal 171000`. 오구현 값 `188100`이 아님 | ✅ |
| 12.4 | 줄 단위 독립 판정 | p1×6 + p7×5 (총 11) → **두 줄 다 `false`** / p1×10 + p7×1 → p1만 `true` | ✅ |
| 12.5 | 계산식·버림·정수 | 792줄 전수로 `lineSubtotal==price*q`, `lineTotal==dup*q`, `discountAmount==lineSubtotal-lineTotal`, 전 금액 필드 정수 → 위반 0 | ✅ |
| 12.6 | `totalPrice`는 할인 반영 합, `totalQuantity`는 무관 | p1×10 + p7×1 → `totalPrice 260000`(할인 전 279000 아님), `totalQuantity 11` | ✅ |
| 12.7 | PATCH로 켜짐/꺼짐 | 브라우저 ± 버튼: 9→10 켜짐, 11→10→9 꺼짐. 9로 내리면 할인 요소 2개가 **DOM에서 사라짐**(hidden 아님), 취소선도 `none`으로 복귀 | ✅ |
| 12.8 | 담기 합산으로 10 도달 | 상세 화면에서 6개 담고 4개 더 담기 → 장바구니에서 할인 표시, `17,100원`/`171,000원` | ✅ |
| 12.9 | 할인 줄에 3가지 모두 표시 | 취소선(계산된 `line-through`) + `17,100원` + `10개 이상 10% 할인 적용` | ✅ |
| 12.10 | 미할인 줄엔 3가지 모두 없음 (**DOM 부재**) | `count()==0` × 2, 취소선 `textDecorationLine === 'none'` | ✅ |
| 12.11 | 판정 근거는 `discountApplied` 하나뿐 | `cart.js:160`이 유일 분기. `cart.js` 전체에서 수량 비교는 `MIN_QTY(1)`/`MAX_QTY(99)`뿐 — **`>= 10` 계열 0건** (§4) | ✅ |
| 12.12 | 줄 합계엔 `lineTotal` 하나만 | §2.2 — `190,000` 문자열 페이지 전체 미출현 | ✅ |
| 12.13 | 금액 포맷 | `171,000원` / `17,100원` / `188,100원` — 소수점 없음 | ✅ |
| 12.14 | 상세 화면엔 할인 UI 없음 | 상세에서 수량 10 담은 뒤에도 할인 선택자 count 0 | ✅ |
| 12.15 | 상수는 서버 한 곳, 문구 숫자는 `discountPercent` | `server.js:105-106`에 각 1회. 프론트는 `item.discountPercent`로 문구 생성(`cart.js:172`) | ✅ (I6 참고) |

### 13장 — API

| # | 요구사항 | 검증 | 판정 |
|---|---|---|---|
| 13.1 | `DELETE /api/cart` → **200 + 빈 스냅샷** (204 아님) | `HTTP=200`, body `{"cart":{"items":[],"totalQuantity":0,"totalPrice":0}}` | ✅ |
| 13.2 | 멱등 | 빈 장바구니에 3회 연속 호출 → 매번 200 + 동일 body. 400/404 없음 | ✅ |
| 13.3 | 쿠키 없이 호출해도 발급 + 빈 장바구니 | `Set-Cookie: cartId=...; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800` + 200 | ✅ |
| 13.4 | 라우팅 충돌 없음 | `/api/cart` 200 / `/api/cart/` 200 / `/api/cart/items/` **404** / `/api/cart/items` **404** / `/api/cart/items/p1`(없는 줄) **404 `장바구니에 해당 상품이 없습니다.`** — 전체 비우기로 새지 않음 | ✅ |
| 13.5 | 5개 엔드포인트가 동일 shape | 5개 전부 `cart` 키 = `['items','totalQuantity','totalPrice']` 정확히 3개 | ✅ |
| 13.6 | 모든 `CartItem`에 할인 필드 5개 항상 존재 | 792줄 전수 — 필드 11개가 **순서까지** 일치, 생략·`null` 0건. 미적용 줄 값도 규정대로 | ✅ |
| 13.7 | 서버 계산 8개 | 전수 불변식 위반 0. 프론트에 산술 0줄(§4) | ✅ |
| 13.8 | 총 7개, checkout/쿠폰 미구현 | `POST /api/checkout` → **404 `존재하지 않는 API 경로입니다.`** | ✅ |
| 13.9 | 기존 400/404 규격 유지 | `quantity:0`/`100` → 400 동일 문구, 없는 상품 → 404 동일 문구 | ✅ |

### 14장 — 테스트 선택자

| # | 요구사항 | 검증 | 판정 |
|---|---|---|---|
| 14.1 | `cart-clear` 존재, 0개일 때 hidden | 존재+hidden / 1개 이상 시 표시 | ✅ |
| 14.2 | `cart-item-discounted-price` = `discountedUnitPrice` 포맷 | `17,100원` | ✅ |
| 14.3 | `cart-item-discount-notice`, 숫자는 `discountPercent` | `10개 이상 10% 할인 적용` | ✅ |
| 14.4 | 두 요소는 **존재/부재**로 판정 | 할인 줄 1 + 정가 줄 1 → 각 요소 count **정확히 1** (= 할인 줄 수) | ✅ |
| 14.5 | 원가 취소선은 CSS, 판정 근거는 요소 존재 | `getComputedStyle().textDecorationLine`이 할인 줄에서 `line-through`, 미할인 줄에서 `none` (**단언 근거는 요소 존재로 사용**) | ✅ |
| 14.6 | 기존 4개 선택자 이름·위치·의미 불변 | `cart-item-price`는 여전히 원가(`19,000원`), `cart-item-total`은 여전히 `lineTotal` | ✅ |

## 4. 클라이언트 측 경계 재판정 금지 (PRD 12.11) — grep 전수

`public/cart.js` 전체에서 수량과 관련된 비교 연산은 아래 5곳이 전부다.

```
119:    dec.disabled = item.quantity <= MIN_QTY;      // MIN_QTY = 1
132:    inc.disabled = item.quantity >= MAX_QTY;      // MAX_QTY = 99
213:    for (var i = 0; i < buttons.length; i++)      // 루프 인덱스
266:      if (quantity >= MAX_QTY) return;            // 99
273:      if (quantity <= MIN_QTY) return;            // 1
```

- **`>= 10` / `> 10` / `quantity >= DISCOUNT...` 형태의 독립 판정 0건.** 할인 경계를 프론트가 다시 정하는 코드는 없다.
- `cart.js`에 등장하는 숫자 `10`은 ① 문구 상수 `DISCOUNT_NOTICE_PREFIX = '10개 이상 '`(문자열, `cart.js:29`)와 ② `parseInt(..., 10)`의 진법뿐이다. **둘 다 조건 분기에 쓰이지 않는다.**
- 할인 산술도 0건: `price *`, `* 0.9`, `/ 100`, `Math.floor` — `cart.js`/`cart-badge.js`에서 **주석 외 출현 0건**. `cart-badge.js:56-76`의 `mapCartItem()`은 `Number()` 변환과 `formatPrice()` 포맷만 한다.
- `localStorage` / `sessionStorage` / `document.cookie` / `credentials` 사용 0건 (PRD D4 / 8.6 유지).

## 5. 발견 사항

### [Minor] M6 — 비우기 실패 시 줄·합계가 DOM엔 남지만 화면에서는 가려진다

- **위치:** `public/cart.js:49-60` `showOnly()` / `cart.js:227-240` `runMutation()`의 `.catch` → `showError()`
- **문제:** PRD 11.6은 *"실패하면 에러 메시지가 표시되어야 하며, **화면의 줄과 합계는 비우기 전 상태 그대로 유지되어야 한다**"* 로 적혀 있다. 실제 구현은 낙관적 갱신을 하지 않으므로 **줄 2개와 합계가 DOM에 그대로 보존**되지만(11.6의 핵심 의도는 충족), 상태 배타성 규칙(7.9)에 따라 `showOnly('error')`가 `cart-list`와 `cart-summary`를 `hidden` 처리해 **화면에서는 줄·합계가 사라져 보인다.** 실측: 실패 직후 `cart-list.isVisible() === false`.
- **재현:** 장바구니에 2줄을 담고 `DELETE /api/cart`를 네트워크 실패로 만든 뒤 비우기 클릭 → 에러 패널만 보이고 줄이 화면에서 사라짐.
- **왜 Critical/Important가 아닌가:** ① 서버 상태는 전혀 안 바뀌고(실측 `totalQuantity=14` 유지), ② 사용자에게 `장바구니를 비우지 못했습니다`라는 **조작별 제목**이 뜨므로 "비워졌다"고 오인할 여지가 없으며, ③ `cart-empty`("장바구니가 비어 있습니다")는 **표시되지 않고**, ④ "다시 불러오기"로 즉시 원상복구된다(실측: 줄 2개, 총액 `999,200원` 동일). PRD 11.6이 막으려던 실패 모드(*"서버가 안 비웠는데 화면만 비면 새로고침 시 상품이 되살아나 버그로 인식"*)는 발생하지 않는다.
- **수정 방향 (택1):** ① 조회 실패(`loadCart`)와 **변경 실패(mutation)** 를 구분해, 변경 실패 시에는 `cart-list`/`cart-summary`를 계속 표시한 채 에러를 **배너로 덧붙이는** 방식으로 바꾼다(상세 화면의 `add-to-cart-error`와 같은 패턴이 이미 있다). ② 또는 product-planner가 11.6의 "유지"를 "DOM 보존 + 서버 상태 불변"으로 명문화한다. **어느 쪽이든 2차부터 쓰던 `PATCH`/`DELETE` 실패 경로에도 동일하게 적용되므로, 프론트 단독 판단이 아니라 기획 확인 후 한 번에 바꿀 것.**

### [정보성] I6 — `'10개 이상 '` 문구 상수의 드리프트 여지 (기획 결정 대기)

- **위치:** `public/cart.js:29`
- 할인율은 `discountPercent`(서버값)를 쓰지만 **기준 수량 `10`은 응답에 없어서** 프론트 문구 상수에 남아 있다. **조건 분기에는 쓰이지 않으므로 12.11 위반이 아니고 판정이 두 벌이 되지도 않는다**(§4에서 확인). 다만 서버 `DISCOUNT_MIN_QUANTITY`가 바뀌면 문구만 낡는다.
- frontend-agent가 `03_frontend_screens.md` 22절에서 이미 product-planner에게 3안을 올려두었다. **QA 의견: 2안(문구에서 기준 수량 제거)이 응답값만으로 문구가 완성되어 드리프트가 원천 차단되므로 가장 안전하다.** 현 상태로도 이번 사이클 결함은 아니다.

### [정보성] I7 — M4 근본 원인 미수정 (§1 참조)

`ensureCartId()`는 2차와 동일하다. 쿠키 없는 상태의 **동시 5요청 → 서로 다른 `cartId` 5개**를 지금도 재현할 수 있다. 이번 사이클은 재발 조건을 만들지 않았을 뿐이다. **결제 화면처럼 "진입과 동시에 장바구니 재확인 + 다른 상태 확인"을 병렬로 호출하는 화면이 생기는 순간 재발한다.** bug-history의 권장 수정(정적 HTML 서빙 시점에 쿠키 선발급)은 프론트 수정 없이 적용 가능하다.

## 6. 회귀 검증 (1·2차)

| 항목 | 검증 | 판정 |
|---|---|---|
| `GET /api/products` | 200, `items` 8개, 키 `[id,name,price,imageUrl,description]` | ✅ |
| `GET /api/products/p1` / `nope` | 200 `{item:{...}}` / 404 `상품을 찾을 수 없습니다.` | ✅ |
| `?simulate=empty` / `?simulate=error` | `{"items":[]}` / 500 `상품 목록을 불러오지 못했습니다.` | ✅ |
| 랜딩 화면 | 실브라우저: `product-card` 8개 렌더 | ✅ |
| 상품 상세 | `detail-name` `베이직 코튼 티셔츠`, `detail-price` `19,000원` | ✅ |
| 담기(상세) | 6개 + 4개 담기 → 배지 `10`으로 갱신 | ✅ |
| 수량 ±(장바구니) | `PATCH` 절대 수량 전송, 화면 갱신 | ✅ |
| 줄 단위 삭제 | `DELETE /api/cart/items/p1` 1건 → 빈 상태 전환 | ✅ |
| 검증 에러 | `quantity:0`/`100` → 400 동일 문구, 없는 상품 → 404 | ✅ |
| 배지 | 서버 `totalQuantity` 그대로(12), 0이면 hidden | ✅ |
| 세션 격리 (8.5) | Chromium 컨텍스트 2개 — ctx2에서 비워도 ctx1의 2줄 유지 | ✅ |
| 정적 서빙 | `/` `/cart.html` `/product.html` `/cart.js` `/cart-badge.js` `/app.js` `/index.html` `/styles.css` 전부 200 | ✅ |
| 1·2차 파일 무변경 | `index.html`/`app.js`/`product.html`/`product.js` 타임스탬프 **2026-08-08** 그대로 | ✅ |

## 7. 검증 방법 (재현 가능)

1. **실서버 curl** — `http://localhost:3000`, 쿠키 항아리(`-c/-b`) 3개로 세션 분리. 9-vs-10 경계, `DELETE /api/cart` 멱등·쿠키·라우팅, 에러 문구, 1·2차 회귀.
2. **전수 불변식 스크립트** — 상품 8개 × 수량 1~99 = **792줄**. 필드 11개 순서, 5개 불변식, 정수성, `cart` 키 3개, `totalPrice==Σ lineTotal`, `totalQuantity==Σ quantity` → **위반 0건**.
3. **실브라우저(Chromium/Playwright)** — 신규 컨텍스트로 3개 화면 실조작. **네트워크 요청 전수 기록**(호출 횟수 단언용), **`dialog` 이벤트 상시 감시**(11.4용), `getComputedStyle()`(취소선), `count()` vs `isVisible()` **분리 단언**(M2 규칙). 총 **76건 단언, 실패 0건**.
4. **강제 실패 주입** — `page.route()`로 `DELETE /api/cart`만 네트워크 실패/500으로 가로채 11.6과 M5 엔드투엔드 확인. 서버 500은 깨진 쿠키 인코딩으로 **진짜 예외**를 발생시켜 확인(스텁 아님).
5. **소스 grep** — 금지 패턴(`confirm`/`alert`/`prompt`/`localStorage`/`document.cookie`/`credentials`/할인 산술/`>= 10` 재판정) 전수.

> 양쪽 에이전트의 자기보고(`02_...md` §5-3, `03_...md` 19절)는 **참고만 하고 전부 독립 재실행**했다. 재실행 결과와 자기보고 수치의 불일치·과장은 **0건**이다.

## 8. 미검증 항목

- **동시성 스트레스** — 같은 `cartId`로 `PATCH`와 `DELETE /api/cart`를 동시에 쏘는 경우의 최종 상태. 단일 프로세스 이벤트 루프라 실질 위험은 낮고 이번 범위 요구사항도 아니어서 미검증.
- **375px 모바일에서 할인 2줄 추가로 인한 세로 높이 변화** — 데스크톱 렌더만 확인. 가로 스크롤 유발 여부는 2차에서 통과한 레이아웃에 텍스트 2줄이 추가된 것뿐이라 위험 낮음.
- **`carts` Map 단조 증가** (2차 I3) — 이번 범위 밖. `DELETE /api/cart`가 배열만 비우고 Map 엔트리는 남기므로 상황은 2차와 동일하다.

## 9. 양쪽 에이전트에게 전달할 사항 (3차)

- **backend-agent**: 경계면 불일치 회신 **0건**. §2H/§2I의 shape·상태 코드·라우팅·멱등성이 실서버와 **전부 일치**했고, §5-3의 자기보고 수치도 재실행으로 그대로 재현됐다(과장 0). **M5 수정은 실제로 확인됨** — `/api/cart*` 500이 `장바구니 요청을 처리하지 못했습니다.`로, `/api/products` 500은 기존 문구 그대로 나갔다(양방향 확인). 남은 요청 1건: **M4 근본 수정**(정적 HTML 응답 시점 쿠키 선발급) — 결제 사이클 착수 **전에** 하는 것을 권장한다. 지금 안 고치면 결제 화면이 재발 1순위다.
- **frontend-agent**: 경계면 불일치 회신 **0건**. **`cart-item-total`을 고치지 않은 판단이 정답이었음을 실측으로 확인**했다(§2.2). 할인 UI를 `discountApplied` 단일 분기로 둔 것과, `cart-clear`(존재+hidden) vs 할인 요소(부재)를 규칙대로 나눈 것이 이번 사이클 Critical 0의 직접적 원인이다. 조치 요청 1건: **M6** — 단, **기획 확인 후** 조회 실패/변경 실패 분기를 함께 정리할 것(2차 경로에도 영향).
- **product-planner**: 결정 요청 2건 — ① **M6**: 11.6의 "줄과 합계 유지"를 *DOM 보존*으로 볼지 *화면 표시 유지*로 볼지 명문화 필요(7.9 상태 배타성과 충돌하는 지점). ② **I6**: 할인 문구의 기준 수량 처리(2안 권고). 둘 다 이번 사이클을 막는 결함은 아니다.

## 변경 이력 (누적)

| 날짜 | 변경 내용 |
|---|---|
| 2026-08-05 | 최초 작성 — PRD 1.1~1.6 / 2.1~2.4 / 3.1~3.6 / 4.1~4.4 전수 검증. 실서버 curl + Chromium 실렌더 교차 검증. Critical 0 / Important 0 / Minor 3 |
| 2026-08-08 | **2차 사이클 검증 추가** — PRD 5.1~5.7 / 6.1~6.12 / 7.1~7.10 / 8.1~8.7 / 9.1~9.13 / 10.1~10.13 전수 + 1차 회귀. 실서버 curl(쿠키 항아리 2개) + DOM 스텁 위 실코드 실행 83건 + Chromium 실조작 25건. **최대 위험이었던 응답 깊이 불일치는 실제 버그 아님.** Critical 0 / Important 0 / Minor 2 + 정보성 3 |
| 2026-08-09 | **3차 사이클 검증 추가** — 우선순위 0의 **bug-history 재발 검증(M4/M5/M2)을 먼저 수행**: M4 재발 없음(화면당 쿠키 발급 요청 1건 실측, 단 근본 원인 미수정 → I7), **M5는 강제 500으로 수정 확인 + `/api/products` 문구 회귀 없음**, M2는 사양화되어 존재/부재 분리 단언으로 준수. PRD 11.1~11.8 / 12.1~12.15 / 13.1~13.9 / 14.1~14.6 전수 + 1·2차 회귀. **9-vs-10 경계 함정**(curl 실측 + 792줄 전수 + 브라우저 요소 존재 단언)과 **`lineTotal` 의미 변경 회귀**(리터럴 코드 확인 + 실브라우저 금액 대조) 둘 다 통과. 실서버 curl + 전수 불변식 792줄(위반 0) + Chromium 실조작 단언 76건(실패 0). Critical 0 / Important 0 / **Minor 1(M6)** + 정보성 2(I6, I7) |

---

# QA 검증 리포트 — 4차 사이클 (모의 결제 — 외부 PG 미연동)

> 작성: qa-agent / 2026-08-10
> 대상: PRD 15~19장 + `Order` 데이터 모델, API 스펙 §2J/§2K/§5-4, 프론트 23~31절
> 입력 코드: `server.js`(`POST /api/checkout`, `GET /api/orders/:orderId`, `toOrderResponse`, 공용 500 핸들러), `public/checkout.html`, `public/checkout.js`, `public/order.html`, `public/order.js`, `public/cart.html`·`cart.js`(결제 진입 링크), `public/cart-badge.js`
> 검증 환경: `PORT=3456 node server.js` (실서버) + Chromium 실브라우저(Playwright 드라이버 직접 구동)
> 범위 밖(미구현 확인만): 실제 PG 연동, `GET /api/orders` 목록, 주문 취소/환불, 재고

## 결론 (4차)

**Critical 0건 / Important 0건 / Minor 1건 / 정보성 2건 + 회귀 테스트 자산 조치 1건.**

15~19장 전 요구사항이 **PRD·스펙 대비 통과**다. 자기보고를 그대로 받지 않고 **실서버 curl 40여 케이스 + 실브라우저 단언 48건(실패 0) + 375px 레이아웃 2건**을 QA가 독립적으로 재현했다.

| 구분 | 건수 | 내용 |
|---|---|---|
| Critical | **0** | — |
| Important | **0** | — |
| Minor | **1** | **M8** — `order.js`의 페이지 로드 병렬 2호출에서 **M4 메커니즘(cartId 이중 발급)이 실측 재현됨.** 이번 사이클에서는 관찰 가능한 결함으로 이어지지 않음(조건부 재발 경고) |
| 정보성 | **2** | **I8** — `checkout-error` 요소가 "화면 전체 에러"와 "요청 실패 오버레이" 두 의미를 겸용 / **I9** — `orders` Map 단조 증가 (I3의 연장, 이번 범위 결함 아님) |
| 회귀 테스트 자산 | **1** | **T1** — `tests/e2e/cart.spec.js:498` "장바구니 화면에는 결제/주문 버튼이 없다 (7.10)"이 **실패한다.** 7.10이 15.1로 폐기된 결과이며 **제품 결함이 아니라 테스트 노후화**다. 2단계(자동화)에서 반드시 교체할 것 |

**과거 버그 재발 여부 (우선순위 0):** **M5 재발 없음(코드로 직접 확인, 분기 2개 실재) / M4 — 결제 화면은 재발 없음(요청 1건 실측), 주문 확인 화면은 메커니즘 재현되나 영향 없음(M8) / M2 규칙대로 준수(존재-부재 분리 확인).** 상세는 §1.

## 1. 우선순위 0 — `docs/bug-history/` 재발 검증 (검증 시작 전 수행)

3개 문서를 전부 다시 읽고, 각 문서의 **"왜 다시 터질 수 있는가"** 패턴이 4차 새 코드(`server.js` 신규 라우트 / `checkout.js` / `order.js`)에 실제로 나타났는지 **코드와 실행으로 직접** 확인했다.

### BUG-2026-08-08-02 (M5, 공용 에러 핸들러 문구) — **재발 없음. 분기 실재 확인**

M5 문서는 *"결제(체크아웃) API를 추가할 때 지금 있는 공용 500 핸들러를 그대로 물려받으면 결제 실패 화면에도 '상품 목록을 불러오지 못했습니다'가 뜰 것"* 이라고 결제 API를 **이름으로 지목**해 예고했고, PRD 18.12가 이를 요구사항으로 못 박았다.

`server.js:699-723` 공용 에러 핸들러를 직접 읽어 **분기 4개가 실제로 존재**함을 확인했다.

```
server.js:706   if (req.path.startsWith('/api')) {
server.js:707     let message = '요청을 처리하지 못했습니다.';        // 중립 폴백 (수정 방향 2)
server.js:708     if (req.path.startsWith('/api/products'))  → '상품 목록을 불러오지 못했습니다.'
server.js:711     else if (req.path.startsWith('/api/cart'))     → '장바구니 요청을 처리하지 못했습니다.'
server.js:713     else if (req.path.startsWith('/api/checkout')) → '결제 요청을 처리하지 못했습니다.'      ← 4차 신규
server.js:715     else if (req.path.startsWith('/api/orders'))   → '주문 정보를 불러오지 못했습니다.'      ← 4차 신규
```

- **판정 ✅ 재발 없음.** `/api/checkout`·`/api/orders` 두 분기가 **코드에 실재**하며 문구는 PRD 18.12 권장값과 일치한다.
- 기존 두 분기(`/api/products`, `/api/cart`)와 상태 코드·응답 shape(`{ error: { message } }`)은 손대지 않았다 → 1~3차 회귀 없음. `GET /api/products?simulate=error` → 500 `상품 목록을 불러오지 못했습니다.` 실측 재확인.
- 프론트 폴백 문구도 일치시켜 뒀다(`checkout.js:207` `결제 요청을 처리하지 못했습니다.` / `order.js:162` `주문 정보를 불러오지 못했습니다.`) — M1 교훈("서버가 상황별 문구를 보내기 시작하면 프론트도 같이 바꿔야 한다")이 지켜졌다.
- ⚠️ **한계 고지:** `/api/checkout`·`/api/orders`에는 `?simulate=error` 같은 강제 500 훅이 없어 **런타임 실행으로는 분기를 트리거하지 못했다.** 3차 때 M5를 강제 500으로 실행 검증했던 것과 달리 이번엔 **코드 리딩 + 라우팅 경로 대조**로 판정했다. 분기 조건이 `req.path.startsWith()` 문자열 비교뿐이고 라우트 경로가 정확히 `/api/checkout`·`/api/orders/:orderId`임을 확인했으므로 판정에 실질적 불확실성은 없다.

### BUG-2026-08-08-01 (M4, 쿠키 최초 발급 경쟁 조건) — **결제 화면 재발 없음 / 주문 확인 화면은 메커니즘 재현(→ M8)**

frontend-agent는 *"`order.js`가 `GET /api/orders` + `GET /api/cart` 두 번 호출하지만 M4 패턴이 아니다"* 라고 자체 보고했다. **자기보고를 믿지 않고 쿠키 없는 새 컨텍스트로 두 화면의 실제 요청·`Set-Cookie`를 계측**했다.

| 화면 | 첫 방문(쿠키 없음) 시 실제 API 요청 | `Set-Cookie` 발급 횟수 | 판정 |
|---|---|---|---|
| `/checkout.html` | `["GET /api/cart"]` — **정확히 1건** | **1회** | ✅ **재발 없음** |
| `/order.html?orderId=...` | `["GET /api/orders/{id}", "GET /api/cart"]` — **2건 병렬** | **2회, 값이 서로 다름** | ⚠️ **메커니즘 재현 → M8** |

`/order.html` 첫 방문 실측 원문:

```
Set-Cookie: /api/orders/ORD-... => cartId=46fe83ac-6c6f-4c59-9272-6356602e06aa
Set-Cookie: /api/cart          => cartId=8b96d987-407a-4d40-99e9-5a872b3322fe
최종 브라우저 쿠키: cartId=8b96d987-407a-4d40-99e9-5a872b3322fe   ← 나중 것만 남음
```

- **결제 화면(PRD 16.1이 M4를 인용해 직접 경고한 지점)은 통과다.** `checkout.js:118-122`가 `HaruCart.getCart()` **단일 호출** 결과로 요약(`renderSummary`)과 배지(`updateBadge`)를 **둘 다** 채우고, `refreshBadge()`(추가 `GET /api/cart`)를 의도적으로 넣지 않았다. 계측으로 요청 1건임을 확인했다.
- **주문 확인 화면은 "쿠키 없는 첫 방문 + 병렬 2요청 → 서로 다른 cartId 2개 발급"이라는 M4의 메커니즘 자체가 그대로 재현된다.** 다만 이번 사이클에서 **관찰 가능한 결함으로 이어지지 않는다** — 판단 근거는 M8에 상세히 적었다.
- **판정: 이번 사이클 기능 결함 없음. 단 "재발 조건은 실제로 충족됐다"는 사실을 M8로 기록한다.** 3차 리포트의 I7("결제 화면처럼 진입과 동시에 병렬 호출하는 화면이 생기는 순간 재발한다")이 예고한 상황이 절반 실현된 것이므로, 다음 사이클에 이 화면이 장바구니 상태를 **쓰기** 시작하면 즉시 실결함이 된다.

### BUG-2026-08-NOTES (M2, "DOM에 있는지" vs "지금 보이는지") — **규칙대로 준수**

PRD 19.18이 M2를 사양으로 승격시켰다 — `checkout-link`만 "DOM 존재 + hidden 토글", `checkout-item`/`order-item`은 "데이터 없으면 부재".

| 요소 | PRD 규칙 | 실측 | 판정 |
|---|---|---|---|
| `checkout-link` (빈 장바구니) | DOM 존재 + hidden | `count()===1` **그리고** `isHidden()===true` | ✅ |
| `checkout-link` (항목 1개 이상) | 보임 | `isVisible()===true`, `href="/checkout.html"` | ✅ |
| `checkout-item` | 줄 수만큼 존재 / 없으면 부재 | 2줄일 때 `count()===2`, 빈 화면에선 `checkout-summary` 자체가 hidden | ✅ |
| `order-item` | 줄 수만큼 존재 | `count()===2` | ✅ |
| `cart-clear` (4차 회귀) | DOM 존재 + hidden | 3차 규칙 그대로 유지, 결제 링크 추가로 영향 없음 | ✅ |

본 리포트의 모든 단언도 이 구분을 지켰다 — `hidden` 토글 요소는 `isVisible/isHidden`으로, 줄 요소는 `count()`로 단언했다.

## 2. 우선순위 1 — 통합 정합성 (경계면, "양쪽 동시 읽기")

`server.js`와 `checkout.js`/`order.js`를 **동시에 열어** 대조했다. "API가 있다 / 화면이 있다"가 아니라 **같은 필드명·같은 판정 기준을 쓰는지**를 봤다.

### 2.1 요청 body 필드명 — 프론트가 보내는 것 vs 서버가 파싱하는 것 ✅ PASS

| | 프론트 (`checkout.js:176-180`) | 서버 (`server.js:586`) | 일치 |
|---|---|---|---|
| 이름 | `ordererName: el.name.value` | `const { ordererName, ... } = body` | ✅ |
| 연락처 | `ordererPhone: el.phone.value` | `ordererPhone` | ✅ |
| 결제수단 | `paymentMethod: readSelectedPaymentMethod()` (라디오 `value`) | `paymentMethod` | ✅ |
| 금액·상품 | **보내지 않음** (body에 3개 키뿐) | 받지 않음 / 실려 와도 무시 | ✅ PRD 16.8 / 18.1 |

- 라디오 `value`는 `checkout.html:96,101`에서 `MOCK_SUCCESS`/`MOCK_FAILURE` — 서버 상수(`server.js:286-287`)와 **문자열 완전 일치**(대소문자 포함). `"mock_success"`(소문자)를 보내면 서버가 400을 주는 것도 실측 확인했다.
- 반대 방향 검증: `{"totalPrice":1,"items":[]}`를 body에 **일부러 실어** 보내도 서버 계산 금액(289,000원)으로 주문이 만들어짐을 실측 — 클라이언트 금액을 신뢰하지 않는다(D12).

### 2.2 상태 코드별 — 서버가 반환하는 것 vs 프론트가 분기하는 것 ✅ PASS

`checkout.js:184-208`의 분기와 서버 응답을 1:1로 대조하고, **각 분기를 실브라우저에서 실제로 진입시켰다.**

| 상태 | 서버 실제 응답 (curl 실측) | 프론트 분기 (`checkout.js`) | 실브라우저 결과 | 판정 |
|---|---|---|---|---|
| **200** | `{"order":{...9필드...}}` | `:184` `result.body.order.orderId` → `location.href='/order.html?orderId='+...` | 주문 확인 화면 이동, `orderId` 일치 | ✅ |
| **402** | `{"error":{"message":"결제가 승인되지 않았습니다. 다른 결제 수단으로 다시 시도해 주세요."}}` | `:198` `showSubmitError(message, false)` | 화면 유지 + 서버 문구 그대로 표시 | ✅ |
| **400** | `{"error":{"message":"주문자 이름을 1자 이상 30자 이하로 입력해 주세요."}}` 등 3종 | `:202` `showSubmitError(message, false)` | 화면 유지 + 서버 문구 표시 | ✅ |
| **409** | `{"error":{"message":"장바구니가 비어 있어 결제할 수 없습니다."}}` | `:195` `showSubmitError(message, **true**)` → 상품 목록 링크 동반 | 링크 함께 표시 | ✅ 16.14 |
| **5xx / 네트워크** | (라우트 abort로 재현) | `:205`/`:210` 폴백 문구 | 에러 표시 + 버튼 재활성화 | ✅ 16.20 |

- **메시지 언래핑 지점이 하나뿐**임을 확인: `cart-badge.js:46-51` `readErrorMessage()`가 `body.error.message` 두 겹을 벗기는 유일한 함수이고, `checkout.js:194`가 이를 재사용한다. 프론트가 자체 문구로 덮어쓰지 않고 **서버 문구를 그대로 표시**한다(M1 교훈 준수).
- **표시 요소는 `checkout-error` 하나**로 5종을 모두 처리(PRD 19.9) — 상태 코드별 선택자를 만들지 않았다. 확인 완료.

### 2.3 402를 프론트가 미리 판정하지 않는가 (PRD 16.9) — ✅ PASS (요청 개수로 단언)

이번 사이클에서 **가장 놓치기 쉬운 경계면**이다. `paymentMethod === 'MOCK_FAILURE'`인지 프론트가 검사해 요청 없이 실패 화면을 그리면, 서버-프론트 경계면이 통째로 미테스트로 남는다.

- **정적 검증:** `checkout.js` 전체에서 `MOCK_FAILURE` 문자열은 **주석(19행)에만** 등장하고, 실행 코드에는 `paymentMethod` 값을 비교하는 조건문이 **0건**이다. `readSelectedPaymentMethod()`는 라디오 `value`를 그대로 읽어 payload에 넣기만 한다.
- **동적 검증(핵심):** 실브라우저에서 `POST /api/checkout` 요청 개수를 계측했다. `MOCK_FAILURE`를 선택하고 결제 버튼을 눌렀을 때 **요청 개수가 0→1로 증가**했고(누적 2건), 402 응답을 받은 뒤에야 에러가 표시됐다. **요청 없이 실패를 그리는 경로는 존재하지 않는다.**
- 같은 방식으로 **16.18(프론트 입력 검증 없음)** 도 요청 개수로 단언했다 — 이름·연락처가 **완전히 빈 상태**로 결제 버튼을 눌렀을 때 요청이 **실제로 1건 나갔고** 400 응답의 서버 문구가 표시됐다. `checkout.html`에 `required`/`pattern`/`minlength`/`maxlength`/`type="tel"` **0건**, `<form novalidate>` 확인(`checkout.html:81`).

### 2.4 `order` 응답에 `cartId`가 노출되지 않는가 (PRD 8.6 / D23) — ✅ PASS

- **서버:** `server.js:352-356` `toOrderResponse()`가 `const { cartId, ...publicOrder } = order`로 제거하고, `POST /api/checkout`(`:642`)·`GET /api/orders/:orderId`(`:669`) **두 응답 경로 모두** 이 함수를 통과한다. 우회 경로 없음.
- **실측:** 두 엔드포인트의 원시 JSON에서 `Object.keys(order)`가 정확히 `orderId,status,ordererName,ordererPhone,paymentMethod,items,totalQuantity,totalPrice,createdAt` **9개**이고 `'cartId' in order === false`.
- **프론트:** `order.js`/`checkout.js` 어디에도 `cartId` 참조 없음. `public/` 전체에서 `document.cookie`/`localStorage`/`sessionStorage` 사용 **0건**(주석 제외).

### 2.5 장바구니 비우기가 서버 checkout 처리 안에서 일어나는가 (D19 / 18.7) — ✅ PASS

- **서버:** `server.js:637-640` — `orders.set(orderId, order)` 직후 **같은 요청 처리 안에서** `items.length = 0`. 실패 경로(400 `:588-598` / 409 `:605-608` / 402 `:610-614`)는 **모두 이 지점 앞에서 `return`** 하므로 비우기에 도달할 수 없다.
- **프론트가 `DELETE /api/cart`를 따로 부르지 않는가:** `checkout.js`에 `DELETE`·`clearCart` 호출 **0건**(grep 전수).
- **실측 (성공):** 결제 200 직후 `GET /api/cart` → `{"cart":{"items":[],"totalQuantity":0,"totalPrice":0}}`. 실브라우저에서도 결제 후 `/cart.html`이 빈 상태로 전환되고 `checkout-link`가 hidden이 됐다.
- **실측 (실패 시 불변, PRD 16.15):** 402 직후 / 네트워크 오류 직후 / 400 직후 모두 `GET /api/cart`가 **결제 시도 전과 동일**(줄 2개, `totalQuantity=12`, `totalPrice=289000`). 실브라우저에서도 배지가 `12`로 유지되고 별도 탭의 장바구니 총액이 `289,000원` 그대로였다. **낙관적 갱신 코드 0건.**
- **참조 비공유(18.7 후단):** `buildCartSnapshot()`이 `.map()`으로 매 줄 새 객체를 만들므로 주문 `items`는 복사본이다. **실측으로 확인** — 장바구니가 비워진 뒤 같은 주문을 재조회해도 `items` 2줄·`totalPrice` 289,000이 그대로 남아 있다.

### 2.6 금액 3중 일치 (PRD 17.4 — 이번 사이클 핵심 불변식) — ✅ PASS

할인이 걸린 줄(`p1` 10개, 10% 할인)을 포함한 장바구니로 **장바구니 → 결제 → 주문 확인** 세 화면의 총액 문자열을 대조했다.

```
장바구니 cart-total-price   = 289,000원
결제화면 checkout-total-price = 289,000원
주문확인 order-total-price   = 289,000원      ← 세 값 문자열 완전 일치
```

- 서버 원시값도 `cart.totalPrice = 289000` == `order.totalPrice = 289000`.
- 줄 단위 불변식도 실측 확인: `p1` → `price 19000 / quantity 10 / discountApplied true / discountedUnitPrice 17100 / lineSubtotal 190000 / lineTotal 171000 / discountAmount 19000` (12.5 계산식·버림 규칙 일치), `p2` → 미적용 줄이 `discountedUnitPrice === price`, `lineTotal === lineSubtotal`, `discountAmount 0`.
- **`order.items`의 필드 수 = 11개** — `CartItem`과 완전히 동일(별도 `OrderItem` 타입 없음, 데이터 모델 확정값 준수). 할인 필드 5개가 주문 스냅샷에 그대로 보존된다.
- **프론트 재계산 0건:** `checkout.js`/`order.js`에 `price *`, `reduce`, `* 0.9`, `/ 100`, `quantity >= 10` 형태의 산술·판정 **주석 외 출현 0건**. 두 화면 모두 `cart-badge.js`의 `mapCartItem()`(산술 없음, `Number()` 변환 + `formatPrice()` 포맷만)을 재사용한다.

## 3. 우선순위 2 — PRD 요구사항별 판정 (15~19장 전수)

### 15장 — 장바구니 → 결제 진입

| # | 요구사항 | 검증 방법 | 판정 |
|---|---|---|---|
| 15.1 | "결제하기" 링크, 실제 `<a href="/checkout.html">` | 실브라우저: 클릭 → `/checkout.html` 이동. `cart.html:77`이 `<a>` 태그(JS `location` 조작 아님) | ✅ |
| 15.2 | 빈 장바구니면 hidden (DOM엔 존재) | `count()===1` **and** `isHidden()===true` (결제 후 빈 상태에서 실측) | ✅ |
| 15.3 | 진입점은 장바구니 화면 하나뿐 | `index.html`/`product.html`/`app.js`/`product.js`에 `checkout`·`결제`·`바로 구매` **0건** (grep 전수). 공통 헤더(4개 화면)에도 결제 링크 없음 | ✅ |
| 15.4 | 장바구니 나머지 불변 | 기존 Playwright 44건 통과 + 줄/수량/삭제/합계/빈상태/비우기/할인 표시 회귀 없음 | ✅ |
| 15.5 | `cart-clear` 위치·동작 불변, 서로 독립 | `cart.js:59,62`가 서로를 참조하지 않는 독립 토글. 결제 링크가 보이는 상태에서 `cart-clear`도 정상 표시 | ✅ |

### 16장 — 결제 화면

| # | 요구사항 | 검증 방법 | 판정 |
|---|---|---|---|
| 16.1 | `GET /api/cart` **한 번**, 요약+배지 동시 충족 | 계측: 첫 방문 API 요청 `["GET /api/cart"]` 1건뿐 | ✅ |
| 16.2 | 읽기 전용 (증감/삭제/비우기 없음, PATCH/DELETE 미호출) | 해당 `data-testid` `count()===0`. `checkout.js`에 PATCH/DELETE/clearCart/setQuantity/removeItem **0건** | ✅ |
| 16.3 | 장바구니로 돌아가는 링크 | `checkout.html:31` `<a href="/cart.html">` 상시 노출 | ✅ |
| 16.4 | 금액은 서버 값 그대로 | 장바구니 총액 == 결제 총액 문자열 일치(§2.6). 프론트 산술 0건 | ✅ |
| 16.5 | 할인 UI 없음 | `cart-item-discounted-price`/`cart-item-discount-notice` `count()===0` (할인 줄 포함 상태에서) | ✅ |
| 16.6 | 입력란은 이름·연락처 2개뿐 | 주소/우편번호/이메일/요청사항/카드번호/CVC/유효기간/생년월일 **0건** (grep 전수) | ✅ |
| 16.7 | 라디오 2개, 초기 `MOCK_SUCCESS` 선택, 라벨에 "모의"/"실패 테스트용" | `isChecked(payment-method-success)===true`. 라벨 `모의 결제 (승인 성공)` / `모의 결제 (승인 거절 — 실패 테스트용)` | ✅ |
| 16.8 | body 3필드, 금액·상품 미포함 | §2.1 | ✅ |
| 16.9 | 프론트가 402를 미리 판정하지 않음 | **요청 개수 계측으로 단언** (§2.3) | ✅ |
| 16.10 | 이중 클릭 방지 + 응답 후 재활성화 | 400ms 지연 라우트 + **3연타** → `POST /api/checkout` **1건**. 402/네트워크 오류 후 `isDisabled()===false` | ✅ |
| 16.11 | 성공 시 `/order.html?orderId=` 이동 | 실브라우저 URL 이동 확인 | ✅ |
| 16.12 | 402 시 머무름·입력값 유지·요약 유지·재시도 성공 | URL 유지, `홍길동`/`010-1234-5678` 그대로, 총액 동일, 이후 `MOCK_SUCCESS`로 재시도 → 200 | ✅ |
| 16.13 | 400 시 메시지 표시 + 이동 없음 | 서버 문구 `주문자 이름을 1자 이상...` 표시, URL 유지 | ✅ |
| 16.14 | 409 시 메시지 + 상품 목록 링크 | 결제 화면 띄운 채 다른 경로로 장바구니를 비우고 결제 → 문구 + `#checkout-error-action` 표시 | ✅ |
| 16.15 | 실패 시 장바구니 절대 불변 | 400/402/네트워크 3경로 모두 실측 (§2.5) | ✅ |
| 16.16 | 빈 장바구니 직접 접속 → `checkout-empty`, 폼/라디오/버튼 숨김 | `checkout-empty` 표시, `checkout-submit`/`orderer-name`/`payment-method-success` 모두 `isHidden()` | ✅ |
| 16.17 | 상태 배타성 (+ 요청 실패는 예외적으로 겹침) | 빈 상태에서 요약 숨김·에러 숨김 / `GET /api/cart` 500 주입 시 요약·폼·빈상태 전부 숨고 에러만 / 402 시엔 요약이 보인 채 에러 겹침 | ✅ |
| 16.18 | 프론트 입력 검증 없음 (HTML5 속성 포함) | 빈 입력에도 요청 1건 실발생 + `required`/`pattern`/`minlength`/`maxlength` 0건, `novalidate` | ✅ |
| 16.19 | 공통 헤더 + 배지, 값은 16.1 응답의 `totalQuantity` | 배지 텍스트 `12` == 서버 `totalQuantity` 12 | ✅ |
| 16.20 | 5xx/네트워크 오류 시 에러 표시, 화면 안 깨짐 | 라우트 abort로 재현 → 에러 표시 + 버튼 재활성화 + 장바구니 불변 | ✅ |

### 17장 — 주문 확인 화면

| # | 요구사항 | 검증 방법 | 판정 |
|---|---|---|---|
| 17.1 | `GET /api/orders/{id}` **한 번**, 6종 정보 표시 | 주문번호/상태/일시/주문자/연락처/줄 2개/총 수량·금액 전부 렌더 확인 | ✅ |
| 17.2 | "결제 완료"의 근거는 `status === "PAID"` | `order.js:50`이 `order.status === 'PAID'`로 분기(하드코딩 아님). 화면 텍스트 `결제 완료` | ✅ |
| 17.3 | 금액은 서버 값 그대로 | 프론트 산술 0건, `mapLineItem` 재사용 | ✅ |
| 17.4 | 장바구니 == 결제 == 주문 총액 | 세 값 문자열 일치 (§2.6) | ✅ |
| 17.5 | 새로고침해도 유지 | F5 후 `order-id` 동일 값 재표시 (서버 재조회) | ✅ |
| 17.6 | `orderId` 없으면 **API 호출 없이** not-found | `/order.html` 접속 시 `/api/orders/` 요청 **0건** (계측) + not-found 표시 | ✅ |
| 17.7 | 없는 주문 → not-found + 목록 링크 | `ORD-20260810-ZZZZZZ` → `order-not-found` 표시, 링크 존재 | ✅ |
| 17.8 | 남의 주문 → not-found (같은 화면) | **별도 브라우저 컨텍스트**로 같은 URL 접속 → `order-not-found` 표시, `order-confirmation` hidden. 서버 404 3경로(없음/남의 것/쿠키 없음) 모두 동일 상태코드·동일 메시지 실측 | ✅ |
| 17.9 | 목록 링크 + 공통 헤더 | `order.html:31` 백링크, 헤더 `cart-link`+`cart-count` | ✅ |
| 17.10 | 배지 0 → 숨김, 배지 호출 실패해도 렌더 정상 | 결제 직후 `cart-count` `isHidden()===true`. `refreshBadge()`가 실패를 내부에서 삼킴(`cart-badge.js:189-193`) | ✅ |
| 17.11 | 상태 배타성 | `showOnly()` 4상태 배타 토글, 각 상태 실진입 확인 | ✅ |
| 17.12 | 할인 UI 없음 | 할인 선택자 `count()===0` (할인 줄 포함 주문에서) | ✅ |
| 17.13 | 취소/환불/재주문/영수증/배송조회 버튼 없음 | `order.html` 전체에 해당 버튼 0건 | ✅ |

### 18장 — API (실서버 curl 전수)

| # | 요구사항 | curl 실측 | 판정 |
|---|---|---|---|
| 18.1 | body 3필드만, 금액·상품 무시 | `{"totalPrice":1,"items":[]}` 동봉해도 서버 계산값(289,000)으로 주문 생성 | ✅ |
| 18.2 | 200 + `{ "order": {...} }` 래핑, 9필드 | `Object.keys` 정확히 9개, top-level 래핑 확인 | ✅ |
| 18.3 | 결정론적 판정, 난수·시각·금액 미사용 | `MOCK_FAILURE` **5회 연속 → 402/402/402/402/402**. `server.js:610`이 문자열 비교 한 줄. 판정부에 `Math.random()`/`Date` 없음(`crypto.randomInt`는 `orderId` 접미사 전용으로 판정과 분리됨) | ✅ |
| 18.4 | 402 + 지정 문구, 주문 미저장·장바구니 미변경 | 문구 일치. 402 후 `GET /api/cart` 불변. `orderId` 미발급 | ✅ |
| 18.5 | 400 3종 + 정규식 확정값 | 이름: 빈문자/공백만/**31자** → 400, **30자 경계 → 통과**. 연락처 **허용 4종 전부 통과 / 불허 6종 전부 400**(`010-1234-567`, `02-123-4567`, `010-12345678`, `010 1234 5678`, `abc`, 공백만). `paymentMethod`: `CARD`/`mock_success`/`null`/`""` → 400 | ✅ |
| 18.5 | **검증 순서 400 → 409 → 402** | 이름 빈값 + `MOCK_FAILURE` → **400**(402 아님). 빈 장바구니 + 잘못된 이름 → 400 | ✅ |
| 18.6 | 빈 장바구니 → 409 + 지정 문구 | 문구 일치 | ✅ |
| 18.7 | 한 요청 안에서 저장+비우기, `items` 복사본 | 결제 직후 장바구니 비었으나 주문 재조회 시 `items` 2줄 유지 | ✅ |
| 18.8 | 재고 미차감, `Product`에 재고 필드 없음 | `GET /api/products` 응답 5필드 그대로(1차 회귀) | ✅ |
| 18.9 | 200 + `POST /api/checkout`과 동일 shape | 두 응답 키 집합 동일 | ✅ |
| 18.10 | 404 3경로를 동일하게 처리 | 없는 주문 / 다른 쿠키 / 쿠키 없음 → 전부 `404` + `주문을 찾을 수 없습니다.` (403 아님) | ✅ |
| 18.11 | `GET /api/orders`(복수형) 없음 | → `404 존재하지 않는 API 경로입니다.` | ✅ |
| 18.12 | 500 문구 분기 | §1 (코드 확인) | ✅ |
| 18.13 | 총 9개, PG·목록·취소·환불·쿠폰 미구현 | 라우트 9개 확인, PG 관련 식별자 grep **0건**(`tosspayments`/`iamport`/`portone`/`inicis`/`nicepay`/`paypal`/`stripe`/`webhook`/`returnUrl`/`successUrl`/`failUrl`) | ✅ |
| 18.14 | 에러 shape 불변, `code` 미추가 | 400/402/404/409 전부 `{ error: { message } }` 한 겹만 | ✅ |
| 18.15 | 쿠키 규칙 동일, 쿠키 없는 checkout → 409 | `Set-Cookie: cartId=...; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800` (Secure 없음) + 409 동시 확인 | ✅ |
| 18.16 | 비멱등 — 연속 2회 시 두 번째는 409 | 200 → 409 실측 | ✅ |

### `Order` 데이터 모델 불변식 (실측)

| 불변식 | 실측 | 판정 |
|---|---|---|
| `status === "PAID"` | `PAID` | ✅ |
| `orderId` ~ `^ORD-\d{8}-[A-Z0-9]{6}$` | `ORD-20260810-AAYRCI`, `ORD-20260810-2ECAH1` — 정규식 통과, 날짜부 UTC 기준 일치 | ✅ |
| `items.length >= 1` | 2 | ✅ |
| `totalQuantity` == `quantity` 합 | 12 == 10+2 | ✅ |
| `totalPrice` == `lineTotal` 합 (`lineSubtotal` 합 아님) | 289000 == 171000+118000 (308000 아님) | ✅ |
| `totalPrice` == 결제 직전 장바구니 `totalPrice` | 289000 == 289000 | ✅ |
| `ordererName`/`ordererPhone` trim만 적용, 형식 재조립 없음 | `"  홍길동  "` → `"홍길동"`, `"  010-1234-5678  "` → `"010-1234-5678"`(하이픈 보존) | ✅ |
| `createdAt` ISO 8601 UTC | `2026-08-10T04:24:01.883Z` | ✅ |
| 결제 직후 `GET /api/cart`는 빈 장바구니 | 확인 | ✅ |
| 모든 금액 정수 | 소수 0건 | ✅ |

### 19장 — 테스트 선택자 (전수 대조)

- **4차 신규 선택자 28종이 전부 존재하며, PRD에 없는 선택자는 하나도 추가되지 않았다.** `checkout.html`/`checkout.js`에서 추출한 `data-testid` 17종(공통 헤더 2종 포함), `order.html`/`order.js`에서 18종 — PRD 19.1~19.17 목록과 1:1 일치.
- `data-product-id`: `checkout-item`(19.3)·`order-item`(19.14) 양쪽에 부여 확인.
- 19.13 `<time datetime>`: 속성값이 `2026-08-10T...Z` ISO 원본, 표시 텍스트는 `toLocaleString('ko-KR')` — 단언은 속성으로 가능.
- 19.11 `data-order-id`: 렌더 후 값이 `order-id` 텍스트와 일치.
- 19.18 존재/부재 규칙: §1의 M2 표.
- 19.19 기존 선택자 불변: 기존 Playwright 44건 통과가 증거.

### 최상단 제약 블록 (모의 결제 — 만들지 않는 것) — ✅ 전항목 미구현 확인

`public/` + `server.js` grep 전수에서 **PG SDK·스크립트 로드 0건 / 카드번호·유효기간·CVC·생년월일·카드사 선택 입력란 0건 / 결제창 팝업·리다이렉트·`returnUrl`·`successUrl`·`failUrl` 0건 / 웹훅 엔드포인트 0건 / 가맹점 ID·시크릿 키·`.env` 결제 설정 0건 / 취소·환불·영수증 0건.** 결제는 `fetch` 한 번으로 끝난다.

## 4. 우선순위 3 — 코드 품질

- **중복 없음.** `order.js`가 자체 매핑 함수를 만들지 않고 `HaruCart.mapLineItem`(= `mapCartItem`)을 재사용한다. `checkout.js`는 `HaruCart.getCart()`를 그대로 쓴다 — 응답 언래핑 지점이 프로젝트 전체에서 `mapCartResponse()`/`mapOrderResponse()`/`readErrorMessage()` 3곳으로 유지된다.
- **미사용 코드 없음.** `checkout.js`/`order.js`의 선언 요소가 전부 사용된다. `hideSubmitError()`도 `onSubmit` 진입 시 사용.
- **명명 규칙 일관.** 서버 필드 camelCase / enum UPPER_SNAKE_CASE(`PAID`, `MOCK_SUCCESS`) 확정값 준수. `paymentMethod` 상수 2개가 서버 한 곳(`server.js:286-287`)에만 있고 검증·판정이 모두 이를 참조 → 문자열 드리프트 여지 없음.
- **375px 레이아웃:** `checkout.html`·`order.html` 모두 `scrollWidth === 375`로 가로 오버플로 없음 (frontend-agent가 미확인으로 남긴 항목 — QA가 실측 보완).
- **주석 품질:** 두 신규 프론트 파일 모두 상단에 백엔드 계약과 PRD 조항 번호가 명시돼 있어 다음 사이클에 계약이 바뀔 때 고칠 지점이 명확하다.

## 5. 발견 사항

### [Minor] M8 — `order.js`의 페이지 로드 병렬 2호출에서 M4 메커니즘(cartId 이중 발급)이 실측 재현됨

- **위치:** `public/order.js:176` `loadOrder()` (→ `GET /api/orders/:orderId`) + `public/order.js:187` `window.HaruCart.refreshBadge()` (→ `GET /api/cart`) — 둘이 **같은 tick에 병렬로 나간다.** 서버 측 지점은 `server.js:164-176` `ensureCartId()`(2차 이후 변경 없음).
- **문제:** 쿠키가 없는 첫 방문에서 두 요청이 **각각** "쿠키 없음"으로 판단해 **서로 다른 `cartId`를 2개 발급**한다. 실측:

  ```
  Set-Cookie (from /api/orders/...) : cartId=46fe83ac-6c6f-4c59-9272-6356602e06aa
  Set-Cookie (from /api/cart)       : cartId=8b96d987-407a-4d40-99e9-5a872b3322fe
  브라우저 최종 보관                : cartId=8b96d987-...   ← 하나만 남음
  ```

  이는 `docs/bug-history/2026-08-08_cart-session-race-condition.md`의 **"왜 다시 터질 수 있는가"** 에 적힌 재발 조건 *"화면이 로드되자마자 2개 이상의 API 요청을 병렬로 쏘는 상황"* 을 **문자 그대로 충족**한다. frontend-agent의 자체 보고("M4 패턴이 아니다")는 **결론(영향 없음)은 맞지만 근거(구조가 다르다)는 부정확하다** — 구조는 동일하고, 결과가 갈리지 않을 뿐이다.
- **왜 Critical/Important가 아닌가 (관찰 가능한 결함이 없는 이유):**
  1. 이 화면에 도달하는 정상 경로(결제 성공 직후 `location.href` 이동)에서는 **쿠키가 이미 존재**하므로 이중 발급 자체가 일어나지 않는다.
  2. 쿠키가 없는 상태로 주문 URL을 여는 경우(시크릿 창에 링크 붙여넣기)는 **어느 `cartId`가 살아남든 `GET /api/orders/:orderId`가 반드시 404**다 — 새로 발급된 UUID가 기존 주문의 `cartId`와 일치할 수 없기 때문. 즉 PRD 17.8이 요구하는 결과와 **항상 같다.** 실측으로도 not-found가 결정론적으로 재현됐다.
  3. 배지는 어느 쪽 `cartId`로 조회해도 **빈 장바구니(0)** → 숨김. PRD 17.10 결과와 동일.
  4. 이 화면은 장바구니를 **읽기만** 하고 쓰지 않는다.
- **⚠️ 언제 실결함이 되는가 (다음 사이클 경고):** 아래 중 **하나라도** 생기면 즉시 재발한다.
  - 주문 확인 화면에 "다시 담기 / 재주문"처럼 **장바구니를 쓰는 조작**이 추가될 때 (담은 결과가 살아남지 못한 쪽 `cartId`에 들어가 사라진다)
  - `GET /api/orders`(목록)가 범위에 들어와 **`cartId` 기반으로 목록을 조회**할 때
  - 로그인/세션 확인처럼 **또 다른 쿠키 기반 병렬 호출**이 어느 화면에든 추가될 때
- **수정 방향 (택1, 이번 사이클 필수 아님):**
  1. **(권장·근본)** bug-history가 이미 제시한 1안 — **정적 HTML을 서빙하는 시점에 쿠키를 선발급**한다. `express.static` 앞에 `.html` 응답에 대해 `ensureCartId(req, res)`를 호출하는 미들웨어를 한 개 두면, 첫 API 요청이 도착하기 전에 쿠키가 이미 존재하므로 **`order.js`/`checkout.js`/`product.js` 어느 프론트 코드도 고치지 않고** 프로젝트 전체의 M4가 한 번에 사라진다. (3차 리포트 I7이 지목한 것과 같은 처방)
  2. (국소) `order.js`에서 `refreshBadge()`를 `loadOrder()`의 응답 이후로 **직렬화**한다 — 이 화면 하나만 막는 대증 요법이라 다음 화면에서 또 판단해야 한다.
- **양쪽 통보 필요:** backend-agent(1안 담당) / frontend-agent(2안 담당) — 어느 쪽을 택하든 한쪽만 고치고 반대편에 안 알리면 서로 다른 가정으로 각자 수정하게 된다.

### [정보성] I8 — `checkout-error` 요소가 두 가지 의미를 겸용한다

- **위치:** `public/checkout.js:54-71` `showPhase()` / `showSubmitError()`
- `checkout-error`가 ① **"화면 전체 에러 상태"**(초기 `GET /api/cart` 실패 → 요약·폼 숨기고 단독 표시)와 ② **"정상 화면 위의 요청 실패 오버레이"**(400/402/409/5xx → 요약·폼 유지) 두 의미로 쓰인다.
- **스펙 위반이 아니다.** PRD 19.10은 상태 요소로 `checkout-loading`·`checkout-empty` 두 개만 정의했고 "화면 전체 에러 상태"용 선택자를 따로 주지 않았다(16.17 각주가 그 상태의 존재만 언급). 주어진 선택자 안에서의 합리적 구현이다.
- **테스트 작성 시 주의:** `checkout-error`가 보인다는 사실만으로 두 상황을 구분할 수 없다. **`checkout-summary`(또는 `checkout-submit`)가 함께 보이는지**를 같이 단언해야 한다 — 본 리포트의 16.17 검증도 그 방식으로 했고, 2단계 자동화도 같은 방식으로 짜야 한다.

### [정보성] I9 — `orders` Map이 단조 증가한다 (I3의 연장)

- **위치:** `server.js:137` `const orders = new Map()`
- 2차 I3(`carts` Map 단조 증가)와 같은 성질이다. 주문은 만료·삭제 경로가 없어 프로세스 수명 동안 계속 쌓인다. **이번 범위에서는 결함이 아니다** — D21이 "서버 재시작 시 주문이 사라져도 된다"고 확정했고 DB 도입 사이클에 함께 정리될 사안이다.
- 부수 기록: M8의 이중 발급으로 생기는 여분 `cartId`는 `GET /api/orders`가 `getCartItems()`를 호출하지 않으므로 **`carts` Map에 항목을 만들지 않는다** — 메모리 누적 관점의 추가 부담은 없다.

## 6. 회귀 테스트 자산 조치 (2단계 필수 작업)

### [T1] `tests/e2e/cart.spec.js:498` — "장바구니 화면에는 결제/주문 버튼이 없다 (7.10)" 가 **실패한다**

```
$ npx playwright test
  1 failed
    [chromium] › tests/e2e/cart.spec.js:498:3 › ... › 장바구니 화면에는 결제/주문 버튼이 없다 (7.10)
  44 passed (13.4s)
```

- **원인:** 이 테스트는 3차 시점의 PRD **7.10**("장바구니 화면에 결제/주문 버튼을 만들지 않는다")을 지키던 회귀 테스트다. 4차에서 **7.10은 폐기되고 15.1로 대체**되어 결제하기 링크가 정상적으로 생겼다. 실패 지점은 `cart.spec.js:504` `page.locator('a', { hasText: /결제|주문|구매|checkout/i })`가 `toHaveCount(0)`을 기대하는데 실제로는 `1`(= `checkout-link`)이다.
- **제품 결함이 아니다.** 실패가 곧 15.1이 구현됐다는 증거다. 서버·프론트 코드를 고칠 사안이 아니다.
- **왜 방치하면 안 되는가:** 이 스위트는 매 사이클 회귀를 잡아주는 유일한 자동 장치다. 항상 1건이 빨간불이면 **"원래 하나는 실패한다"는 습관**이 생겨 진짜 회귀를 놓치게 된다.
- **2단계 조치(승인 후 sonnet 호출에서 수행):** `cart.spec.js:498-506` 블록을 **삭제가 아니라 교체**한다 —
  1. 7.10 케이스는 제거하고,
  2. 같은 자리에 **15.1~15.5**(결제하기 링크 존재·`<a href>`·항목 있을 때 표시·빈 장바구니에서 hidden·`cart-clear`와 독립) 케이스를 넣는다.
  3. **6.12는 그대로 유지**한다 — 상품 상세 화면의 결제/구매 버튼 금지는 4차에도 유효하므로(15.3), `product-detail.spec.js`의 6.12 테스트는 손대지 않는다.
- 나머지 **44건은 전부 통과** — 1~3차 회귀 없음(목록/상세/장바구니/세션/비우기/할인 전 영역).

## 7. 미검증 항목 (한계 고지)

| 항목 | 사유 | 위험도 |
|---|---|---|
| `/api/checkout`·`/api/orders`의 **500 분기 런타임 트리거** | 두 라우트에 `?simulate=error` 같은 강제 오류 훅이 없어 실행으로 500을 만들 수 없었다. **코드 리딩 + 경로 대조로 판정**(§1) | 낮음 — 분기 조건이 문자열 비교뿐이고 라우트 경로가 확정적 |
| 실제 동시성 하의 M4 재현(같은 밀리초 도착) | 로컬 환경은 창이 좁다. 대신 **`Set-Cookie` 발급 횟수·값**으로 메커니즘을 직접 관측했다(M8) | 낮음 — 메커니즘 자체는 확인됨 |
| 다중 브라우저 엔진(Firefox/WebKit) | `playwright.config.js`가 chromium 단일 프로젝트 | 낮음 — `toLocaleString`/`<time>`은 표준 API |
| 서버 재시작 후 주문 소실 | D21/8.7이 허용한 동작이므로 검증 대상에서 제외 | 해당 없음 |
| 장기 부하 / 다수 주문 누적 시 성능 | 범위 밖 (I9) | 해당 없음 |

## 8. 양쪽 에이전트에게 전달할 사항 (4차)

**backend-agent에게**
1. **M5 대응 잘 됐다.** `/api/checkout`·`/api/orders` 분기가 실재하고 문구가 18.12 권장값과 일치한다. 기존 두 분기와 shape·상태 코드를 건드리지 않아 회귀도 없다.
2. **M8 근본 수정의 담당은 백엔드 쪽이 더 유리하다.** 정적 HTML 서빙 시점 쿠키 선발급(미들웨어 1개)이면 프론트 3개 파일을 손대지 않고 프로젝트 전체의 M4가 사라진다. 기획 승인 후 다음 사이클 초반에 처리 권장.
3. 다음 사이클에 500 경로를 QA가 실행 검증할 수 있도록, `?simulate=error` 훅을 `/api/checkout`·`/api/orders`에도 열어줄지 product-planner와 논의해 달라(현재는 코드 리딩으로만 판정 가능).

**frontend-agent에게**
1. `checkout.js`의 **단일 `GET /api/cart`** 결정은 정확했다 — 계측으로 요청 1건임을 확인했다. 16.9(프론트 미리 판정 금지)도 실행 코드에 비교문 0건으로 완벽히 지켜졌다.
2. **`order.js`의 M4 판단 근거만 정정이 필요하다.** 결론("이번 사이클 영향 없음")은 맞지만 근거("구조가 다르다")는 사실과 다르다 — 구조는 동일하고 **cartId가 실제로 2개 발급된다**(M8 실측). 다음 사이클에 이 화면이 장바구니를 **쓰기** 시작하면 그 순간 실결함이 된다는 점을 인지해 달라.
3. `03_frontend_screens.md` 29절의 **미확인 5건은 QA가 전부 실측 보완했다** — 이중 클릭(3연타 → POST 1건), 402 재시도 폼 상태 유지, `checkout-empty`/초기 로드 실패 상태, `<time datetime>` 속성, 375px 레이아웃(오버플로 없음). 모두 통과.
4. `checkout-error` 겸용(I8)은 스펙 위반은 아니나, 자동화 테스트에서 두 상황을 구분하려면 `checkout-summary` 표시 여부를 함께 봐야 한다.

**product-planner에게**
1. 15~19장은 **구현 가능하고 검증 가능한 형태로 잘 확정돼 있었다.** 특히 D17(결정론적 판정)·D25(서버 단독 검증)·19.18(존재/부재 규칙) 세 결정이 QA 케이스를 유한하고 재현 가능하게 만들었다.
2. **T1**은 요구사항 폐기(7.10 → 15.1)가 회귀 테스트를 무효화한 사례다. 앞으로 요구사항을 폐기할 때 "그 요구사항을 지키던 테스트도 함께 폐기 대상"임을 개정 표에 한 줄 적어주면 QA가 놓치지 않는다.

## 변경 이력 (누적)

| 날짜 | 변경 내용 |
|---|---|
| 2026-08-10 | **4차 사이클 검증 추가 (모의 결제)** — 우선순위 0의 **bug-history 재발 검증을 먼저 수행**: **M5 재발 없음**(공용 500 핸들러에 `/api/checkout`·`/api/orders` 분기 실재를 코드로 확인), **M4 — 결제 화면 재발 없음**(첫 방문 API 요청 1건 계측)이나 **주문 확인 화면에서 메커니즘 재현**(`Set-Cookie` 2회·서로 다른 cartId 실측 → M8, 이번 사이클 영향 없음), **M2 준수**(존재/부재 분리 단언). PRD 15.1~15.5 / 16.1~16.20 / 17.1~17.13 / 18.1~18.16 / 19.1~19.19 + `Order` 불변식 10종 전수. 실서버 curl 40여 케이스(연락처 허용 4·불허 6, 이름 30/31자 경계, 검증 순서 400→409→402, 결정론 5연속, 404 3경로, 비멱등 200→409) + **Chromium 실브라우저 단언 48건 전원 통과** + 375px 레이아웃 2건. 금액 3중 일치(장바구니 289,000원 == 결제 == 주문) 확인. Critical 0 / Important 0 / **Minor 1(M8)** + 정보성 2(I8, I9) + **회귀 테스트 자산 조치 1건(T1 — `cart.spec.js`의 7.10 테스트가 15.1 구현으로 실패, 제품 결함 아님, 2단계에서 교체 필요)** |
