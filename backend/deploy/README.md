# 오라클 프리티어 배포 가이드

Oracle Cloud Always Free VM 에 백엔드를 올리는 절차입니다.
(ARM Ampere 또는 AMD Micro 모두 가능)

---

## 1. 인스턴스 생성

콘솔 → **Compute → Instances → Create instance**

| 항목 | 값 |
| --- | --- |
| Name | `eunwol-backend` |
| Image | **Ubuntu 24.04** |
| Shape | `VM.Standard.A1.Flex` (4 OCPU / 24GB) 또는 `VM.Standard.E2.1.Micro` |
| Boot volume | 50GB |
| SSH key | 새로 생성하거나 기존 공개키 등록 |

- **Public IPv4 address** 할당 확인
- ARM(Ampere)는 리전/AD 에 따라 용량 부족이 뜰 수 있습니다. 그때는 다른 AD 를 시도하거나 AMD Micro 로 진행하세요.

생성 후 공인 IP 를 메모합니다.

---

## 2. 네트워크 열기

### 2.1 보안 목록 (콘솔)

인스턴스 → **Subnet → Security list → Add ingress rule**

| 포트 | 용도 | 소스 |
| --- | --- | --- |
| 22 | SSH | 내 IP |
| 80 | HTTP (인증서 발급/리다이렉트) | 0.0.0.0/0 |
| 443 | HTTPS | 0.0.0.0/0 |

> 8787(백엔드)은 **열지 않습니다.** Caddy 가 내부에서 프록시합니다.

### 2.2 OS 방화벽 (Ubuntu)

Oracle Ubuntu 이미지는 iptables 에 REJECT 규칙이 있어 아래가 필요합니다.

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

---

## 3. 접속 및 기본 패키지

```bash
ssh -i <키파일> ubuntu@<공인IP>

sudo apt-get update
sudo apt-get install -y curl git sqlite3
```

### Node.js 24

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # v24.x
```

---

## 4. 코드 배포

```bash
sudo mkdir -p /opt/eunwol /var/lib/eunwol
sudo chown -R ubuntu:ubuntu /opt/eunwol /var/lib/eunwol

git clone https://github.com/teddy-wooma/giraffe-eunwol.git /opt/eunwol/repo
cd /opt/eunwol/repo/backend
cp .env.example .env
```

`.env` 수정:

```bash
# 비밀키 생성
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 24   # ADMIN_API_KEY
```

```ini
PORT=8787
DB_PATH=/var/lib/eunwol/eunwol.sqlite
JWT_SECRET=<위에서 생성한 값>
ADMIN_API_KEY=<위에서 생성한 값>
MIN_LAUNCHER_VERSION=1.0.0
SERVER_ADDRESS=giraffemc.com
SERVER_PORT=25565
DEV_ALLOW_FAKE_TOKEN=0
```

권한 제한:

```bash
chmod 600 /opt/eunwol/repo/backend/.env
```

수동 실행 테스트:

```bash
sudo -u ubuntu env $(grep -v '^#' .env | xargs) node src/server.js
# 다른 터미널에서
curl http://127.0.0.1:8787/healthz
```

---

## 5. systemd 등록

```bash
sudo cp deploy/eunwol-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now eunwol-backend
sudo systemctl status eunwol-backend --no-pager
sudo journalctl -u eunwol-backend -f
```

---

## 6. HTTPS (Caddy)

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

`/etc/caddy/Caddyfile`:

```
api.example.com {
    reverse_proxy 127.0.0.1:8787

    # 관리자 API 는 외부에서 차단 (봇은 127.0.0.1 로 직접 호출)
    @admin path /v1/admin/*
    respond @admin 403
}
```

```bash
sudo systemctl reload caddy
```

### 도메인이 없다면 (DuckDNS 무료)

1. https://www.duckdns.org 에서 서브도메인 생성 (예: `eunwol`)
2. IP 를 오라클 공인 IP 로 설정
3. Caddyfile 도메인을 `eunwol.duckdns.org` 로 사용

Caddy 가 Let's Encrypt 인증서를 자동 발급합니다(80 포트 필요).

---

## 7. 검증

```bash
curl https://api.example.com/healthz
# {"ok":true,...}

curl -X POST https://api.example.com/v1/launcher/session/start \
  -H 'Content-Type: application/json' \
  -d '{"minecraftAccessToken":"...","launcherVersion":"1.0.0"}'
```

---

## 8. 백업

`deploy/backup.sh` 를 매일 새벽에 실행:

```bash
chmod +x /opt/eunwol/repo/backend/deploy/backup.sh
sudo crontab -e
```

```cron
0 4 * * * /opt/eunwol/repo/backend/deploy/backup.sh >> /var/log/eunwol-backup.log 2>&1
```

기본 보관 14일, `/var/backups/eunwol` 에 저장됩니다.

---

## 9. 체크리스트

- [ ] 보안 목록 80/443 열림
- [ ] iptables 규칙 저장됨
- [ ] `.env` 권한 600, `DEV_ALLOW_FAKE_TOKEN=0`
- [ ] systemd 활성화
- [ ] HTTPS 인증서 발급됨
- [ ] `/v1/admin/*` 외부 차단 확인
- [ ] 백업 cron 등록
