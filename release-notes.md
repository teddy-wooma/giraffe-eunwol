# 은월 런처 1.0.0

마인크래프트 **26.2 (Fabric)** 를 위한 커스텀 런처의 첫 정식 릴리즈입니다.
모드·자바·업데이트를 런처가 관리하므로, 설치하고 로그인한 뒤 PLAY만 누르면 됩니다.

---

## 하이라이트

- **Minecraft 26.2 + Fabric Loader 0.20.1** 지원
- **Microsoft 계정 로그인** (별도 런처 설치 불필요)
- **Java 25 자동 감지·설치** — PC에 자바가 없어도 실행 가능
- **필수 모드 30종 자동 설치·업데이트**
- **모드 탭** — 켜기/끄기, 직접 추가, 삭제
- **자동 업데이트** — 새 버전이 나오면 조용히 설치 후 재실행

---

## 주요 기능

### 게임 실행

- 26.2 전용 프로필 자동 구성 (라이브러리·에셋·네이티브)
- 실행 전 파일 무결성 검사 및 자동 복구
- 게임 해상도, 전체 화면, 런처와 분리 실행 설정
- RAM(최소/최대), 추가 JVM 옵션 설정

### 계정

- Microsoft 계정 로그인·로그아웃
- 여러 계정 등록 및 전환
- 스킨 미리보기

### 모드

- **필수 모드**: 런처가 PLAY 시 자동으로 내려받고 최신 상태로 유지
  - Fabric API, Mod Menu, Cloth Config, Auto-Run, Clear Water
  - Command Keys, Multi Key Bindings, Mozzi Trigger, gfActionbar, Aquatic Log
  - **Dawn Loader 0.2.6**, Sodium, Iris, EMF, ETF, Entity Culling, FerriteCore
  - Bobby, Xaero's 미니맵·월드맵, IPN, MaLiLib, KoreanChat, Shulker Box Tooltip
  - Fabric Language Kotlin, FancyMenu, Melody, Konkrete, Text Placeholder API
- **직접 추가한 모드**: jar/zip/litemod 파일 선택 또는 드래그 앤 드롭
  - 파일명만 바꿔 켜기/끄기 (`.disabled`) — 모드 설정 보존
  - 삭제 시 확인 후 처리

### 기타

- 한국어 / English 인터페이스
- Mojang 서비스 상태 표시
- 진단 로그 기록 (게임이 켜지지 않을 때 원인 추적용)

---

## 이번 버전 변경 사항

- 모드 탭 복원 및 "필수 모드 / 직접 추가한 모드" 구분
- **Dawn Loader 0.2.6** 필수 모드 추가
- GitHub Releases 기반 **자동 업데이트 활성화**
- 업데이트 설치를 무인으로 수행하고 앱을 자동 재실행
- 배포 인덱스 해시 검증 및 26.2 네이티브 라이브러리 처리 안정화

---

## 설치

### Windows (x64)

1. `Eunwol-Launcher-setup-1.0.0.exe` 를 내려받아 실행
2. 설치 후 바탕화면의 **은월 런처** 실행
3. Microsoft 계정 로그인 → **PLAY**

> 이 빌드는 코드 서명이 없어 SmartScreen 경고가 뜰 수 있습니다.
> **추가 정보 → 실행** 을 선택하면 됩니다.

파일 정보

| 항목 | 값 |
| --- | --- |
| 파일명 | `Eunwol-Launcher-setup-1.0.0.exe` |
| 크기 | 99,074,568 bytes (94.5 MB) |
| SHA-256 | `f6e75f29eb4436c6a0499678c3177643ef21d184852a5e1eec7835060152926a` |

### 첫 실행

- 게임 파일과 Java를 자동으로 내려받아 시간이 걸릴 수 있습니다.
- 이후 실행부터는 변경된 파일만 확인합니다.

---

## 알려진 사항

- 코드 서명이 없어 Windows/macOS에서 보안 경고가 표시될 수 있습니다.
- 필수 모드는 배포 인덱스에 등록된 모드이며, 개별적으로 끄는 기능은 제공하지 않습니다.
  (필요 없는 모드는 "직접 추가한 모드" 목록에서 관리하세요.)
- 구버전(자동 업데이트 설정이 없던 1.0.0)을 이미 설치한 경우,
  이 설치 파일로 **한 번만 다시 설치**하면 이후 자동 업데이트가 동작합니다.

---

## 문제 해결

로그 위치

```
%APPDATA%\은월 런처\logs\launcher.log
%APPDATA%\.eunwol\instances\eunwol\logs\latest.log
```

- 창이 뜨지 않으면 `--no-sandbox` 옵션으로 실행해 보세요.
- 모드 폴더: `%APPDATA%\.eunwol\instances\eunwol\mods`
- 게임 폴더: `%APPDATA%\.eunwol\instances\eunwol`

---

## 크레딧

[Helios Launcher](https://github.com/dscalzi/HeliosLauncher) 를 기반으로 제작했습니다.
Minecraft는 Mojang Studios의 상표이며, 이 런처는 Mojang과 무관합니다.
