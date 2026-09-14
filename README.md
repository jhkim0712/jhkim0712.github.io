# jhkim0712.github.io

개인 GitHub Pages 웹사이트입니다.

## 🌐 사이트 바로가기

👉 [https://jhkim0712.github.io](https://jhkim0712.github.io)

## 🛠️ 기술 스택

- **HTML** — 페이지 구조
- **CSS** — 스타일 및 레이아웃
- **JavaScript** — 인터랙션

## 📁 프로젝트 구조

```
jhkim0712.github.io/
├── index.html                          # 메인 페이지
├── config.json                         # 퍼시스턴트 설정값(GitHub 정보, API 키 등)
├── tracks.json                         # 라이딩 트랙 메타데이터(제목/설명/relive 링크 등)
├── tracks/                             # GPX 원본 파일
├── assets/
│   ├── css/style.css                   # 스타일시트
│   ├── js/main.js                      # 지도/목록 렌더링
│   └── data/track-overview.json        # 첫 화면용 경량 미리보기 좌표(자동 생성)
├── scripts/build-track-overview.js     # track-overview.json 생성 스크립트
├── .github/workflows/build-track-overview.yml  # push 시 위 스크립트 자동 실행
└── README.md
```

## ⚙️ 설정값 (config.json)

API 키, GitHub 저장소 정보 등 배포마다 달라질 수 있는 퍼시스턴트 설정값은 코드가 아니라
루트의 [config.json](config.json)에 모아뒀다. 페이지 로드 시 이 파일을 제일 먼저 읽어온 뒤
지도/트랙 목록을 초기화한다.

```json
{
  "github": { "owner": "...", "repo": "...", "branch": "...", "manifestPath": "..." },
  "homeObfuscation": { "center": "...", "radiusKm": 0.2 },
  "vworld": { "apiKey": "...", "issuedAt": "...", "expiresAt": "..." },
  "naver": { "apiKeyId": "...", "issuedAt": "...", "expiresAt": "..." },
  "overviewPath": "assets/data/track-overview.json",
  "defaultBasemap": "osm"
}
```

- `github.*`, `homeObfuscation.center`는 raw GPX가 걸려있는 저장소 경로와 실제 홈 위치를
  view-source로 바로 못 읽게 XOR + Base64로 인코딩되어 있다 (진짜 보안이 아니라 가벼운
  난독화다 — `assets/js/main.js`의 `_ds`/`_d` 함수가 로드 시점에 복원함).
- `vworld.apiKey`, `naver.apiKeyId`는 평문이다. VWorld/Naver/Google Maps류 클라이언트 키는
  애초에 브라우저에 노출되는 게 정상적인 사용 방식이고(비밀키가 아니라 도메인 제한으로
  보호), 그래서 다른 값처럼 인코딩하지 않았다.

## 🏠 홈 위치 보호

`homeObfuscation.center`(홈 위치 부근) 반경 `radiusKm` 안에 들어오는 경로 구간은 지도에
아예 그리지 않는다(그 지점에서 선이 끊김). 예전에는 가짜 디코이 경로를 그 주변에 덧그려
눈속임하는 방식이었는데, 어차피 raw GPX나 `track-overview.json`을 직접 열어보면 실좌표가
그대로 드러나 실효성이 없어 걷어냈다.

- `assets/data/track-overview.json`(첫 화면용 개요 좌표)은 `scripts/build-track-overview.js`가
  생성 시점에 홈 반경 내 좌표를 미리 제거하므로, 이 파일을 직접 열어봐도 반경 안쪽 좌표는
  나오지 않는다.
- 원본 GPX(`tracks/**.gpx`)는 raw.githubusercontent.com으로 직접 fetch되는 원본 파일이라
  전체 좌표를 그대로 담고 있다. 대신 `assets/js/main.js`가 정밀 경로를 불러온 직후
  (`maskHomeAreaOnLayer`) 반경 내 구간을 지도에서 제거하고 그린다.
- 즉 지도 화면과 개요 데이터 파일에서는 홈 반경이 보이지 않지만, 원본 GPX 파일 자체를
  받아보면 여전히 실좌표가 남아있다 — 저장소가 공개(public)인 이상 완전히 막을 방법은
  없고, 이 정도가 정적 사이트에서 할 수 있는 실질적인 선이다.

## 🗺️ 배경지도 선택 (OSM / VWorld / 네이버지도)

좌측 패널 검색창 옆 드롭다운에서 배경지도를 OSM(기본값)·브이월드(VWorld)·네이버지도 중 골라
바로 바꿀 수 있다. 선택은 브라우저 `localStorage`에 저장돼서 다음에 열어도 유지된다.

VWorld는 국토교통부 국토지리정보원이 제공하는 국가 공간정보 서비스라, 군사시설 등 보안시설
주변을 국가 공간정보 보안관리규정에 따라 이미 자체적으로 마스킹해서 서비스한다.

VWorld를 쓰려면 API 키가 필요하다 (키가 없어도 OSM은 그대로 잘 동작함):

1. [www.vworld.kr](https://www.vworld.kr) 회원가입 후 **오픈API → 인증키 신청**.
2. 신청 시 서비스 URL에 `https://jhkim0712.github.io` (로컬 테스트도 하려면 `http://localhost`
   또는 사용 중인 포트도 함께) 를 등록.
3. 발급받은 인증키를 [config.json](config.json)의 `vworld.apiKey` 값에 붙여넣기.
   (심사는 보통 당일~1일 내 완료됨)
4. 키를 넣기 전까지 드롭다운에서 VWorld를 선택하면 타일 대신 안내 문구가 뜬다.

### 네이버지도

네이버(NCP, Naver Cloud Platform)는 OSM/VWorld처럼 Leaflet에 바로 꽂을 수 있는 공개 XYZ
타일을 제공하지 않는다. 대신 네이버 Maps JS SDK(v3)가 자체적으로 그리는 별도의 지도 div를
쓴다. 그래서 네이버지도를 선택하면 화면 뒤에서 Leaflet 지도(`#map`)는 그대로 살아있는 채로
숨겨지고, 네이버 SDK가 그리는 지도(`#map-naver`)가 앞에 보이는 방식으로 동작한다. 트랙 경로는
Leaflet이 이미 파싱해 둔 좌표를 그대로 재사용해 네이버 폴리라인으로 옮겨 그린다(GPX를 두 번
파싱하지 않음).

네이버지도를 쓰려면 Client ID가 필요하다 (키가 없어도 OSM/VWorld는 그대로 잘 동작함):

1. [console.ncloud.com](https://console.ncloud.com) 가입 후 **AI·NAVER API → Application →
   Application 등록**.
2. 등록 시 **Maps > Web Dynamic Map** 서비스를 활성화하고, Web 서비스 URL에
   `https://jhkim0712.github.io` (로컬 테스트도 하려면 `http://localhost` 또는 사용 중인
   포트도 함께) 를 등록.
3. 발급받은 **Client ID**를 [config.json](config.json)의 `naver.apiKeyId` 값에 붙여넣기.
   (Client Secret은 필요 없음 — Maps JS SDK는 Client ID만 사용)
4. 키를 넣기 전까지, 또는 도메인이 등록되지 않아 인증에 실패하면 드롭다운에서 네이버지도를
   선택해도 지도 대신 안내 문구가 뜨고 자동으로 OSM으로 돌아간다.

## 🏍️ 새 GPX 트랙 추가하기

1. `tracks/연도/월/` 아래에 GPX 파일을 추가.
2. `tracks.json`에 항목 추가 (`path`, `title`, `description`, `date`, `region`, `bike` 등).
   - Relive 기록이 있으면 `"relive": "https://www.relive.com/view/..."` 필드를 추가하면
     목록에 🎬 Relive 새 탭에서 보기 링크가 생김. relive.com/.cc는 자체 보안 정책(X-Frame-Options)
     상 다른 사이트 안에 iframe으로 띄우는 걸 막아둬서, 지도 위 오버레이 대신 새 탭으로 열림.
3. (선택) `node scripts/build-track-overview.js` 를 로컬에서 실행해 `assets/data/track-overview.json`
   을 갱신하고 함께 커밋. 실행을 잊더라도 GitHub Actions(`build-track-overview.yml`)가 push 시
   자동으로 재생성해서 커밋해준다.

## ⚡ 성능 메모

GPX 원본은 트랙당 수천~수만 개의 포인트를 담고 있어서, 트랙 수가 늘어날수록 첫 화면에서
전부 내려받아 파싱하면 로드 시간이 계속 길어진다. 이를 피하기 위해:

- 빌드 스크립트가 각 GPX를 Douglas-Peucker 알고리즘으로 단순화(트랙당 최대 ~220포인트)해
  `assets/data/track-overview.json` 에 저장해두고, 첫 화면은 이 가벼운 파일 하나만 읽어 즉시 그림.
- 정밀 원본 GPX는 트랙을 클릭했을 때 즉시, 그 외에는 브라우저 유휴 시간에 백그라운드로
  순차적으로 불러와 개요 경로를 정밀 경로로 자연스럽게 교체함.

같은 빌드 스크립트가 GPX의 (단순화 전) 전체 포인트를 하버사인 공식으로 이어서 총 이동거리도
계산해 `distanceKm`로 함께 저장하고, 목록에 🛣️ 배지로 표시한다. 개요 데이터가 없는 트랙은
정밀 GPX가 로드된 뒤 leaflet-gpx가 계산한 거리로 대신 채운다.

## 📄 라이선스

이 프로젝트는 개인 용도로 제작되었습니다.
