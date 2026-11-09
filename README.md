# 은월 런처 (Eunwol Launcher)

마인크래프트 **26.2 (Fabric)** 를 실행하는 Electron 기반 커스텀 런처입니다.
Helios Launcher 를 기반으로 만들었으며, 군더더기 없이 게임 실행에만 집중합니다.

- 마인크래프트 **26.2** / Fabric Loader **0.20.1**
- Microsoft 계정 로그인
- Java 25 자동 감지·다운로드 (없으면 Temurin JDK 를 내려받습니다)
- **모드는 기본 미포함** — 설정 → 모드에서 jar 를 직접 추가/관리합니다
- 한국어 / English

---

## 다운로드 & 설치

릴리즈를 배포하고 있다면 아래 형식의 설치 파일을 받으세요.

| 플랫폼 | 파일 |
| --- | --- |
| Windows (x64) | `Eunwol-Launcher-setup-<버전>.exe` |
| macOS (Apple Silicon) | `은월 런처-setup-<버전>-arm64.dmg` |
| macOS (Intel) | `은월 런처-setup-<버전>-x64.dmg` |

설치 후 바탕화면의 **은월 런처** 아이콘을 실행하면 됩니다.

---

## 사용 방법

1. 런처를 실행합니다.
2. **Microsoft 계정으로 로그인**합니다.
3. **PLAY** 를 누릅니다.

모드를 넣고 싶다면 **설정 → 모드** 에서 jar 파일을 추가하면 됩니다.

첫 실행 때는 게임 파일과 Java(약 200MB)를 내려받기 때문에 시간이 걸립니다.
두 번째 실행부터는 변경된 파일만 확인합니다.

---

## 문제 해결

로그 파일 위치:

```
%APPDATA%\은월 런처\logs\launcher.log
%APPDATA%\.eunwol\instances\eunwol\logs\latest.log
```

- 창이 뜨지 않으면 `--no-sandbox` 옵션으로 실행해 보세요.
- 게임 폴더: `%APPDATA%\.eunwol\instances\eunwol`
- 모드 폴더: `%APPDATA%\.eunwol\instances\eunwol\mods` (설정 → 모드의 "폴더 열기")
- 공용 파일(라이브러리·에셋): `%APPDATA%\.eunwol\common`

---

## 개발

### 요구 사항

- Node.js 22 이상
- Python 3 + Pillow, numpy (브랜딩 이미지를 다시 만들 때만)

### 실행

```bash
npm install
npm start
```

### 빌드

```bash
# Windows 설치 파일
npm run dist:win

# 패키지만 (설치 파일 없이 실행 폴더)
npm run pack
```

결과물은 `dist/` 에 생성됩니다.

### 구조

```
index.js                 메인 프로세스 (창 생성, IPC, 자동 업데이트, 로그)
app/
  app.ejs                메인 화면 (frame + 각 화면 include)
  landing.ejs            홈 화면 (계정, PLAY, Mojang 상태)
  settings.ejs           설정 화면
  assets/
    distribution.json    실행할 마인크래프트/로더 정의 (자동 생성)
    css/                 스타일
    images/              아이콘·배경 (브랜딩)
    js/                  렌더러 스크립트
    lang/                ko_KR / en_US 문구
tools/
  build-distribution.cjs 배포 인덱스 생성기
  verify-distribution.cjs 배포 인덱스 검증 (네트워크 필요)
  make-branding.py       아이콘·로딩 씰·배경 생성기
electron-builder.yml     패키징 설정
```

---

## 버전 / 프로필 바꾸기

`tools/build-distribution.cjs` 위쪽 `CONFIG` 만 고치면 됩니다.

```js
profile: {
    id: 'eunwol',                 // 내부 id (바꾸면 게임 폴더가 새로 생깁니다)
    name: 'Minecraft 26.2',       // 화면에 보이는 이름
    minecraftVersion: '26.2',
    ...
},
fabricLoaderVersion: '0.20.1',
java: { supported: '>=25.x', suggestedMajor: 25, ... }
```

수정 후:

```bash
npm run distro:build     # distribution.json 재생성 (MD5 자동 계산)
npm run distro:verify    # 구조·해시·다운로드 가능 여부 검증
```

> `app/assets/distribution.json` 은 직접 고치지 마세요. `distro:build` 가 덮어씁니다.

---

## 브랜딩 바꾸기

이름·아이콘·배경을 바꾸려면:

1. `package.json` 의 `productName`, `electron-builder.yml` 의 `appId`/`productName`/`artifactName` 수정
2. `app/assets/lang/_custom.toml` 의 창 제목 수정
3. `tools/make-branding.py` 의 색·문구를 고친 뒤 `npm run branding`

---

## 라이선스

이 프로젝트는 [Helios Launcher](https://github.com/dscalzi/HeliosLauncher) 를 기반으로 합니다.
자세한 내용은 [LICENSE.txt](LICENSE.txt) 를 참고하세요.
