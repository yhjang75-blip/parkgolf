# 나이스파크 — 전국 파크골프장 예약·대회 소식

전국 파크골프장의 위치, 홀 수, 필드 상태를 한곳에서 보고 각 구장의 **공식 예약 페이지로 바로 이동**하는 웹사이트입니다.
PC와 스마트폰 브라우저에서 같은 주소로 쓸 수 있습니다.

- 의도 문서: [docs/PG-001-전국-파크골프장-현황-통합예약.md](docs/PG-001-전국-파크골프장-현황-통합예약.md)
- 예약은 이 사이트가 하지 않습니다. 운영기관의 공식 사이트나 전화로 연결만 합니다.

## 1. 내 PC에서 실행

```powershell
cd parkgolf
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python app.py
```

브라우저에서 http://127.0.0.1:5000 을 엽니다.
같은 와이파이에 연결된 휴대폰에서는 `http://<PC의 IP 주소>:5000` 으로 열 수 있습니다.

## 2. 자료 새로 고치기

자료는 `data/courses.json` 한 파일에 들어 있습니다. 공공데이터포털에 새 자료가 올라오면 다음 순서로 다시 만듭니다.

| 순서 | 명령 | 하는 일 |
|---|---|---|
| 1 | `.venv\Scripts\python scripts\collect.py` | `sources.json` 에 적힌 공공데이터포털 파일을 `data/raw/` 로 내려받음 |
| 2 | `.venv\Scripts\python scripts\build.py` | 파일들을 공통 형식으로 맞추고 중복 구장을 합쳐 `data/courses.json` 생성 |
| 3 | `.venv\Scripts\python scripts\geocode.py` | 좌표가 없는 구장의 위치를 주소로 찾음 (찾은 결과는 저장해 두고 다시 묻지 않음) |
| 4 | `.venv\Scripts\python scripts\build.py` | 찾은 위치를 반영 |
| 5 | `.venv\Scripts\python scripts\check_links.py` | 예약 페이지 주소가 열리는지 점검 → `data/link_report.json` |

- **새 데이터셋 추가**: 공공데이터포털에서 찾은 데이터셋 번호(주소의 `/data/숫자/`)를 `sources.json` 에 넣고 1번부터 실행합니다.
  자료에 시·도가 빠져 있으면 `scripts/build.py` 의 `DEFAULT_SIDO` 에도 넣어 줍니다.
- **사람이 확인한 정보 넣기**: 예약 주소, 잔디 종류, 코스 길이 등을 직접 확인했으면 `data/manual_overrides.json` 에 구장 id 별로 적습니다.
  구장 id 는 사이트에서 구장을 열었을 때 주소창의 `#id=...` 값입니다.

### 예약 안내 단계

`scripts/build.py` 가 구장마다 예약 단계를 정합니다.

| 단계 | 뜻 | 근거 |
|---|---|---|
| 온라인 예약 | 구장 예약 주소 확인 | 공개 자료, `manual_overrides.json` |
| 지자체 예약 | 시·군·구(공단) 통합예약 사이트에서 구장을 골라 예약 | `data/gov_sites.json` 의 `portal` |
| 전화·현장 | 인터넷 예약 경로를 못 찾음 (현장 선착순·전화 예약이 많음) | 전화번호만 있음 |
| 확인 필요 | 예약 정보 없음 | |

- 통합예약 사이트 후보 찾기: `.venv\Scripts\python scripts\find_reserve_sites.py` → `data/reserve_probe.json` 을 보고 `gov_sites.json` 에 옮겨 적습니다.
- `portal.parkgolf: true` 는 예약 사이트 첫 화면에 '파크골프'가 보이는 곳입니다.

### 대표 사진

`data/photos.json` 의 사진을 씁니다. 사진이 없는 구장은 그림으로 대신 보여 줍니다.

```powershell
$env:KAKAO_REST_API_KEY = "카카오 REST API 키"   # https://developers.kakao.com (무료)
.venv\Scripts\python scripts\photos.py           # 카카오 이미지 검색으로 구장마다 1장
.venv\Scripts\python scripts\build.py
```

검색으로 찾은 사진은 다른 곳 사진일 수 있습니다. 틀린 사진은 주소를 `data/photo_blocklist.json` 에 넣고
`photos.py --retry` 를 실행하면 그 구장만 다음 후보로 다시 찾습니다.
직접 찍었거나 허락받은 사진은 `photos.json` 에 `"method": "직접"` 으로 넣습니다 (다시 찾아도 덮어쓰지 않음).

### 첫 화면 소식

`data/media.json` 에서 설정합니다.
- 대회 기사·우승 소식·뉴스: Google 뉴스 RSS (검색어 `news_queries`, 30분마다 새로 고침)
- 대회 영상: `youtube_channels` 에 적은 유튜브 채널의 공식 RSS 에서 '파크골프' 영상 (1시간마다). 못 읽으면 `fallback_videos` 를 보여 줌
- 주요 대회 일정: `tournaments` 에 사람이 확인해 적음 (날짜가 지나면 자동으로 '종료')

### 더 정확한 위치 (선택)

키 없이 쓰는 OpenStreetMap 은 대부분 읍·면·동 중심점만 찾습니다. 화면에는 "대략 위치"로 표시됩니다.
무료 키를 받아 넣으면 번지 단위의 정확한 위치를 찾습니다.

```powershell
$env:VWORLD_KEY = "브이월드에서 받은 키"          # https://www.vworld.kr (국토교통부, 무료)
# 또는
$env:KAKAO_REST_API_KEY = "카카오 REST API 키"   # https://developers.kakao.com (무료)
.venv\Scripts\python scripts\geocode.py
.venv\Scripts\python scripts\build.py
```

## 3. 인터넷에 무료로 올리기 (Render)

1. 이 `parkgolf` 폴더를 GitHub 저장소에 올립니다 (`.venv` 는 제외됨).
2. https://render.com 에 가입하고 **New → Blueprint** 에서 그 저장소를 고릅니다. `render.yaml` 설정이 자동으로 적용됩니다.
3. 몇 분 뒤 `https://parkgolf-xxxx.onrender.com` 같은 주소가 생깁니다. PC와 휴대폰에서 이 주소로 접속합니다.

무료 요금제는 15분 동안 접속이 없으면 잠들고, 다음 접속 때 깨어나는 데 30초~1분 걸립니다.

## 4. 구성

```
app.py                  Flask 서버 (화면, /api/courses, /api/meta, /api/weather/<id>,
                        /api/news, /api/videos, /api/tournaments)
templates/index.html    화면 뼈대
static/app.js           검색·필터·지도·상세 화면
static/style.css        PC·휴대폰 화면 디자인 (큰 글씨)
scripts/                자료 수집·정리·위치 찾기·링크 점검
data/courses.json       사이트가 쓰는 최종 자료
data/raw/               공공데이터포털 원본 파일과 출처 목록(manifest.json)
```

## 5. 자료와 이용 조건

| 항목 | 출처 | 이용 조건 |
|---|---|---|
| 구장 목록·홀 수·주소·운영 정보 | 공공데이터포털 지자체·시설관리공단 자료 21건 | 이용허락범위 제한 없음 (각 자료 페이지 확인) |
| 지도 | OpenStreetMap | ODbL, 출처 표시 |
| 위치(대략) | OpenStreetMap Nominatim | ODbL, 1초 1건 이하 |
| 날씨 | Open-Meteo | 비상업 무료, 출처 표시 (상업적으로 쓰면 유료 요금제 또는 기상청 API로 교체) |

원자료에 없는 값은 만들어 넣지 않고 화면에 "정보 없음"으로 표시합니다.
