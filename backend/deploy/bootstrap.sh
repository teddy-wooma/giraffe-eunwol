#!/usr/bin/env bash
# =============================================================================
# 은월 백엔드 원샷 배포 (Oracle Cloud Ubuntu 24.04)
#
# 사용법:
#   sudo DOMAIN=eunwol.duckdns.org bash bootstrap.sh
#
# 하는 일:
#   - 패키지/Node 24 설치
#   - 저장소 클론 및 .env 생성(비밀키 자동)
#   - systemd 등록/시작
#   - Oracle iptables 80/443 허용
#   - Caddy 설치 + HTTPS 리버스 프록시
# =============================================================================
set -euo pipefail

DOMAIN="${DOMAIN:-${1:-}}"
if [ -z "$DOMAIN" ]; then
    echo "사용법: sudo DOMAIN=<도메인> bash bootstrap.sh" >&2
    exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
    echo "sudo 로 실행해 주세요." >&2
    exit 1
fi

REPO_URL="${REPO_URL:-https://github.com/teddy-wooma/giraffe-eunwol.git}"
APP_DIR="/opt/eunwol/repo"
DATA_DIR="/var/lib/eunwol"
RUN_USER="${SUDO_USER:-ubuntu}"

echo "==> 패키지 설치"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git sqlite3 ca-certificates openssl iptables-persistent

echo "==> Node.js 24"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt-get install -y nodejs
fi
node -v

echo "==> 디렉터리/코드"
mkdir -p /opt/eunwol "$DATA_DIR"
chown -R "$RUN_USER":"$RUN_USER" /opt/eunwol "$DATA_DIR"

if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" pull --ff-only
else
    git clone "$REPO_URL" "$APP_DIR"
fi
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"

echo "==> .env"
ENV_FILE="$APP_DIR/backend/.env"
if [ ! -f "$ENV_FILE" ]; then
    JWT_SECRET="$(openssl rand -hex 32)"
    ADMIN_API_KEY="$(openssl rand -hex 24)"
    cat > "$ENV_FILE" <<EOF
PORT=8787
DB_PATH=$DATA_DIR/eunwol.sqlite
JWT_SECRET=$JWT_SECRET
ADMIN_API_KEY=$ADMIN_API_KEY
MIN_LAUNCHER_VERSION=1.0.0
SERVER_ADDRESS=giraffemc.com
SERVER_PORT=25565
DEV_ALLOW_FAKE_TOKEN=0
EOF
    chmod 600 "$ENV_FILE"
    chown "$RUN_USER":"$RUN_USER" "$ENV_FILE"
    umask 077
    printf 'ADMIN_API_KEY=%s\n' "$ADMIN_API_KEY" > /root/eunwol-admin-key.txt
    echo "    관리자 키를 /root/eunwol-admin-key.txt 에 저장했습니다."
else
    echo "    기존 .env 유지: $ENV_FILE"
fi

echo "==> systemd"
install -m 644 "$APP_DIR/backend/systemd/eunwol-backend.service" /etc/systemd/system/eunwol-backend.service
systemctl daemon-reload
systemctl enable eunwol-backend
systemctl restart eunwol-backend
sleep 2

echo "==> Oracle iptables (80/443)"
for port in 80 443; do
    if ! iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
        iptables -I INPUT 6 -p tcp --dport "$port" -j ACCEPT
    fi
done
netfilter-persistent save >/dev/null 2>&1 || true

echo "==> Caddy"
if ! command -v caddy >/dev/null 2>&1; then
    apt-get install -y caddy || {
        apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
            | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
            > /etc/apt/sources.list.d/caddy-stable.list
        apt-get update -y
        apt-get install -y caddy
    }
fi

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy 127.0.0.1:8787

    @admin path /v1/admin/*
    respond @admin 403

    encode gzip
}
EOF
systemctl enable caddy
systemctl restart caddy

echo "==> 대기 및 확인"
sleep 5
systemctl --no-pager --lines=5 status eunwol-backend || true
if curl -fsS "https://$DOMAIN/healthz"; then
    echo
    echo "✅ 배포 완료: https://$DOMAIN/healthz"
else
    echo "⚠️  HTTPS 확인 실패. 아래를 확인하세요:" >&2
    echo "    - Oracle 보안 목록에서 80/443 인그레스 허용" >&2
    echo "    - DuckDNS IP 가 이 서버 공인 IP 인지" >&2
    echo "    - sudo journalctl -u caddy -n 80" >&2
    exit 1
fi

echo
echo "관리자 키: /root/eunwol-admin-key.txt"
echo "런처 기본 주소: https://$DOMAIN"
