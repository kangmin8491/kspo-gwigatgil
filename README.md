# 공연 끝, 귀갓길 (가칭) — 시연용 모바일 웹

2026 한국체육산업개발 공공데이터 활용 경진대회 응모작의 시연 화면입니다.
KSPO DOME 공연이 끝난 뒤 한얼광장 ‘88서울올림픽’ 조각 앞에서 출발해 **어느 정류장의 어느 쪽에 서야 하는지**, 지하철은 어느 출구로 가는지를 보여 줍니다.

- 시연 회차: 2025-11-01(토) 18:00 KSPO DOME ‘IVE WORLD TOUR [SHOW WHAT I AM]’ 서울 2회차 (같은 시각 올림픽홀 신승훈 공연)
- 방면: 버스 3214 마천동(정류소 24244) · 강변역(24245) / 지하철 올림픽공원역 4번 출구 · 한성백제역 2번 출구(혼잡 시)

## 화면과 주소

| 주소 | 화면 |
| --- | --- |
| `#/` | 1. 공연 선택 |
| `#/dir` | 2. 방면 선택 |
| `#/go/bus-machon`, `#/go/bus-gangbyeon` | 3. 버스 탑승 위치 (정류소 번호·다음 정류장·서는 쪽·도보·도착 예정·막차·지도) |
| `#/go/subway-olympic`, `#/go/subway-hanseong` | 3. 지하철 출구·도보·5호선 방면 주의·막차 링크·지도 |
| `#/car` | 자가용 출차 그래프 (`public/data/exit_counts.json`이 있으면 그래프, 없으면 ‘집계 준비 중’) |

### 모드

- **시연 모드(기본)** — 상단에 ‘시연 모드 · 2025년 11월 1일 기준’ 고정. 버스 도착은 **예시값**이며 화면에 ‘예시’ 표시가 붙습니다.
  버스 카드 아래 ‘시연 상황 바꾸기’ 또는 주소 인자로 상태를 재현합니다.

  | 인자 | 상황 (모두 예시값) |
  | --- | --- |
  | (없음) 또는 `?s=basic` | 20:50. 마천동 9·22분 후 → 탈 수 있음 / 강변역 5·18분 후 → 첫 버스 흐리게, 다음 버스 강조 |
  | `?s=hurry` | 21:10. 도착 − 도보가 1분 → ‘서두르면 가능’ |
  | `?s=ended` | 00:40. 막차 이후 → ‘운행 종료’ + 지하철 안내 |
  | `?s=fail` | 조회 실패 → ‘조회 불가’ + 서울시 버스정보 링크 |

  예: `/?s=hurry#/go/bus-gangbyeon`
- **실시간 모드** — 상단 ‘실시간’ 버튼 또는 `?mode=live`. 서버리스 함수 `/api/bus`가 서울시 버스도착정보를 대신 호출합니다. 30초마다 다시 조회합니다. 공연은 시연 회차로 고정됩니다.

판정 규칙: `도착 예정 − 도보 ≥ 2분` 탈 수 있음, `0 ~ 2분` 서두르면 가능, `0분 미만` 첫 버스를 흐리게 하고 다음 버스를 강조. 2분은 기획서의 초기값(`public/app.js`의 `HURRY_MARGIN_MIN`).

## 폴더

```
web/
├─ public/                 정적 파일 (Cloudflare Pages 출력 폴더)
│  ├─ index.html, app.css, app.js
│  └─ data/
│     ├─ routes.json       ← 소스/귀가동선.json 복사본 (원본을 고치면 다시 복사)
│     ├─ subway_paths.json 지하철 도보 경로선 (OSRM, 2026-11-24 조회)
│     └─ exit_counts.json  (나중에) 출차 그래프 데이터
├─ functions/api/bus.js    Pages Function: 서울시 버스 API 대리 호출, 정류장별 30초 캐시
├─ scripts/
│  ├─ make_exit_counts.py  출차_10분_게이트별.csv → exit_counts.json
│  └─ screenshots.mjs      375px 캡처 (screenshots/)
└─ screenshots/            기획서용 캡처
```

## 로컬 실행

```sh
cd web
npm install                 # wrangler 설치 (처음 한 번)

# 1) 화면만 볼 때 (시연 모드) — 정적 서버면 충분
python3 -m http.server 8788 --directory public

# 2) 실시간 모드까지 볼 때 — Pages Functions 포함
#    web/.dev.vars 파일에 아래 한 줄을 직접 적는다 (Git 제외됨)
#    SEOUL_BUS_SERVICE_KEY=(루트 .env.local의 같은 이름 값과 동일)
npm run dev                 # http://localhost:8788
```

캡처 다시 찍기: 로컬 서버를 띄운 상태에서 `npm run shots` (Google Chrome 필요).

## 배포 (Cloudflare Pages + Functions, 무료 요금제)

```sh
cd web
npx wrangler login                         # 처음 한 번, 브라우저에서 Cloudflare 계정 로그인
npm run deploy                             # 프로젝트 kspo-gwigatgil 로 public/ + functions/ 업로드
npx wrangler pages secret put SEOUL_BUS_SERVICE_KEY --project-name kspo-gwigatgil
                                           # 입력창에 키를 붙여 넣는다 (명령줄·로그에 남지 않음)
npm run deploy                             # 비밀값 반영을 위해 한 번 더 배포
```

배포 주소는 `https://kspo-gwigatgil.pages.dev` 형태로 나옵니다(이름이 이미 쓰였으면 다른 주소). GitHub 저장소를 Cloudflare Pages에 연결해 자동 배포해도 됩니다(빌드 명령 없음, 출력 폴더 `public`, 루트 `web`).

### 서버 함수 메모

- 호출: `http://ws.bus.go.kr/api/rest/arrive/getArrInfoByRoute` (https는 시간 초과라 http), 노선 `100100213`(3214)
  - 마천동 방면 `stId=123000154`, `ord=44` / 강변역 방면 `stId=123000155`, `ord=17`
- 응답 `msgBody.itemList[0]`의 `arrmsg1·2`, `traTime1·2`(초), `isLast1·2`, `firstTm`, `lastTm`, `term`, `mkTm`만 정리해 돌려줍니다.
- 캐시: 함수 메모리 30초 + Cloudflare Cache API 30초(Cache API는 커스텀 도메인에서만 동작). 이용자가 많아도 정류장당 30초에 1회 수준.
- 실패(시간 초과·키 오류·형식 오류)는 캐시하지 않고 `{ok:false}`(502)를 돌려주며, 화면은 ‘조회 불가’로 바뀝니다. 인증키는 응답·로그에 남기지 않습니다.

## 출차 그래프 데이터 형식 (`public/data/exit_counts.json`)

`python3 scripts/make_exit_counts.py --date 2025-11-01 --compare <비교일...>`로 만듭니다. 비교일은 아직 정하지 않았습니다.

```json
{
  "schema": "exit_counts/v1",
  "dataset": { "name": "올림픽공원 입출차정보(전체구역)", "provider": "한국체육산업개발", "id": "data.go.kr 15159093" },
  "generated_at": "2026-11-26T10:00:00+09:00",
  "source_file": "출차_10분_게이트별.csv",
  "bin_minutes": 10,
  "bins": ["16:00", "16:10", "…", "23:50"],
  "gates": ["남2문", "동2문", "북2문"],
  "event_day": { "date": "2025-11-01", "label": "2025-11-01 공연일 (KSPO DOME·올림픽홀)",
                 "counts": { "동2문": [0, 0, "…bins와 같은 길이"], "남2문": [], "북2문": [] } },
  "comparison": { "dates": ["비교일1", "비교일2"], "method": "median", "label": "비교일 2일 중앙값",
                  "counts": { "동2문": [] } },
  "markers": { "surge_start": "20:40", "peak": "21:00" },
  "notes": ["가로축은 시계 시간입니다. …"]
}
```

- `counts`의 배열은 `bins` 순서와 길이가 같습니다(10분 구간 시작 시각).
- `comparison`·`markers.surge_start`는 비교일이 없으면 `null`. `peak`는 공연일 전체 게이트 합계가 가장 큰 구간.
- 화면은 ‘전체 게이트/게이트별’ 전환, 공연일 막대 + 비교일 중앙값 가는 선, 표로 보기를 제공합니다.

## 데이터 출처

| 데이터 | 제공 | 쓰는 곳 |
| --- | --- | --- |
| 올림픽공원 공연정보 (data.go.kr 3037877) | 한국체육산업개발 | 공연명·장소·일시 (동선표에 반영) |
| 올림픽공원 입출차정보(전체구역) (data.go.kr 15159093) | 한국체육산업개발 | 출차 그래프 (집계 예정) |
| 버스도착정보조회 서비스 (data.go.kr 15000314) | 서울특별시 | 실시간 도착 예정·막차 |
| 버스 노선별 정류소 정보 (서울 열린데이터광장 OA-1095) | 서울특별시 | 정류소 번호·순번·다음 정류장 |
| OpenStreetMap 보행로·지도 타일, OSRM 보행 경로 | OpenStreetMap 기여자 | 도보 경로선·거리 추정, 지도 |
| 공연장·출구 안내 | 예매처 공연장 안내, 올림픽공원 공식 안내 | 출발점·출구 설명 |

도보 거리·시간은 2026-11-24 지도 경로 기반 추정이며 신호 대기·인파·현장 통제를 반영한 실측이 아닙니다. 막차 시각(마천동 00:22, 강변역 23:39)은 2026-11-24 서울시 응답 값이며 2025-11-01 당일 값이 아닙니다.

## 라이선스

- 이 저장소의 코드: MIT (`LICENSE`)
- 지도 데이터·타일: © OpenStreetMap 기여자, [ODbL](https://www.openstreetmap.org/copyright). 화면 지도에 출처를 표기합니다.
- 지도 라이브러리: [Leaflet](https://leafletjs.com) (BSD-2-Clause), CDN(unpkg)으로 불러옴
- 공공데이터: 각 제공기관의 이용 조건(공공데이터포털·서울 열린데이터광장)을 따릅니다.
