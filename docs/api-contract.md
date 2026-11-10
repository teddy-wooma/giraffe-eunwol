# 은월 런처 · API 계약서 v1

> 대상: 런처(Electron), 클라이언트 모드(Fabric), 디스코드 봇, 관리자 도구
> 전송: HTTPS + JSON (UTF-8)
> 시각: ISO-8601 UTC

---

## 0. 공통 규칙

### 0.1 Base URL

```
https://<backend-domain>/v1
```

로컬 개발: `http://127.0.0.1:8787/v1`

### 0.2 인증 종류

| 주체 | 방식 | 토큰 수명 |
| --- | --- | --- |
| 런처 | `Authorization: Bearer <sessionToken>` | 24시간 |
| 런처(대기) | `Authorization: Bearer <pendingToken>` | 24시간 |
| 클라이언트 모드 | `Authorization: Bearer <modToken>` | 게임 세션 동안 |
| 관리자/봇 | `Authorization: Bearer <ADMIN_API_KEY>` | 고정(환경변수) |

- 모든 토큰은 **JWT HS256**, 서버 비밀키로 서명
- 클레임: `sub`(uuid), `typ`(launcher/pending/mod), `sid`(세션), `exp`, `iat`
- 토큰은 로그에 남기지 않는다

### 0.3 에러 형식

```json
{
  "error": {
    "code": "PENDING_APPROVAL",
    "message": "관리자 승인 대기 중입니다."
  }
}
```

| HTTP | code | 의미 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 필수 값 누락/형식 오류 |
| 401 | `INVALID_TOKEN` | 토큰 무효/만료 |
| 403 | `PENDING_APPROVAL` | 승인 대기 |
| 403 | `BANNED` | 밴 상태 |
| 404 | `NOT_FOUND` | 대상 없음 |
| 409 | `ALREADY_DECIDED` | 이미 처리된 요청 |
| 426 | `OUTDATED_LAUNCHER` | 최소 버전 미만 |
| 429 | `RATE_LIMITED` | 요청 제한 |
| 500 | `INTERNAL` | 서버 오류 |

### 0.4 공통 사항

- `Idempotency-Key` 헤더(선택): POST 재시도 시 중복 방지
- 요청 제한: 토큰별 분당 60회, 하트비트 분당 4회
- 모든 응답에 `traceId` 포함(서버 로그 추적용, `X-Request-Id` 헤더와 동일)
- 런처의 HTTP 호출은 **메인 프로세스**에서 수행 (file:// CORS 회피)

---

## 1. 런처 API

### 1.1 세션 시작 / 승인 확인

```
POST /v1/launcher/session/start
```

요청

```json
{
  "minecraftAccessToken": "eyJ...",
  "launcherVersion": "1.0.0",
  "os": "win32",
  "hwidHash": "optional-sha256"
}
```

- 서버는 Mojang API 로 토큰을 검증하고 **UUID/닉네임을 확정**한다
  (`GET https://api.minecraftservices.com/minecraft/profile`)
- 클라이언트가 보낸 UUID는 신뢰하지 않는다

승인됨 (200)

```json
{
  "status": "approved",
  "sessionToken": "jwt...",
  "modToken": "jwt...",
  "user": { "uuid": "8e99...", "nickname": "_Lunariss_" },
  "server": { "address": "giraffemc.com", "port": 25565 },
  "minLauncherVersion": "1.0.0"
}
```

대기 (403)

```json
{
  "status": "pending",
  "requestId": "REQ-20261110-001",
  "pendingToken": "jwt...",
  "message": "관리자 승인 대기 중입니다. 관리자에게 문의하세요."
}
```

밴 (403)

```json
{
  "status": "banned",
  "reason": "장기 미접속 정리",
  "bannedUntil": null,
  "message": "마을원 자격이 종료되었습니다."
}
```

- 신규 UUID → `pending` 자동 생성 + `approval_requests` 생성
- `users.status`가 `approved`면 즉시 통과
- 서버는 `users.last_seen_at` 갱신

### 1.2 대기 상태 확인

```
GET /v1/launcher/status
Authorization: Bearer <pendingToken>
```

응답

```json
{ "status": "pending" }
```

- `approved`로 바뀌면 런처가 자동으로 메인 화면 진입
- 60초 간격 폴링 권장

### 1.3 하트비트

```
POST /v1/launcher/heartbeat
Authorization: Bearer <sessionToken>
```

```json
{ "launcherVersion": "1.0.0", "uptimeSeconds": 1820 }
```

응답

```json
{ "ok": true, "status": "approved", "minLauncherVersion": "1.0.0" }
```

- 30초 간격
- 응답의 `status`가 `banned`로 바뀌면 런처는 즉시 종료 안내

### 1.4 세션 종료

```
POST /v1/launcher/session/end
Authorization: Bearer <sessionToken>
```

```json
{ "uptimeSeconds": 3600 }
```

응답: `{ "ok": true }`

---

## 2. 클라이언트 모드 API

> 모드는 런처가 발급한 `modToken`을 `config/eunwol-telemetry.json`에서 읽어 사용한다.

### 2.1 게임 세션 시작

```
POST /v1/mod/session/start
Authorization: Bearer <modToken>
```

```json
{
  "serverAddress": "giraffemc.com",
  "dimension": "minecraft:overworld",
  "joinedAt": "2026-11-10T05:20:00Z"
}
```

응답

```json
{ "sessionId": "gs_01J...", "ok": true }
```

### 2.2 게임 하트비트

```
POST /v1/mod/heartbeat
```

```json
{
  "sessionId": "gs_01J...",
  "dimension": "minecraft:overworld",
  "position": { "x": 120.5, "y": 64.0, "z": -330.2 },
  "afkSeconds": 320,
  "playSeconds": 1900
}
```

- 60초 간격
- `position`은 선택(수집 정책에 따라 생략)

### 2.3 게임 세션 종료

```
POST /v1/mod/session/end
```

```json
{
  "sessionId": "gs_01J...",
  "leftAt": "2026-11-10T06:40:00Z",
  "playSeconds": 4800,
  "afkSeconds": 900
}
```

### 2.4 이벤트 배치 (숙련도/소지금)

```
POST /v1/mod/events
```

```json
{
  "sessionId": "gs_01J...",
  "events": [
    { "kind": "skill", "job": "farmer", "level": 12, "exp": 340.5, "at": "2026-11-10T05:31:00Z", "source": "chat" },
    { "kind": "money", "balance": 152300, "at": "2026-11-10T05:40:00Z", "source": "scoreboard" }
  ]
}
```

- 최대 100건/요청, 5분 간격 배치 권장
- `source`: `chat | scoreboard | gui | payload`

---

## 3. 관리자 API (봇/대시보드)

> `Authorization: Bearer <ADMIN_API_KEY>`

### 3.1 대기 목록

```
GET /v1/admin/requests?status=pending&limit=50
```

### 3.2 승인/거절/보류

```
POST /v1/admin/requests/:requestId/decision
```

```json
{ "decision": "approved", "note": "가입 확인", "actor": "이장" }
```

- `decision`: `approved | denied | held`
- 이미 처리된 요청이면 `409 ALREADY_DECIDED`
- 처리 시 `users.status`도 함께 갱신

### 3.3 밴 / 해제

```
POST /v1/admin/users/:uuid/ban
```

```json
{ "reason": "장기 미접속", "until": null, "actor": "이장" }
```

```
POST /v1/admin/users/:uuid/unban
```

### 3.4 사용자 조회

```
GET /v1/admin/users/:uuid
```

응답: 프로필, 상태, 최근 세션, 최근 숙련도/소지금, 밴 이력

### 3.5 현황

```
GET /v1/admin/overview
```

```json
{
  "online": 7,
  "pendingRequests": 2,
  "activeBans": 3,
  "todayUnique": 11
}
```

---

## 4. 상태 전이

```
[승인]
pending ──approved──▶ approved
        └─denied────▶ denied

[밴]
approved ──ban──▶ banned
banned   ──unban─▶ approved
```

- `pending → banned`도 가능(즉시 거절)
- 전이는 `audit_log`에 기록

---

## 5. 보안

- HTTPS 필수, 토큰은 짧은 수명 + 서버 비밀키 회전 가능
- 모드 토큰은 게임 세션 범위로 제한
- 관리자 키는 봇/서버에만 보관, 절대 배포물에 포함하지 않음
- IP는 저장 시 마스킹 옵션(`ip_masked`) 병행 저장
- 요청 로그에 토큰/개인정보 원문 금지

---

## 6. 버전 관리

- 경로 버전(`/v1`) 유지
- 응답에 `API-Version: 1` 헤더
- 하위 호환 깨질 때 `/v2`
