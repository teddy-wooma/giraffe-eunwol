# 은월 디스코드 봇

마을원 승인 요청을 **디스코드 포럼 스레드**로 만들고, 스레드에서 바로 처리하는 봇입니다.

- 승인 대기 요청을 30초마다 확인 → 포럼 글(스레드) 생성
- 관리자가 ✅/❌/⏸ 버튼 또는 댓글(`승인`, `거절 사유`, `보류 사유`)로 처리
- 처리 결과를 백엔드에 반영하고 스레드에 결과 댓글 + 태그 변경 + 잠금

---

## 1. 디스코드 준비

### 1.1 봇 생성

1. https://discord.com/developers/applications → **New Application**
2. **Bot** 탭 → **Reset Token** → 토큰 저장 (한 번만 표시)
3. **Privileged Gateway Intents** 에서 아래 두 개 켜기
   - **Server Members Intent**
   - **Message Content Intent**

### 1.2 서버 초대

**OAuth2 → URL Generator**

- Scopes: `bot`
- Bot Permissions
  - View Channels
  - Send Messages
  - Create Public Threads
  - Send Messages in Threads
  - Manage Threads
  - Manage Channels (태그 생성용)
  - Embed Links
  - Read Message History

생성된 URL로 서버에 초대합니다.

### 1.3 채널/역할 ID

디스코드 **설정 → 고급 → 개발자 모드** 켜기 → 우클릭 **ID 복사**

| 값 | 설명 |
| --- | --- |
| `GUILD_ID` | 서버 ID |
| `FORUM_CHANNEL_ID` | 승인용 **포럼 채널** ID (예: `#마을-운영`) |
| `ADMIN_ROLE_ID` | 처리 권한 역할 ID (예: `마을관리`) |

> 포럼 채널이 없다면 서버에 **포럼 채널**을 하나 만들어 주세요.
> 태그(대기/승인/거절/보류/완료)는 봇이 자동 생성합니다.

---

## 2. 서버 설치

```bash
cd /opt/eunwol/repo
sudo git pull

cd bot
sudo npm install --omit=dev

cp .env.example .env
# .env 편집
```

`.env`:

```ini
DISCORD_TOKEN=<봇 토큰>
GUILD_ID=<서버 ID>
FORUM_CHANNEL_ID=<포럼 채널 ID>
ADMIN_ROLE_ID=<관리 역할 ID>
ADMIN_ROLE_NAME=마을관리

BACKEND_URL=http://127.0.0.1:8787
ADMIN_API_KEY=<백엔드 관리자 키>

POLL_INTERVAL_MS=30000
BOT_DB_PATH=/var/lib/eunwol/bot.sqlite
```

관리자 키는 서버에서 확인:

```bash
sudo cat /root/eunwol-admin-key.txt
```

권한 제한:

```bash
sudo chown ubuntu:ubuntu .env
chmod 600 .env
```

systemd 등록:

```bash
sudo cp systemd/eunwol-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now eunwol-bot
sudo journalctl -u eunwol-bot -f
```

성공 로그:

```
[bot] 로그인: 은월봇#1234
[bot] 포럼 태그 생성: 대기, 승인, 거절, 보류, 완료
[bot] 스레드 생성: REQ-20261110-001 → 1234567890
```

---

## 3. 사용법

### 승인

1. 런처에서 미승인 계정이 실행을 시도하면 요청이 생성됩니다.
2. 봇이 포럼에 글을 만듭니다.
3. 관리자가:
   - **✅ 승인** 버튼 클릭, 또는
   - 스레드에 `승인` 댓글
4. 결과 댓글 + `승인` 태그 + 스레드 잠금/아카이브

### 거절 / 보류

- 버튼: ❌ / ⏸
- 댓글: `거절 사유` / `보류 사유`

### 권한

- `ADMIN_ROLE_ID` 역할(또는 `ADMIN_ROLE_NAME`) 보유자만 처리할 수 있습니다.
- 권한 없는 사용자의 버튼/댓글은 무시됩니다.

---

## 4. 참고

- 봇은 백엔드 **관리자 API**를 `127.0.0.1` 로 호출합니다. (외부 노출 없음)
- 처리 이력은 백엔드 `audit_log` 와 봇의 `bot.sqlite` 에 남습니다.
- 이미 처리된 요청은 "이미 처리된 요청입니다"로 응답합니다.
- 스레드 생성 실패 시 로그를 확인하세요 (`Manage Channels`, `Manage Threads` 권한).
