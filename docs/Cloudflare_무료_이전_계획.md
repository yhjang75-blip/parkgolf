# 나이스파크 Cloudflare 무료 이전 계획

작성일 2026-11-17 · 대상: 사이트 운영자, 다음에 이어서 작업할 사람

## 1. 한눈에 보기

| | 지금 (Render 무료) | 바꾼 뒤 (Cloudflare 무료) |
|---|---|---|
| 비용 | 0원 | **0원** (유료 구독 필요 없음) |
| 첫 접속 속도 | 한동안 접속이 없으면 서버가 잠들어 30초~1분 대기 | **잠들지 않음** — 늘 바로 열림 |
| 회원·대회 자료 보관 | Neon (연결 안 된 상태) | **Cloudflare D1** — 첫 배포 때 자동으로 생김 |
| 프로그램 | 파이썬 (Flask) | TypeScript (Cloudflare Workers) |
| 주소 | parkgolf.onrender.com | nicepark.<계정이름>.workers.dev |

- **개발은 끝났고**, 내 PC에서 시험을 마쳤습니다.
- 남은 일은 **Cloudflare 가입과 열쇠(토큰) 등록**입니다. 운영자가 직접 해야 합니다 (4장).
- Render 사이트는 Cloudflare 전환이 확인될 때까지 그대로 둡니다. 문제가 생기면 언제든 Render로 돌아갈 수 있습니다.

## 2. 무료 한도와 예상 사용량

| 항목 | 무료 한도 | 나이스파크 사용량 (예상) |
|---|---|---|
| 서버 요청 | 하루 10만 건 | 첫 화면 한 번에 약 7건 → 하루 **약 1만 4천 명** 방문까지 무료 |
| 구장 자료·CSS·JS 파일 | **무제한** | 구장 410곳 자료는 모두 이쪽으로 보내 요청 수를 아낌 |
| 요청 한 건의 계산 시간 | 10ms (밀리초) | 화면 하나 만드는 데 몇 ms 정도 |
| 데이터베이스(D1) | 저장 5GB, 하루 읽기 500만 행·쓰기 10만 행 | 회원·대회 자료는 수 MB 수준 |

한도를 넘으면 그날만 일부 요청이 실패하고, 요금이 자동으로 청구되지는 않습니다. 방문자가 크게 늘면 그때 유료(월 $5)를 고려하면 됩니다.

## 3. 무엇을 만들었나

### 옮긴 기능 (모두 그대로 동작)
- 구장 찾기 (목록·지도·상세), 날씨, 대회·우승·지역 뉴스, 대회 영상
- 점수계산기, 대회 안내, 소개·이용약관·개인정보처리방침
- 카카오 로그인·가입 동의, 내 정보, 즐겨찾기, 출석·포인트·등급, 이달의 회원
- 제휴 혜택 교환, 관리자 화면 (혜택 등록, 교환 처리, 회원 이용 제한)
- 대회 참가 시스템 전체: 개설 → 신청 → 입금 확인 → 자동 조 편성 → 점수 입력·순위 → 결과 공개, 인쇄(조편성표·결과표·점수카드), 명단 엑셀(CSV) 내려받기

### 옮기지 않은 것
- **커뮤니티 게시판**: 이미 닫혀 있어서 옮기지 않았습니다. 다시 열려면 사진 저장 방식부터 새로 정해야 합니다 (Cloudflare R2 무료 10GB 등). 게시판용 표는 데이터베이스에 만들어 두었습니다.

### 달라진 점
- **로그인 유지 비밀값(SECRET_KEY)**: 입력하지 않아도 됩니다. 서버가 처음 한 번 만들어 데이터베이스에 보관합니다.
- **데이터베이스 주소(DATABASE_URL)**: 필요 없습니다. Neon은 연결된 적이 없어서 옮길 회원 자료도 없습니다.
- **관리자 카카오 번호(ADMIN_KAKAO_IDS)**: `kakao:12345` 와 `12345` 두 형식을 모두 받습니다.

### 파일 구성
| 파일 | 하는 일 |
|---|---|
| `worker/index.ts` | 주소별로 어느 기능을 부를지 정함 |
| `worker/members.ts` | 로그인·내 정보·포인트·혜택·관리자 |
| `worker/compete.ts` | 대회 참가 시스템 |
| `worker/feeds.ts` | 날씨·뉴스·영상·대회 일정 |
| `worker/db.ts` | 데이터베이스 표 (처음 요청 때 자동 생성) |
| `worker/lib.ts` | 공통 도구 (시간, 로그인 쿠키, 화면 그리기) |
| `worker/views/*.html` | 화면 틀 (`templates/` 의 Cloudflare용 사본) |
| `scripts/build-worker.mjs` | 배포 직전 자동 실행: 화면 틀 변환, 구장 자료를 정적 파일로 |
| `wrangler.jsonc` | Cloudflare 설정 |
| `.github/workflows/deploy-cloudflare.yml` | GitHub에 올리면 자동 배포 |

### 시험 결과 (내 PC, 2026-11-17)
- 공개 화면 7개 (대회 안내·소개·약관·개인정보·점수계산기·혜택·대회 목록): 기존 파이썬 사이트와 **화면 내용이 똑같음** (같은 HTML 출력)
- 회원·대회 흐름 시험 통과: 가입 → 포인트 21P → 대회 개설 → 8명 신청 → 입금 확인(+30P) → 조 편성 → 점수 저장 → 결과·조편성 공개 → 인쇄 3종 → CSV → 신청 취소 → 혜택 교환·수량 소진 → 탈퇴 → 일반 회원의 관리자 화면 접근 차단
- 서버 오류 0건
- **아직 확인하지 못한 것**: 날씨. 내 PC 인터넷에서는 날씨 서비스(Open-Meteo)에 접속이 안 됩니다. Cloudflare 배포 후 확인합니다.

## 4. 이전 순서 (운영자가 할 일)

### ① Cloudflare 가입 (무료)
1. https://dash.cloudflare.com/sign-up 에서 이메일로 가입합니다.
2. **유료 요금제(Workers Paid)는 구독하지 않습니다.** 무료(Free)로 충분합니다.
3. 왼쪽 메뉴 **Workers & Pages**를 한 번 눌러 둡니다. 이때 workers.dev 주소 이름을 정하라고 하면 원하는 영문 이름을 넣습니다.

### ② 배포용 열쇠(API 토큰) 만들기
1. 오른쪽 위 사람 아이콘 → **My Profile** → **API Tokens** → **Create Token**
2. **Edit Cloudflare Workers** 템플릿 옆 **Use template**
3. 권한 목록에 **D1 → Edit** 가 없으면 **+ Add more**로 추가합니다. 데이터베이스를 자동으로 만드는 데 필요합니다.
4. Account Resources는 내 계정, Zone Resources는 **All zones** → **Continue** → **Create Token**
5. 화면에 한 번만 보이는 토큰 값을 복사해 둡니다. **채팅이나 메일에 붙이지 마세요.**
6. **계정 ID**: Workers & Pages 화면 오른쪽의 **Account ID** 를 복사합니다.

### ③ GitHub에 열쇠 2개 등록
1. https://github.com/yhjang75-blip/parkgolf → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
2. 다음 두 개를 등록합니다 (이름은 글자 그대로):
   - `CLOUDFLARE_API_TOKEN` = ②에서 복사한 토큰
   - `CLOUDFLARE_ACCOUNT_ID` = 계정 ID
3. 이미 등록했다면 값이 맞는지만 확인합니다. 값은 다시 볼 수 없으니, 헷갈리면 **Update**로 새로 넣습니다.

### ④ 배포 (Claude가 진행)
1. 새 코드를 GitHub에 올리면 자동 배포가 시작됩니다.
2. 처음 배포할 때 Cloudflare가 데이터베이스(`nicepark`)를 자동으로 만듭니다.
3. 배포 결과: https://github.com/yhjang75-blip/parkgolf/actions 에서 초록 ✔ 이면 성공입니다.
4. 사이트 주소: `https://nicepark.<①에서 정한 이름>.workers.dev`

### ⑤ 카카오 로그인 연결
1. Cloudflare → Workers & Pages → **nicepark** → **Settings** → **Variables and Secrets** → **Add**
   - `KAKAO_REST_API_KEY` (종류: Secret) = 카카오 앱 REST API 키 (Render에 넣은 것과 같은 값)
   - `ADMIN_KAKAO_IDS` (종류: Secret) = 관리자 카카오 회원번호
   - `KAKAO_CLIENT_SECRET` = 카카오에서 '클라이언트 시크릿'을 켠 경우에만
2. 카카오 개발자 콘솔 → 내 애플리케이션 → 카카오 로그인 → **Redirect URI** 에 아래 주소를 **추가**합니다. Render 주소는 지우지 않습니다.
   `https://nicepark.<이름>.workers.dev/auth/kakao/callback`
3. 카카오 콘솔 **플랫폼 → Web 사이트 도메인** 에도 `https://nicepark.<이름>.workers.dev` 를 추가합니다.

### ⑥ 확인
| 확인할 것 | 방법 | 정상 |
|---|---|---|
| 설정 상태 | 주소 뒤에 `/status` | 데이터베이스 "연결됨", 카카오키 true, 관리자번호 true |
| 첫 화면 | 주소 열기 | 구장 수·목록·지도가 나옴 |
| 날씨 | 구장 하나 눌러 상세 보기 | 오늘·3일 날씨가 나옴 |
| 로그인 | 로그인·가입 → 카카오 | 가입 동의 화면 → 20포인트 |
| 관리자 | 로그인 후 위쪽 메뉴 | '관리' 메뉴가 보임 |
| 대회 | 관리 → 대회 개설 → 숨김 해제 | '대회 참가'에 보임 |

### ⑦ 전환 마무리 (확인이 끝난 뒤)
1. 안내물·홍보에 새 주소를 씁니다.
2. 1~2주 문제가 없으면 Render 서비스를 정지합니다. 그 뒤 파이썬 서버 파일(`app.py`, `community.py`, `compete.py`, `db.py`, `templates/`, `render.yaml`, `requirements.txt`)을 정리합니다. 구장 자료를 만드는 `scripts/*.py` 는 계속 씁니다.
3. 그때까지는 **화면을 고치면 `templates/`(Render)와 `worker/views/`(Cloudflare) 두 곳을 모두 고쳐야 합니다.**

## 5. 위험과 대응

| 위험 | 가능성 | 대응 |
|---|---|---|
| 배포 실패 (토큰 권한 부족) | 중간 | GitHub Actions 빨간 ✕ → '배포' 단계의 빨간 글씨를 캡처해 Claude에게 전달 |
| 요청 한 건 계산 시간 10ms 초과 | 낮음 | Cloudflare → nicepark → **Observability**에서 오류 확인. 대회 안내 화면처럼 큰 화면은 미리 만들어 두는 방식으로 바꿀 수 있음 |
| 하루 10만 요청 초과 | 낮음 | 넘는 날만 일부 실패. 늘어나면 유료 전환 검토 |
| 카카오 로그인 실패 | 중간 | Redirect URI 철자 확인 (https, 끝의 `/auth/kakao/callback`) |
| 되돌리기 | — | Render 사이트가 그대로 살아 있음. 안내 주소만 다시 바꾸면 됨 |

## 6. 앞으로 고치는 법

| 고칠 것 | 위치 |
|---|---|
| 화면 문구·모양 | `worker/views/*.html` (CSS·JS는 `static/` — 두 사이트 공통) |
| 구장 자료 | 지금처럼 `scripts/*.py` 로 `data/courses.json` 을 만들면 다음 배포 때 자동 반영 |
| 대회 안내·뉴스 검색어·영상 채널 | `data/media.json` |
| 운영자 정보 (소개·약관) | `data/site.json` |
| 내 PC에서 미리 보기 | `npx wrangler dev` → http://localhost:8787 (시험용 로그인: `.dev.vars` 파일에 `DEV_LOGIN=1`) |
