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
  "homeObfuscation": { "center": "...", "radiusKm": 0.2, "count": 6, "seed": 12345 },
  "vworld": { "apiKey": "...", "issuedAt": "...", "expiresAt": "..." },
  "overviewPath": "assets/data/track-overview.json",
  "defaultBasemap": "osm"
}
```

- `github.*`, `homeObfuscation.center`는 raw GPX가 걸려있는 저장소 경로와 실제 홈 위치를
  view-source로 바로 못 읽게 XOR + Base64로 인코딩되어 있다 (진짜 보안이 아니라 가벼운
  난독화다 — `assets/js/main.js`의 `_ds`/`_d` 함수가 로드 시점에 복원함).
- `vworld.apiKey`는 평문이다. VWorld/Naver/Google Maps류 클라이언트 키는 애초에 브라우저에
  노출되는 게 정상적인 사용 방식이고(비밀키가 아니라 도메인 제한으로 보호), 그래서 다른
  값처럼 인코딩하지 않았다.

## 🗺️ 배경지도 선택 (OSM / VWorld)

좌측 패널 검색창 옆 드롭다운에서 배경지도를 OSM(기본값)과 브이월드(VWorld) 중 골라 바로 바꿀
수 있다. 선택은 브라우저 `localStorage`에 저장돼서 다음에 열어도 유지된다.

VWorld는 국토교통부 국토지리정보원이 제공하는 국가 공간정보 서비스라, 군사시설 등 보안시설
주변을 국가 공간정보 보안관리규정에 따라 이미 자체적으로 마스킹해서 서비스한다.

VWorld를 쓰려면 API 키가 필요하다 (키가 없어도 OSM은 그대로 잘 동작함):

1. [www.vworld.kr](https://www.vworld.kr) 회원가입 후 **오픈API → 인증키 신청**.
2. 신청 시 서비스 URL에 `https://jhkim0712.github.io` (로컬 테스트도 하려면 `http://localhost`
   또는 사용 중인 포트도 함께) 를 등록.
3. 발급받은 인증키를 [config.json](config.json)의 `vworld.apiKey` 값에 붙여넣기.
   (심사는 보통 당일~1일 내 완료됨)
4. 키를 넣기 전까지 드롭다운에서 VWorld를 선택하면 타일 대신 안내 문구가 뜬다.

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

## 📄 라이선스

이 프로젝트는 개인 용도로 제작되었습니다.
