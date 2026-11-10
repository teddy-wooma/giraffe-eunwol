#!/usr/bin/env bash
# SQLite 일일 백업 (기본 보관 14일)
set -euo pipefail

DB_PATH="${DB_PATH:-/var/lib/eunwol/eunwol.sqlite}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/eunwol}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

if [ ! -f "$DB_PATH" ]; then
    echo "[backup] DB 파일이 없습니다: $DB_PATH" >&2
    exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$BACKUP_DIR/eunwol-$STAMP.sqlite"

sqlite3 "$DB_PATH" ".backup '$TARGET'"
gzip -f "$TARGET"
find "$BACKUP_DIR" -name 'eunwol-*.sqlite.gz' -mtime +"$RETENTION_DAYS" -delete

echo "[backup] $TARGET.gz"
