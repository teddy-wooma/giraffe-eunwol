'use strict'

const http = require('node:http')
const crypto = require('node:crypto')
const { open, tx } = require('./db')
const jwt = require('./jwt')
const { verifyMinecraftToken } = require('./mojang')
const { createDashboard } = require('./dashboard')
const {
    nowIso,
    todayCompact,
    normalizeUuid,
    maskIp,
    clientIp,
    versionAtLeast,
    newId
} = require('./util')

// -----------------------------------------------------------------------------
// 오류 / 설정
// -----------------------------------------------------------------------------

class ApiError extends Error {
    constructor(status, code, message) {
        super(message)
        this.status = status
        this.code = code
    }
}

function loadConfig(env = process.env) {
    return {
        port: Number(env.PORT || 8787),
        dbPath: env.DB_PATH || './data/eunwol.sqlite',
        jwtSecret: env.JWT_SECRET || 'dev-secret-change-me',
        adminApiKey: env.ADMIN_API_KEY || 'dev-admin-key',
        minLauncherVersion: env.MIN_LAUNCHER_VERSION || '0.0.0',
        serverAddress: env.SERVER_ADDRESS || 'giraffemc.com',
        serverPort: Number(env.SERVER_PORT || 25565),
        devAllowFakeToken: env.DEV_ALLOW_FAKE_TOKEN === '1',
        discordClientId: env.DISCORD_CLIENT_ID || '',
        discordClientSecret: env.DISCORD_CLIENT_SECRET || '',
        discordRedirectUri: env.DISCORD_REDIRECT_URI || '',
        discordGuildId: env.DISCORD_GUILD_ID || '',
        discordAdminRoleId: env.DISCORD_ADMIN_ROLE_ID || '',
        dashboardSecret: env.DASHBOARD_SECRET || env.JWT_SECRET || 'dev-dashboard-secret',
        ttl: {
            launcher: Number(env.LAUNCHER_TOKEN_TTL || 86400),
            pending: Number(env.PENDING_TOKEN_TTL || 86400),
            mod: Number(env.MOD_TOKEN_TTL || 43200)
        }
    }
}

// -----------------------------------------------------------------------------
// HTTP 유틸
// -----------------------------------------------------------------------------

function sendJson(res, status, payload, requestId) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'X-Request-Id': requestId
    })
    res.end(body)
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (chunk) => {
            size += chunk.length
            if (size > 1024 * 1024) {
                reject(new ApiError(400, 'BAD_REQUEST', '요청 본문이 너무 큽니다.'))
                req.destroy()
                return
            }
            chunks.push(chunk)
        })
        req.on('end', () => {
            if (chunks.length === 0) {
                resolve({})
                return
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            } catch (_) {
                reject(new ApiError(400, 'BAD_REQUEST', 'JSON 형식이 올바르지 않습니다.'))
            }
        })
        req.on('error', reject)
    })
}

function getBearer(req) {
    const header = req.headers.authorization || ''
    const match = /^Bearer (.+)$/.exec(header)
    return match ? match[1] : null
}

function verifyOrThrow(token, secret, type) {
    const payload = jwt.verify(token, secret)
    if (payload == null || (type != null && payload.typ !== type)) {
        throw new ApiError(401, 'INVALID_TOKEN', '토큰이 유효하지 않거나 만료되었습니다.')
    }
    return payload
}

function requireAdmin(req, config) {
    const token = getBearer(req)
    const expected = Buffer.from(String(config.adminApiKey))
    const actual = Buffer.from(String(token || ''))
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        throw new ApiError(401, 'INVALID_TOKEN', '관리자 키가 올바르지 않습니다.')
    }
}

// -----------------------------------------------------------------------------
// 요청 제한 (간단한 인메모리 윈도우)
// -----------------------------------------------------------------------------

const buckets = new Map()

function rateLimit(key, limit = 300, windowMs = 60000) {
    const now = Date.now()
    const bucket = buckets.get(key)
    if (bucket == null || now - bucket.start >= windowMs) {
        buckets.set(key, { start: now, count: 1 })
        return
    }
    bucket.count += 1
    if (bucket.count > limit) {
        throw new ApiError(429, 'RATE_LIMITED', '요청이 너무 많습니다.')
    }
}

// -----------------------------------------------------------------------------
// DB 헬퍼
// -----------------------------------------------------------------------------

function audit(db, actor, action, targetUuid, payload) {
    db.prepare(
        'INSERT INTO audit_log (actor, action, target_uuid, payload_json, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(actor || null, action, targetUuid || null, payload == null ? null : JSON.stringify(payload), nowIso())
}

function activeBan(db, uuid) {
    return db.prepare(
        `SELECT * FROM bans
         WHERE uuid = ? AND active = 1 AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at DESC LIMIT 1`
    ).get(uuid, nowIso()) || null
}

function isBanned(db, user) {
    return user.status === 'banned' || activeBan(db, user.uuid) != null
}

function nextRequestId(db) {
    const day = todayCompact()
    for (let i = 1; i <= 9999; i += 1) {
        const id = `REQ-${day}-${String(i).padStart(3, '0')}`
        if (db.prepare('SELECT id FROM approval_requests WHERE id = ?').get(id) == null) {
            return id
        }
    }
    return `REQ-${day}-${Date.now()}`
}

function ensureUser(db, profile, ip) {
    const now = nowIso()
    let user = db.prepare('SELECT * FROM users WHERE uuid = ?').get(profile.uuid)

    if (user == null) {
        db.prepare(
            `INSERT INTO users (uuid, nickname, status, first_seen_at, last_seen_at, created_at, updated_at)
             VALUES (?, ?, 'pending', ?, ?, ?, ?)`
        ).run(profile.uuid, profile.name, now, now, now, now)
        audit(db, 'system', 'user_created', profile.uuid, { nickname: profile.name, ip: maskIp(ip) })
    } else {
        db.prepare('UPDATE users SET nickname = ?, last_seen_at = ?, updated_at = ? WHERE uuid = ?')
            .run(profile.name, now, now, profile.uuid)
    }

    return db.prepare('SELECT * FROM users WHERE uuid = ?').get(profile.uuid)
}

function openRequest(db, uuid) {
    return db.prepare(
        `SELECT * FROM approval_requests
         WHERE uuid = ? AND status IN ('pending', 'held')
         ORDER BY requested_at DESC LIMIT 1`
    ).get(uuid) || null
}

function createApprovalRequest(db, user, ip) {
    const id = nextRequestId(db)
    db.prepare(
        'INSERT INTO approval_requests (id, uuid, nickname, status, requested_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, user.uuid, user.nickname, 'pending', nowIso())
    audit(db, 'system', 'approval_requested', user.uuid, { requestId: id, ip: maskIp(ip) })
    return db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id)
}

function issueTokens(config, user, sessionId) {
    const base = { sub: user.uuid, sid: sessionId }
    return {
        sessionToken: jwt.sign({ ...base, typ: 'launcher' }, config.jwtSecret, config.ttl.launcher),
        modToken: jwt.sign({ ...base, typ: 'mod' }, config.jwtSecret, config.ttl.mod)
    }
}

// -----------------------------------------------------------------------------
// 런처 핸들러
// -----------------------------------------------------------------------------

async function launcherSessionStart(ctx) {
    const { db, config, body, ip } = ctx

    const profile = await verifyMinecraftToken(
        body.minecraftAccessToken,
        config.devAllowFakeToken
    )
    if (profile == null) {
        throw new ApiError(401, 'INVALID_TOKEN', 'Minecraft 토큰이 유효하지 않습니다.')
    }

    if (body.launcherVersion != null && !versionAtLeast(body.launcherVersion, config.minLauncherVersion)) {
        throw new ApiError(
            426,
            'OUTDATED_LAUNCHER',
            `런처를 ${config.minLauncherVersion} 이상으로 업데이트해 주세요.`
        )
    }

    const user = ensureUser(db, profile, ip)

    if (isBanned(db, user)) {
        const ban = activeBan(db, user.uuid)
        throw new ApiError(403, 'BANNED', ban && ban.reason ? ban.reason : '마을원 자격이 종료되었습니다.')
    }

    if (user.status === 'pending') {
        const req = openRequest(db, user.uuid) || createApprovalRequest(db, user, ip)
        const pendingToken = jwt.sign(
            { sub: user.uuid, typ: 'pending', rid: req.id },
            config.jwtSecret,
            config.ttl.pending
        )
        return {
            status: 403,
            payload: {
                status: 'pending',
                requestId: req.id,
                pendingToken,
                message: '관리자 승인 대기 중입니다. 관리자에게 문의하세요.'
            }
        }
    }

    // 이전에 열린 런처 세션 정리
    db.prepare('UPDATE launcher_sessions SET ended_at = ? WHERE uuid = ? AND ended_at IS NULL')
        .run(nowIso(), user.uuid)

    const sessionId = newId()
    db.prepare(
        `INSERT INTO launcher_sessions
         (id, uuid, started_at, last_heartbeat_at, ip, ip_masked, launcher_version, os, hwid_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        sessionId,
        user.uuid,
        nowIso(),
        nowIso(),
        ip || null,
        maskIp(ip),
        body.launcherVersion || null,
        body.os || null,
        body.hwidHash || null
    )

    const tokens = issueTokens(config, user, sessionId)
    audit(db, user.uuid, 'launcher_session_start', user.uuid, {
        sessionId,
        launcherVersion: body.launcherVersion || null,
        ip: maskIp(ip)
    })

    return {
        status: 200,
        payload: {
            status: 'approved',
            ...tokens,
            user: { uuid: user.uuid, nickname: user.nickname },
            server: { address: config.serverAddress, port: config.serverPort },
            minLauncherVersion: config.minLauncherVersion
        }
    }
}

async function launcherStatus(ctx) {
    const { db, config } = ctx
    const payload = verifyOrThrow(getBearer(ctx.req), config.jwtSecret, 'pending')
    const user = db.prepare('SELECT * FROM users WHERE uuid = ?').get(payload.sub)
    if (user == null) {
        throw new ApiError(401, 'INVALID_TOKEN', '사용자를 찾을 수 없습니다.')
    }
    if (isBanned(db, user)) {
        throw new ApiError(403, 'BANNED', '마을원 자격이 종료되었습니다.')
    }
    if (user.status === 'approved') {
        return { status: 200, payload: { status: 'approved' } }
    }
    const req = openRequest(db, user.uuid)
    return {
        status: 200,
        payload: { status: 'pending', requestId: req ? req.id : null }
    }
}

async function launcherHeartbeat(ctx) {
    const { db, config, body } = ctx
    const payload = verifyOrThrow(getBearer(ctx.req), config.jwtSecret, 'launcher')
    const user = db.prepare('SELECT * FROM users WHERE uuid = ?').get(payload.sub)
    if (user == null) {
        throw new ApiError(401, 'INVALID_TOKEN', '사용자를 찾을 수 없습니다.')
    }
    if (isBanned(db, user)) {
        throw new ApiError(403, 'BANNED', '마을원 자격이 종료되었습니다.')
    }

    db.prepare(
        'UPDATE launcher_sessions SET last_heartbeat_at = ? WHERE id = ? AND uuid = ?'
    ).run(nowIso(), payload.sid, user.uuid)

    return {
        status: 200,
        payload: {
            ok: true,
            status: 'approved',
            minLauncherVersion: config.minLauncherVersion,
            uptimeSeconds: body.uptimeSeconds || null
        }
    }
}

async function launcherSessionEnd(ctx) {
    const { db, config } = ctx
    const payload = verifyOrThrow(getBearer(ctx.req), config.jwtSecret, 'launcher')
    db.prepare('UPDATE launcher_sessions SET ended_at = ? WHERE id = ? AND uuid = ?')
        .run(nowIso(), payload.sid, payload.sub)
    audit(db, payload.sub, 'launcher_session_end', payload.sub, { sessionId: payload.sid })
    return { status: 200, payload: { ok: true } }
}

// -----------------------------------------------------------------------------
// 모드 핸들러
// -----------------------------------------------------------------------------

async function modSessionStart(ctx) {
    const { db, config, body } = ctx
    const payload = verifyOrThrow(getBearer(ctx.req), config.jwtSecret, 'mod')
    const user = db.prepare('SELECT * FROM users WHERE uuid = ?').get(payload.sub)
    if (user == null || isBanned(db, user)) {
        throw new ApiError(403, 'BANNED', '사용할 수 없는 계정입니다.')
    }

    // 이전에 열린 세션이 남아 있으면 종료 처리 (중복 방지)
    db.prepare('UPDATE game_sessions SET left_at = ?, updated_at = ? WHERE uuid = ? AND left_at IS NULL')
        .run(nowIso(), nowIso(), user.uuid)

    const sessionId = newId()
    db.prepare(
        `INSERT INTO game_sessions
         (id, uuid, server_address, joined_at, dimension, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
        sessionId,
        user.uuid,
        body.serverAddress || config.serverAddress,
        nowIso(),
        body.dimension || null,
        nowIso(),
        nowIso()
    )

    return { status: 200, payload: { ok: true, sessionId } }
}

async function modHeartbeat(ctx) {
    const { db, config, body } = ctx
    const payload = verifyOrThrow(getBearer(ctx.req), config.jwtSecret, 'mod')
    if (!body.sessionId) {
        throw new ApiError(400, 'BAD_REQUEST', 'sessionId 가 필요합니다.')
    }

    const result = db.prepare(
        `UPDATE game_sessions
         SET dimension = COALESCE(?, dimension),
             last_x = COALESCE(?, last_x),
             last_y = COALESCE(?, last_y),
             last_z = COALESCE(?, last_z),
             afk_seconds = COALESCE(?, afk_seconds),
             play_seconds = COALESCE(?, play_seconds),
             updated_at = ?
         WHERE id = ? AND uuid = ? AND left_at IS NULL`
    ).run(
        body.dimension || null,
        body.position && typeof body.position.x === 'number' ? body.position.x : null,
        body.position && typeof body.position.y === 'number' ? body.position.y : null,
        body.position && typeof body.position.z === 'number' ? body.position.z : null,
        Number.isFinite(body.afkSeconds) ? body.afkSeconds : null,
        Number.isFinite(body.playSeconds) ? body.playSeconds : null,
        nowIso(),
        body.sessionId,
        payload.sub
    )

    if (result.changes === 0) {
        throw new ApiError(404, 'NOT_FOUND', '게임 세션을 찾을 수 없습니다.')
    }
    return { status: 200, payload: { ok: true } }
}

async function modSessionEnd(ctx) {
    const { db, config, body } = ctx
    const payload = verifyOrThrow(getBearer(ctx.req), config.jwtSecret, 'mod')
    if (!body.sessionId) {
        throw new ApiError(400, 'BAD_REQUEST', 'sessionId 가 필요합니다.')
    }

    db.prepare(
        `UPDATE game_sessions
         SET left_at = ?, play_seconds = COALESCE(?, play_seconds), afk_seconds = COALESCE(?, afk_seconds), updated_at = ?
         WHERE id = ? AND uuid = ?`
    ).run(
        body.leftAt || nowIso(),
        Number.isFinite(body.playSeconds) ? body.playSeconds : null,
        Number.isFinite(body.afkSeconds) ? body.afkSeconds : null,
        nowIso(),
        body.sessionId,
        payload.sub
    )

    return { status: 200, payload: { ok: true } }
}

async function modEvents(ctx) {
    const { db, config, body } = ctx
    const payload = verifyOrThrow(getBearer(ctx.req), config.jwtSecret, 'mod')
    const events = Array.isArray(body.events) ? body.events : []
    if (events.length === 0) {
        return { status: 200, payload: { ok: true, inserted: 0 } }
    }
    if (events.length > 100) {
        throw new ApiError(400, 'BAD_REQUEST', '이벤트는 한 번에 100건까지입니다.')
    }

    let inserted = 0
    tx(db, () => {
        const skillStmt = db.prepare(
            'INSERT INTO skill_events (uuid, job, level, exp, observed_at, source, raw) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        const moneyStmt = db.prepare(
            'INSERT INTO money_snapshots (uuid, balance, observed_at, source) VALUES (?, ?, ?, ?)'
        )
        for (const event of events) {
            const at = event.at || nowIso()
            if (event.kind === 'skill' && event.job) {
                skillStmt.run(
                    payload.sub,
                    String(event.job),
                    Number.isFinite(event.level) ? event.level : null,
                    Number.isFinite(event.exp) ? event.exp : null,
                    at,
                    event.source || null,
                    event.raw || null
                )
                inserted += 1
            } else if (event.kind === 'money' && Number.isFinite(event.balance)) {
                moneyStmt.run(payload.sub, event.balance, at, event.source || null)
                inserted += 1
            }
        }
    })

    return { status: 200, payload: { ok: true, inserted } }
}

// -----------------------------------------------------------------------------
// 관리자 핸들러
// -----------------------------------------------------------------------------

async function adminAudit(ctx) {
    const { db, url } = ctx
    const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500)
    const rows = db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(limit)
    return { status: 200, payload: { ok: true, audit: rows } }
}

async function adminRequests(ctx) {
    const { db, url } = ctx
    const status = url.searchParams.get('status')
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200)

    const rows = status
        ? db.prepare(
            `SELECT r.*, u.nickname AS user_nickname, u.status AS user_status
             FROM approval_requests r LEFT JOIN users u ON u.uuid = r.uuid
             WHERE r.status = ? ORDER BY r.requested_at DESC LIMIT ?`
        ).all(status, limit)
        : db.prepare(
            `SELECT r.*, u.nickname AS user_nickname, u.status AS user_status
             FROM approval_requests r LEFT JOIN users u ON u.uuid = r.uuid
             ORDER BY r.requested_at DESC LIMIT ?`
        ).all(limit)

    return { status: 200, payload: { ok: true, requests: rows } }
}

async function adminDecision(ctx) {
    const { db, body, params, actor } = ctx
    const requestId = params[0]
    const decision = body.decision
    // 디스코드 봇이 보낸 처리자(닉네임#태그)를 우선 사용
    const actorName = typeof body.actor === 'string' && body.actor.trim() !== '' ? body.actor.trim() : actor

    if (!['approved', 'denied', 'held'].includes(decision)) {
        throw new ApiError(400, 'BAD_REQUEST', 'decision 은 approved / denied / held 중 하나여야 합니다.')
    }

    const request = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(requestId)
    if (request == null) {
        throw new ApiError(404, 'NOT_FOUND', '승인 요청을 찾을 수 없습니다.')
    }
    if (!['pending', 'held'].includes(request.status)) {
        throw new ApiError(409, 'ALREADY_DECIDED', '이미 처리된 요청입니다.')
    }

    tx(db, () => {
        db.prepare(
            `UPDATE approval_requests
             SET status = ?, handled_by = ?, handled_at = ?, note = ?
             WHERE id = ?`
        ).run(decision, actorName, nowIso(), body.note || null, requestId)

        if (decision === 'approved') {
            db.prepare(
                `UPDATE users
                 SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ?
                 WHERE uuid = ?`
            ).run(actorName, nowIso(), nowIso(), request.uuid)
        }
        audit(db, actorName, `approval_${decision}`, request.uuid, {
            requestId,
            note: body.note || null
        })
    })

    return { status: 200, payload: { ok: true, requestId, decision } }
}

async function adminBan(ctx) {
    const { db, body, params, actor } = ctx
    const uuid = normalizeUuid(params[0])
    const user = db.prepare('SELECT * FROM users WHERE uuid = ?').get(uuid)
    if (user == null) {
        throw new ApiError(404, 'NOT_FOUND', '사용자를 찾을 수 없습니다.')
    }

    tx(db, () => {
        db.prepare(
            'INSERT INTO bans (uuid, reason, banned_by, created_at, expires_at, active) VALUES (?, ?, ?, ?, ?, 1)'
        ).run(uuid, body.reason || null, actor, nowIso(), body.until || null)
        db.prepare('UPDATE users SET status = \'banned\', updated_at = ? WHERE uuid = ?')
            .run(nowIso(), uuid)
        audit(db, actor, 'ban', uuid, { reason: body.reason || null, until: body.until || null })
    })

    return { status: 200, payload: { ok: true, uuid, status: 'banned' } }
}

async function adminUnban(ctx) {
    const { db, params, actor } = ctx
    const uuid = normalizeUuid(params[0])
    const user = db.prepare('SELECT * FROM users WHERE uuid = ?').get(uuid)
    if (user == null) {
        throw new ApiError(404, 'NOT_FOUND', '사용자를 찾을 수 없습니다.')
    }

    tx(db, () => {
        db.prepare('UPDATE bans SET active = 0 WHERE uuid = ? AND active = 1').run(uuid)
        db.prepare('UPDATE users SET status = \'approved\', updated_at = ? WHERE uuid = ?')
            .run(nowIso(), uuid)
        audit(db, actor, 'unban', uuid, {})
    })

    return { status: 200, payload: { ok: true, uuid, status: 'approved' } }
}

async function adminUser(ctx) {
    const { db, params } = ctx
    const uuid = normalizeUuid(params[0])
    const user = db.prepare('SELECT * FROM users WHERE uuid = ?').get(uuid)
    if (user == null) {
        throw new ApiError(404, 'NOT_FOUND', '사용자를 찾을 수 없습니다.')
    }

    return {
        status: 200,
        payload: {
            ok: true,
            user,
            bans: db.prepare('SELECT * FROM bans WHERE uuid = ? ORDER BY created_at DESC LIMIT 10').all(uuid),
            launcherSessions: db.prepare(
                'SELECT * FROM launcher_sessions WHERE uuid = ? ORDER BY started_at DESC LIMIT 10'
            ).all(uuid),
            gameSessions: db.prepare(
                'SELECT * FROM game_sessions WHERE uuid = ? ORDER BY joined_at DESC LIMIT 10'
            ).all(uuid),
            skills: db.prepare(
                'SELECT * FROM skill_events WHERE uuid = ? ORDER BY observed_at DESC LIMIT 20'
            ).all(uuid),
            money: db.prepare(
                'SELECT * FROM money_snapshots WHERE uuid = ? ORDER BY observed_at DESC LIMIT 10'
            ).all(uuid)
        }
    }
}

async function adminOverview(ctx) {
    const { db } = ctx
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString()
    const todayStart = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z'

    const online = db.prepare(
        'SELECT COUNT(*) AS c FROM launcher_sessions WHERE ended_at IS NULL AND last_heartbeat_at > ?'
    ).get(twoMinutesAgo).c
    const pending = db.prepare('SELECT COUNT(*) AS c FROM approval_requests WHERE status = \'pending\'').get().c
    const activeBans = db.prepare('SELECT COUNT(*) AS c FROM users WHERE status = \'banned\'').get().c
    const todayUnique = db.prepare(
        'SELECT COUNT(DISTINCT uuid) AS c FROM launcher_sessions WHERE started_at >= ?'
    ).get(todayStart).c

    return {
        status: 200,
        payload: { ok: true, online, pendingRequests: pending, activeBans, todayUnique }
    }
}

// -----------------------------------------------------------------------------
// 라우팅
// -----------------------------------------------------------------------------

const routes = [
    ['POST', /^\/v1\/launcher\/session\/start$/, launcherSessionStart, false],
    ['GET', /^\/v1\/launcher\/status$/, launcherStatus, false],
    ['POST', /^\/v1\/launcher\/heartbeat$/, launcherHeartbeat, false],
    ['POST', /^\/v1\/launcher\/session\/end$/, launcherSessionEnd, false],

    ['POST', /^\/v1\/mod\/session\/start$/, modSessionStart, false],
    ['POST', /^\/v1\/mod\/heartbeat$/, modHeartbeat, false],
    ['POST', /^\/v1\/mod\/session\/end$/, modSessionEnd, false],
    ['POST', /^\/v1\/mod\/events$/, modEvents, false],

    ['GET', /^\/v1\/admin\/audit$/, adminAudit, true],
    ['GET', /^\/v1\/admin\/requests$/, adminRequests, true],
    ['POST', /^\/v1\/admin\/requests\/([^/]+)\/decision$/, adminDecision, true],
    ['POST', /^\/v1\/admin\/users\/([^/]+)\/ban$/, adminBan, true],
    ['POST', /^\/v1\/admin\/users\/([^/]+)\/unban$/, adminUnban, true],
    ['GET', /^\/v1\/admin\/users\/([^/]+)$/, adminUser, true],
    ['GET', /^\/v1\/admin\/overview$/, adminOverview, true]
]

function buildServer({ db, config }) {
    const dashboard = createDashboard({ db, config })

    return http.createServer(async (req, res) => {
        const startedAt = Date.now()
        const requestId = `req_${newId()}`
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
        const ip = clientIp(req)

        try {
            if (url.pathname === '/healthz') {
                sendJson(res, 200, { ok: true, at: nowIso() }, requestId)
                return
            }

            if (await dashboard(req, res, url, ip)) {
                return
            }

            rateLimit(`ip:${ip || 'unknown'}`)

            let matched = null
            for (const [method, pattern, handler, admin] of routes) {
                if (req.method !== method) continue
                const match = pattern.exec(url.pathname)
                if (match == null) continue
                matched = { handler, admin, params: match.slice(1) }
                break
            }

            if (matched == null) {
                throw new ApiError(404, 'NOT_FOUND', '엔드포인트를 찾을 수 없습니다.')
            }

            if (matched.admin) {
                requireAdmin(req, config)
            }

            const body = req.method === 'POST' ? await readJson(req) : {}
            const ctx = {
                req,
                res,
                url,
                db,
                config,
                body,
                ip,
                params: matched.params,
                actor: matched.admin ? (req.headers['x-actor'] || 'admin') : 'system',
                requestId
            }

            const result = await matched.handler(ctx)
            sendJson(res, result.status, { ...result.payload, traceId: requestId }, requestId)
        } catch (err) {
            if (err instanceof ApiError) {
                sendJson(res, err.status, {
                    error: { code: err.code, message: err.message },
                    traceId: requestId
                }, requestId)
            } else {
                console.error('[eunwol] 처리되지 않은 오류:', err)
                sendJson(res, 500, {
                    error: { code: 'INTERNAL', message: '서버 오류가 발생했습니다.' },
                    traceId: requestId
                }, requestId)
            }
        } finally {
            console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - startedAt}ms`)
        }
    })
}

if (require.main === module) {
    const config = loadConfig()
    const db = open(config.dbPath)
    const server = buildServer({ db, config })

    server.listen(config.port, () => {
        console.log(`[eunwol] http://127.0.0.1:${config.port}`)
        console.log(`[eunwol] db=${config.dbPath}`)
        console.log(`[eunwol] minLauncherVersion=${config.minLauncherVersion}`)
    })

    const shutdown = () => {
        server.close(() => {
            try { db.close() } catch (_) { /* ignore */ }
            process.exit(0)
        })
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
}

module.exports = { buildServer, loadConfig, open }
