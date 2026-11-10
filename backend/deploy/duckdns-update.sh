#!/usr/bin/env bash
# DuckDNS IP 갱신 (Oracle 공인 IP가 바뀌었을 때)
# 사용: DUCKDNS_DOMAIN=eunwol DUCKDNS_TOKEN=xxxx ./duckdns-update.sh
set -euo pipefail

DOMAIN="${DUCKDNS_DOMAIN:?DUCKDNS_DOMAIN 필요 (예: eunwol)}"
TOKEN="${DUCKDNS_TOKEN:?DUCKDNS_TOKEN 필요}"

RESPONSE=""
for attempt in 1 2 3; do
    RESPONSE="$(curl -fsS "https://www.duckdns.org/update?domains=${DOMAIN}&token=${TOKEN}&ip=" 2>/dev/null)" || RESPONSE=""
    if [ "$RESPONSE" = "OK" ]; then
        break
    fi
    sleep 5
done

echo "[duckdns] ${RESPONSE:-failed}"

if [ "$RESPONSE" != "OK" ]; then
    echo "[duckdns] 갱신 실패" >&2
    exit 1
fi
