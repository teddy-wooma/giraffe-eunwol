-- =============================================================================
-- 은월 런처 · 마을 운영 DB 스키마 (SQLite 기준)
-- =============================================================================
-- - 로컬 개발/무료 VM(Oracle Always Free)에서 그대로 사용
-- - Postgres 로 이전할 때는 TEXT/INTEGER 그대로, AUTOINCREMENT → IDENTITY 로 변경
-- - 시각은 모두 ISO-8601 UTC 문자열 (예: 2026-11-10T05:20:00Z)
-- =============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- 사용자 / 승인 상태
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    uuid            TEXT PRIMARY KEY,
    nickname        TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'banned')),
    consent_version TEXT,                -- 가입 시 동의한 약관 버전
    consented_at    TEXT,                -- 동의 시각 (마을 가입 시점)
    note            TEXT,
    first_seen_at   TEXT NOT NULL,
    last_seen_at    TEXT,
    approved_by     TEXT,
    approved_at     TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at);

-- -----------------------------------------------------------------------------
-- 밴 (활성/만료)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid        TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
    reason      TEXT,
    banned_by   TEXT,
    created_at  TEXT NOT NULL,
    expires_at  TEXT,                    -- NULL = 영구
    active      INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_bans_uuid_active ON bans(uuid, active);

-- -----------------------------------------------------------------------------
-- 런처 세션 (앱 실행 단위)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS launcher_sessions (
    id                TEXT PRIMARY KEY,  -- UUID
    uuid              TEXT NOT NULL REFERENCES users(uuid),
    started_at        TEXT NOT NULL,
    ended_at          TEXT,
    last_heartbeat_at TEXT,
    ip                TEXT,
    ip_masked         TEXT,
    launcher_version  TEXT,
    os                TEXT,
    hwid_hash         TEXT               -- 선택(개인정보 최소화: 해시)
);

CREATE INDEX IF NOT EXISTS idx_ls_uuid_started ON launcher_sessions(uuid, started_at);
CREATE INDEX IF NOT EXISTS idx_ls_open ON launcher_sessions(ended_at, last_heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_ls_uuid_open ON launcher_sessions(uuid, ended_at);

-- -----------------------------------------------------------------------------
-- 게임 세션 (서버 접속 단위, 클라이언트 모드 보고)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS game_sessions (
    id              TEXT PRIMARY KEY,
    uuid            TEXT NOT NULL REFERENCES users(uuid),
    server_address  TEXT,
    joined_at       TEXT NOT NULL,
    left_at         TEXT,
    play_seconds    INTEGER NOT NULL DEFAULT 0,
    afk_seconds     INTEGER NOT NULL DEFAULT 0,
    dimension       TEXT,                -- minecraft:overworld 등
    last_x          REAL,
    last_y          REAL,
    last_z          REAL,
    in_village      INTEGER,             -- 1/0/NULL (마을 영역 판정, 선택)
    created_at      TEXT NOT NULL,
    updated_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_gs_uuid_joined ON game_sessions(uuid, joined_at);
CREATE INDEX IF NOT EXISTS idx_gs_open ON game_sessions(left_at);
CREATE INDEX IF NOT EXISTS idx_gs_uuid_open ON game_sessions(uuid, left_at, joined_at);
CREATE INDEX IF NOT EXISTS idx_gs_alive ON game_sessions(left_at, updated_at);

-- -----------------------------------------------------------------------------
-- 직업 숙련도 이벤트
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS skill_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid        TEXT NOT NULL,
    job         TEXT NOT NULL,           -- farmer, fisher ...
    level       INTEGER,
    exp         REAL,
    observed_at TEXT NOT NULL,
    source      TEXT,                    -- chat | scoreboard | gui | payload
    raw         TEXT                     -- 원문(파싱 검증용, 선택)
);

CREATE INDEX IF NOT EXISTS idx_skill_uuid_time ON skill_events(uuid, observed_at);
CREATE INDEX IF NOT EXISTS idx_skill_job_time ON skill_events(job, observed_at);

-- -----------------------------------------------------------------------------
-- 소지금 스냅샷
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS money_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid        TEXT NOT NULL,
    balance     INTEGER NOT NULL,
    observed_at TEXT NOT NULL,
    source      TEXT
);

CREATE INDEX IF NOT EXISTS idx_money_uuid_time ON money_snapshots(uuid, observed_at);

-- -----------------------------------------------------------------------------
-- 승인 요청 (런처 최초 실행 시 생성)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_requests (
    id           TEXT PRIMARY KEY,       -- REQ-YYYYMMDD-NNN
    uuid         TEXT NOT NULL,
    nickname     TEXT,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'denied', 'held')),
    requested_at TEXT NOT NULL,
    handled_by   TEXT,
    handled_at   TEXT,
    note         TEXT,
    discord_thread_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_req_status ON approval_requests(status, requested_at);

-- -----------------------------------------------------------------------------
-- 디스코드 스레드 매핑
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discord_requests (
    request_id   TEXT PRIMARY KEY,
    type         TEXT NOT NULL,          -- approval | ban | unban | report | cleanup | error
    target_uuid  TEXT,
    guild_id     TEXT,
    channel_id   TEXT,
    thread_id    TEXT,
    message_id   TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    payload_json TEXT,
    created_at   TEXT NOT NULL,
    decided_at   TEXT,
    decided_by   TEXT,
    decision     TEXT,
    decision_note TEXT
);

CREATE TABLE IF NOT EXISTS discord_decisions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id       TEXT NOT NULL,
    actor_discord_id TEXT,
    actor_name       TEXT,
    decision         TEXT NOT NULL,
    note             TEXT,
    source           TEXT,               -- button | comment
    created_at       TEXT NOT NULL
);

-- -----------------------------------------------------------------------------
-- 감사 로그
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    actor        TEXT,
    action       TEXT NOT NULL,
    target_uuid  TEXT,
    payload_json TEXT,
    created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_uuid, created_at);

-- -----------------------------------------------------------------------------
-- IP 소속 캐시 (스캐너 라벨)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ip_intel (
    ip         TEXT PRIMARY KEY,
    org        TEXT,
    city       TEXT,
    country    TEXT,
    updated_at TEXT NOT NULL
);

-- -----------------------------------------------------------------------------
-- 관리자 IP 매핑 (로그인 전 추정용)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_ip_map (
    ip         TEXT PRIMARY KEY,
    discord_id TEXT,
    name       TEXT,
    manual     INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);

-- -----------------------------------------------------------------------------
-- 대시보드 접속 현황
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dashboard_presence (
    discord_id   TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    avatar       TEXT,
    last_seen_at TEXT NOT NULL,
    ip           TEXT
);

CREATE INDEX IF NOT EXISTS idx_presence_seen ON dashboard_presence(last_seen_at);

-- -----------------------------------------------------------------------------
-- 마이그레이션 버전
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
