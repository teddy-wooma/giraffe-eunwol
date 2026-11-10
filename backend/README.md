# 은월 백엔드 (MVP)

런처·클라이언트 모드·디스코드 봇이 공유하는 승인/세션 API입니다.

- **의존성 0개** — Node.js 내장 `http` + `node:sqlite` 사용
- 무료 VM(Oracle Always Free 등)에 그대로 배포 가능
- 스키마: [`db/schema.sql`](../db/schema.sql)
- 계약: [`docs/api-contract.md`](../docs/api-contract.md)

## 요구 사항

- **Node.js 24 이상** (`node:sqlite` 내장)
- Linux/Windows/macOS 모두 동작

## 실행

```bash
cd backend
cp .env.example .env       # 값 수정 (JWT_SECRET, ADMIN_API_KEY 필수)
node --env-file=.env src/server.js
```

기본 주소: `http://127.0.0.1:8787`

### 개발용 가짜 토큰

실제 Microsoft 로그인 없이 테스트하려면:

```bash
DEV_ALLOW_FAKE_TOKEN=1 node --env-file=.env src/server.js
```

```bash
curl -X POST http://127.0.0.1:8787/v1/launcher/session/start \
  -H 'Content-Type: application/json' \
  -d '{"minecraftAccessToken":"dev:8e99e23b1f944dd7b8f25e4481d72f8e:Tester","launcherVersion":"1.0.0"}'
```

> `DEV_ALLOW_FAKE_TOKEN` 은 **운영에서 절대 켜지 마세요.**

## 테스트

```bash
node test/smoke.cjs
```

승인 대기 → 관리자 승인 → 세션 발급 → 하트비트 → 모드 세션/이벤트 → 밴/해제 → 버전 차단까지 검증합니다.

## 주요 엔드포인트

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| POST | `/v1/launcher/session/start` | 승인 확인 + 세션 발급 |
| GET | `/v1/launcher/status` | 대기 상태 확인 |
| POST | `/v1/launcher/heartbeat` | 30초 하트비트 |
| POST | `/v1/launcher/session/end` | 종료 |
| POST | `/v1/mod/session/start` | 게임 세션 시작 |
| POST | `/v1/mod/heartbeat` | 차원/좌표/AFK |
| POST | `/v1/mod/events` | 숙련도/소지금 배치 |
| POST | `/v1/mod/session/end` | 게임 세션 종료 |
| GET | `/v1/admin/requests` | 대기 목록 |
| POST | `/v1/admin/requests/:id/decision` | 승인/거절/보류 |
| POST | `/v1/admin/users/:uuid/ban` | 밴 |
| POST | `/v1/admin/users/:uuid/unban` | 해제 |
| GET | `/v1/admin/users/:uuid` | 사용자 상세 |
| GET | `/v1/admin/overview` | 현황 |

관리자 API는 `Authorization: Bearer <ADMIN_API_KEY>` 가 필요합니다.

## 운영 배포 (Linux VM)

```bash
sudo useradd -r -s /usr/sbin/nologin eunwol
sudo mkdir -p /opt/eunwol-backend /var/lib/eunwol
sudo chown -R eunwol:eunwol /opt/eunwol-backend /var/lib/eunwol

# 파일 복사 후
sudo -u eunwol node --env-file=/opt/eunwol-backend/.env /opt/eunwol-backend/src/server.js
```

systemd 예시는 [`systemd/eunwol-backend.service`](systemd/eunwol-backend.service) 참고.

- DB 파일(`DB_PATH`)은 반드시 백업하세요 (`sqlite3 .backup` 또는 파일 복사)
- 앞단에 Caddy/Nginx 로 HTTPS 를 붙이는 것을 권장합니다

## 보안 체크리스트

- [ ] `JWT_SECRET` 32자 이상 랜덤
- [ ] `ADMIN_API_KEY` 유추 불가 값
- [ ] `DEV_ALLOW_FAKE_TOKEN=0`
- [ ] HTTPS 적용
- [ ] DB 파일 권한 제한 (`600`)
- [ ] 로그에 토큰/개인정보 원문 없음
