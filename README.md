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
