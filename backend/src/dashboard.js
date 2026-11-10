'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const jwt = require('./jwt')
const { computeInactivity } = require('./inactivity')

const DASHBOARD_DIR = path.join(__dirname, '..', '..', 'dashboard')
const COOKIE_NAME = 'eunwol_dash'
const SESSION_TTL = 12 * 60 * 60 // 12시간

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
}

function parseCookies(req) {
    const header = req.headers.cookie || ''
    const out = {}
    for (const part of header.split(';')) {
        const idx = part.indexOf('=')
        if (idx < 0) continue
        const key = part.slice(0, idx).trim()
        const value = part.slice(idx + 1).trim()
        if (key) out[key] = decodeURIComponent(value)
    }
    return out
}

function cookie(name, value, options = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`]
    parts.push(`Path=${options.path || '/'}`)
    if (options.maxAge != null) parts.push(`Max-Age=${options.maxAge}`)
    parts.push('HttpOnly')
    parts.push('SameSite=Lax')
    if (options.secure) parts.push('Secure')
    return parts.join('; ')
}

function clearCookie(name) {
    return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
}

function isSecure(req) {
    return (req.headers['x-forwarded-proto'] || '').includes('https') ||
        (req.headers.origin || '').startsWith('https://')
}

const recentLogs = new Map()

function createDashboard({ db, config }) {
    const secret = config.dashboardSecret || config.jwtSecret

    function readBody(req, limit = 1024 * 512) {
        return new Promise((resolve, reject) => {
            const chunks = []
            let size = 0
            req.on('data', (chunk) => {
                size += chunk.length
                if (size > limit) {
                    reject(new Error('too large'))
                    req.destroy()
                    return
                }
                chunks.push(chunk)
            })
            req.on('end', () => {
                if (chunks.length === 0) return resolve({})
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
                } catch (_) {
                    resolve({})
                }
            })
            req.on('error', reject)
        })
    }

    function sendJson(res, status, payload) {
        const body = JSON.stringify(payload)
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
            'Cache-Control': 'no-store'
        })
        res.end(body)
    }

    function sendHtml(res, status, html) {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
    }

    function redirect(res, location, headers = []) {
        res.writeHead(302, { Location: location, ...Object.fromEntries(headers.map((h) => h.split(': '))) })
        res.end()
    }

    function session(req) {
        const cookies = parseCookies(req)
        const token = cookies[COOKIE_NAME]
        if (!token) return null
        const payload = jwt.verify(token, secret)
        if (payload == null || payload.typ !== 'dashboard') return null
        return payload
    }

    function audit(actor, action, targetUuid, payload) {
        db.prepare(
            'INSERT INTO audit_log (actor, action, target_uuid, payload_json, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(actor || null, action, targetUuid || null, payload == null ? null : JSON.stringify(payload), new Date().toISOString())
    }

    function logVisit(action, req, ip, me) {
        const key = action + ':' + (me && me.sub ? me.sub : ip)
        const now = Date.now()
        if (recentLogs.get(key) != null && now - recentLogs.get(key) < 5 * 60 * 1000) {
            return
        }
        recentLogs.set(key, now)

        const actor = me && me.name ? me.name : 'anonymous (' + (ip || 'unknown') + ')'
        audit(actor, action, null, {
            ip: ip || null,
            ua: req.headers['user-agent'] || null,
            path: req.url
        })
    }

    function serveStatic(res, name) {
        const file = path.join(DASHBOARD_DIR, name)
        if (!file.startsWith(DASHBOARD_DIR)) return false
        if (!fs.existsSync(file)) return false
        const ext = path.extname(file)
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-store'
        })
        fs.createReadStream(file).pipe(res)
        return true
    }

    // ------------------------------------------------------------------
    // Discord OAuth
    // ------------------------------------------------------------------

    async function authStart(req, res) {
        if (!config.discordClientId || !config.discordRedirectUri) {
            sendHtml(res, 500, '<h1>Discord OAuth 설정이 없습니다.</h1>')
            return
        }
        const state = crypto.randomBytes(24).toString('hex')
        const url = new URL('https://discord.com/oauth2/authorize')
        url.searchParams.set('client_id', config.discordClientId)
        url.searchParams.set('response_type', 'code')
        url.searchParams.set('scope', 'identify guilds.members.read')
        url.searchParams.set('redirect_uri', config.discordRedirectUri)
        url.searchParams.set('state', state)
        url.searchParams.set('prompt', 'consent')

        res.writeHead(302, {
            Location: url.toString(),
            'Set-Cookie': cookie('eunwol_oauth_state', state, { maxAge: 600, secure: isSecure(req) })
        })
        res.end()
    }

    async function authCallback(req, res, url, ip) {
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        const cookies = parseCookies(req)

        if (!code || !state || cookies.eunwol_oauth_state !== state) {
            sendHtml(res, 400, '<h1>로그인 요청이 올바르지 않습니다.</h1><p><a href="/auth/discord">다시 시도</a></p>')
            return
        }

        try {
            const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: config.discordClientId,
                    client_secret: config.discordClientSecret,
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: config.discordRedirectUri
                })
            })
            const tokenJson = await tokenRes.json()
            if (!tokenJson.access_token) {
                throw new Error(tokenJson.error_description || 'token exchange failed')
            }

            const userRes = await fetch('https://discord.com/api/v10/users/@me', {
                headers: { Authorization: `Bearer ${tokenJson.access_token}` }
            })
            const user = await userRes.json()

            let roles = []
            if (config.discordGuildId) {
                const memberRes = await fetch(
                    `https://discord.com/api/v10/users/@me/guilds/${config.discordGuildId}/member`,
                    { headers: { Authorization: `Bearer ${tokenJson.access_token}` } }
                )
                if (memberRes.ok) {
                    const member = await memberRes.json()
                    roles = member.roles || []
                }
            }

            if (!config.discordAdminRoleId || !roles.includes(config.discordAdminRoleId)) {
                audit('denied: ' + user.username + ' (' + user.id + ')', 'dashboard_login_denied', null, {
                    ip: ip || null,
                    ua: req.headers['user-agent'] || null
                })
                sendHtml(res, 403, `<!doctype html><meta charset="utf-8"><body style="background:#0f1419;color:#e6edf3;font-family:sans-serif;padding:40px">
                    <h1>접근 권한이 없습니다</h1>
                    <p>마을 관리자 역할이 있는 계정만 대시보드를 사용할 수 있습니다.</p>
                    <p><a style="color:#7aa2f7" href="/auth/discord">다시 로그인</a></p></body>`)
                return
            }

            const displayName = user.global_name || user.username
            const token = jwt.sign(
                { sub: user.id, name: `${displayName} (${user.username})`, avatar: user.avatar || null, typ: 'dashboard' },
                secret,
                SESSION_TTL
            )

            audit(`${displayName} (${user.id})`, 'dashboard_login', null, {
                username: user.username,
                ip: ip || req.socket.remoteAddress || null,
                ua: req.headers['user-agent'] || null
            })

            res.writeHead(302, {
                Location: '/',
                'Set-Cookie': [
                    cookie(COOKIE_NAME, token, { maxAge: SESSION_TTL, secure: isSecure(req) }),
                    clearCookie('eunwol_oauth_state')
                ]
            })
            res.end()
        } catch (err) {
            console.error('[dashboard] oauth 실패:', err.message)
            sendHtml(res, 500, '<h1>로그인 처리 실패</h1><p><a href="/auth/discord">다시 시도</a></p>')
        }
    }

    // ------------------------------------------------------------------
    // API
    // ------------------------------------------------------------------

    function touchPresence(me, ip) {
        if (!me || !me.sub) return
        db.prepare(
            `INSERT INTO dashboard_presence (discord_id, name, avatar, last_seen_at, ip)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(discord_id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar, last_seen_at = excluded.last_seen_at, ip = excluded.ip`
        ).run(me.sub, me.name || me.sub, me.avatar || null, new Date().toISOString(), ip || null)
    }

    function onlineAdmins() {
        db.prepare('DELETE FROM dashboard_presence WHERE last_seen_at < ?').run(new Date(Date.now() - 10 * 60 * 1000).toISOString())
        const cutoff = new Date(Date.now() - 45 * 1000).toISOString()
        return db.prepare(
            'SELECT discord_id, name, avatar, last_seen_at FROM dashboard_presence WHERE last_seen_at > ? ORDER BY last_seen_at DESC'
        ).all(cutoff)
    }

    function apiOverview() {
        const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString()
        const today = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z'
        const one = (sql, ...args) => db.prepare(sql).get(...args).c

        return {
            online: one('SELECT COUNT(*) AS c FROM launcher_sessions WHERE ended_at IS NULL AND last_heartbeat_at > ?', twoMinAgo),
            inGame: one('SELECT COUNT(*) AS c FROM game_sessions WHERE left_at IS NULL'),
            pending: one(`SELECT COUNT(*) AS c FROM approval_requests WHERE status = 'pending'`),
            banned: one(`SELECT COUNT(*) AS c FROM users WHERE status = 'banned'`),
            todayUnique: one('SELECT COUNT(DISTINCT uuid) AS c FROM launcher_sessions WHERE started_at >= ?', today),
            totalUsers: one('SELECT COUNT(*) AS c FROM users')
        }
    }

    function apiOnline() {
        const aliveSince = new Date(Date.now() - 90 * 1000).toISOString()
        return db.prepare(`
            SELECT u.uuid, u.nickname, u.status,
                   g.server_address, g.dimension, g.play_seconds, g.afk_seconds, g.joined_at,
                   g.last_x, g.last_y, g.last_z,
                   (SELECT MAX(l.last_heartbeat_at) FROM launcher_sessions l WHERE l.uuid = g.uuid) AS last_heartbeat_at
            FROM game_sessions g
            JOIN users u ON u.uuid = g.uuid
            WHERE g.left_at IS NULL
              AND g.updated_at > ?
              AND g.id = (
                  SELECT g2.id FROM game_sessions g2
                  WHERE g2.uuid = g.uuid AND g2.left_at IS NULL
                  ORDER BY g2.joined_at DESC LIMIT 1
              )
            ORDER BY g.joined_at DESC
        `).all(aliveSince)
    }

    function apiPending() {
        return db.prepare(`
            SELECT r.id, r.uuid, r.nickname, r.requested_at, r.status,
                   u.last_seen_at, u.first_seen_at
            FROM approval_requests r
            LEFT JOIN users u ON u.uuid = r.uuid
            WHERE r.status = 'pending'
            ORDER BY r.requested_at DESC
        `).all()
    }

    function apiBanned() {
        return db.prepare(`
            SELECT u.uuid, u.nickname, u.updated_at,
                   (SELECT reason FROM bans b WHERE b.uuid = u.uuid AND b.active = 1 ORDER BY b.created_at DESC LIMIT 1) AS reason
            FROM users u
            WHERE u.status = 'banned'
            ORDER BY u.updated_at DESC
        `).all()
    }

    function apiUsers(q) {
        const like = `%${q || ''}%`
        return db.prepare(`
            SELECT u.uuid, u.nickname, u.status, u.first_seen_at, u.last_seen_at, u.approved_at,
                   (SELECT COALESCE(SUM(play_seconds), 0) FROM game_sessions g WHERE g.uuid = u.uuid) AS total_play,
                   (SELECT COUNT(*) FROM game_sessions g WHERE g.uuid = u.uuid) AS session_count
            FROM users u
            WHERE u.nickname LIKE ? OR u.uuid LIKE ?
            ORDER BY u.last_seen_at DESC
            LIMIT 200
        `).all(like, like)
    }

    function apiUserDetail(uuid) {
        const user = db.prepare('SELECT * FROM users WHERE uuid = ?').get(uuid)
        if (user == null) return null

        const aliveSince = new Date(Date.now() - 90 * 1000).toISOString()
        const current = db.prepare(
            'SELECT * FROM game_sessions WHERE uuid = ? AND left_at IS NULL AND updated_at > ? ORDER BY joined_at DESC LIMIT 1'
        ).get(uuid, aliveSince) || null

        const sessions = db.prepare(
            'SELECT * FROM game_sessions WHERE uuid = ? ORDER BY joined_at DESC LIMIT 10'
        ).all(uuid)

        const launcher = db.prepare(
            `SELECT id, started_at, ended_at, last_heartbeat_at, ip_masked, launcher_version, os
             FROM launcher_sessions WHERE uuid = ? ORDER BY started_at DESC LIMIT 5`
        ).all(uuid)

        const skills = db.prepare(
            'SELECT * FROM skill_events WHERE uuid = ? ORDER BY observed_at DESC LIMIT 10'
        ).all(uuid)

        const money = db.prepare(
            'SELECT * FROM money_snapshots WHERE uuid = ? ORDER BY observed_at DESC LIMIT 5'
        ).all(uuid)

        const bans = db.prepare(
            'SELECT * FROM bans WHERE uuid = ? ORDER BY created_at DESC LIMIT 5'
        ).all(uuid)

        const totalPlay = db.prepare(
            'SELECT COALESCE(SUM(play_seconds), 0) AS s FROM game_sessions WHERE uuid = ?'
        ).get(uuid).s

        return { user, current, sessions, launcher, skills, money, bans, totalPlay }
    }

    function apiInactivity() {
        return computeInactivity(db)
    }

    function apiAudit(limit) {
        return db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(limit)
    }

    return async function handle(req, res, url, ip) {
        const p = url.pathname

        if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
            const current = session(req)
            logVisit(current ? 'dashboard_access' : 'dashboard_visit', req, ip, current)
        }
        if (req.method === 'GET' && p === '/auth/discord') {
            logVisit('dashboard_login_attempt', req, ip, session(req))
        }

        // 정적 파일
        if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
            if (serveStatic(res, 'index.html')) return true
        }
        if (req.method === 'GET' && (p === '/app.js' || p === '/style.css')) {
            if (serveStatic(res, p.slice(1))) return true
        }

        if (p === '/auth/discord' && req.method === 'GET') {
            await authStart(req, res)
            return true
        }
        if (p === '/auth/discord/callback' && req.method === 'GET') {
            await authCallback(req, res, url, ip)
            return true
        }
        if (p === '/auth/logout' && req.method === 'POST') {
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Set-Cookie': clearCookie(COOKIE_NAME)
            })
            res.end(JSON.stringify({ ok: true }))
            return true
        }

        if (!p.startsWith('/api/')) return false

        const me = session(req)
        if (me == null) {
            sendJson(res, 401, { error: 'UNAUTHORIZED' })
            return true
        }

        try {
            if (p === '/api/presence' && req.method === 'POST') {
                touchPresence(me, ip)
                sendJson(res, 200, { ok: true, online: onlineAdmins() })
                return true
            }
            if (p === '/api/me' && req.method === 'GET') {
                touchPresence(me, ip)
                sendJson(res, 200, { ok: true, user: { name: me.name } })
                return true
            }
            if (p === '/api/overview' && req.method === 'GET') {
                sendJson(res, 200, { ok: true, ...apiOverview() })
                return true
            }
            if (p === '/api/online' && req.method === 'GET') {
                sendJson(res, 200, { ok: true, online: apiOnline() })
                return true
            }
            if (p === '/api/pending' && req.method === 'GET') {
                sendJson(res, 200, { ok: true, pending: apiPending() })
                return true
            }
            if (p === '/api/banned' && req.method === 'GET') {
                sendJson(res, 200, { ok: true, banned: apiBanned() })
                return true
            }
            if (p === '/api/users' && req.method === 'GET') {
                sendJson(res, 200, { ok: true, users: apiUsers(url.searchParams.get('q') || '') })
                return true
            }
            if (p === '/api/inactivity' && req.method === 'GET') {
                sendJson(res, 200, { ok: true, buckets: apiInactivity() })
                return true
            }
            if (p === '/api/audit' && req.method === 'GET') {
                const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500)
                sendJson(res, 200, { ok: true, audit: apiAudit(limit) })
                return true
            }

            if (p.startsWith('/api/requests/') && p.endsWith('/decision') && req.method === 'POST') {
                const requestId = p.split('/')[3]
                const body = await readBody(req)
                const decision = body.decision
                if (!['approved', 'denied', 'held'].includes(decision)) {
                    sendJson(res, 400, { error: 'BAD_DECISION' })
                    return true
                }
                const request = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(requestId)
                if (request == null) {
                    sendJson(res, 404, { error: 'NOT_FOUND' })
                    return true
                }
                if (!['pending', 'held'].includes(request.status)) {
                    sendJson(res, 409, { error: 'ALREADY_DECIDED' })
                    return true
                }
                db.prepare(`UPDATE approval_requests SET status = ?, handled_by = ?, handled_at = ?, note = ? WHERE id = ?`)
                    .run(decision, me.name, new Date().toISOString(), body.note || null, requestId)
                if (decision === 'approved') {
                    db.prepare(`UPDATE users SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE uuid = ?`)
                        .run(me.name, new Date().toISOString(), new Date().toISOString(), request.uuid)
                }
                audit(me.name, `approval_${decision}`, request.uuid, { requestId, note: body.note || null, source: 'dashboard' })
                sendJson(res, 200, { ok: true })
                return true
            }

            if (p.startsWith('/api/users/') && p.endsWith('/detail') && req.method === 'GET') {
                const uuid = p.split('/')[3]
                const detail = apiUserDetail(uuid)
                if (detail == null) {
                    sendJson(res, 404, { error: 'NOT_FOUND' })
                    return true
                }
                sendJson(res, 200, { ok: true, ...detail })
                return true
            }

            if (p.startsWith('/api/users/') && req.method === 'DELETE') {
                const uuid = p.split('/')[3]
                const user = db.prepare('SELECT * FROM users WHERE uuid = ?').get(uuid)
                if (user == null) {
                    sendJson(res, 404, { error: 'NOT_FOUND' })
                    return true
                }
                db.exec('BEGIN')
                try {
                    db.prepare('DELETE FROM launcher_sessions WHERE uuid = ?').run(uuid)
                    db.prepare('DELETE FROM game_sessions WHERE uuid = ?').run(uuid)
                    db.prepare('DELETE FROM skill_events WHERE uuid = ?').run(uuid)
                    db.prepare('DELETE FROM money_snapshots WHERE uuid = ?').run(uuid)
                    db.prepare('DELETE FROM bans WHERE uuid = ?').run(uuid)
                    db.prepare('DELETE FROM discord_requests WHERE target_uuid = ?').run(uuid)
                    db.prepare('DELETE FROM approval_requests WHERE uuid = ?').run(uuid)
                    db.prepare('DELETE FROM users WHERE uuid = ?').run(uuid)
                    db.exec('COMMIT')
                } catch (err) {
                    db.exec('ROLLBACK')
                    throw err
                }
                audit(me.name, 'user_deleted', uuid, {
                    nickname: user.nickname,
                    status: user.status,
                    source: 'dashboard'
                })
                sendJson(res, 200, { ok: true })
                return true
            }

            if (p.startsWith('/api/users/') && p.endsWith('/ban') && req.method === 'POST') {
                const uuid = p.split('/')[3]
                const body = await readBody(req)
                const user = db.prepare('SELECT * FROM users WHERE uuid = ?').get(uuid)
                if (user == null) {
                    sendJson(res, 404, { error: 'NOT_FOUND' })
                    return true
                }
                db.prepare('INSERT INTO bans (uuid, reason, banned_by, created_at, active) VALUES (?, ?, ?, ?, 1)')
                    .run(uuid, body.reason || null, me.name, new Date().toISOString())
                db.prepare(`UPDATE users SET status = 'banned', updated_at = ? WHERE uuid = ?`)
                    .run(new Date().toISOString(), uuid)
                audit(me.name, 'ban', uuid, { reason: body.reason || null, source: 'dashboard' })
                sendJson(res, 200, { ok: true })
                return true
            }

            if (p.startsWith('/api/users/') && p.endsWith('/unban') && req.method === 'POST') {
                const uuid = p.split('/')[3]
                const user = db.prepare('SELECT * FROM users WHERE uuid = ?').get(uuid)
                if (user == null) {
                    sendJson(res, 404, { error: 'NOT_FOUND' })
                    return true
                }
                db.prepare('UPDATE bans SET active = 0 WHERE uuid = ? AND active = 1').run(uuid)
                db.prepare(`UPDATE users SET status = 'approved', updated_at = ? WHERE uuid = ?`)
                    .run(new Date().toISOString(), uuid)
                audit(me.name, 'unban', uuid, { source: 'dashboard' })
                sendJson(res, 200, { ok: true })
                return true
            }

            sendJson(res, 404, { error: 'NOT_FOUND' })
            return true
        } catch (err) {
            console.error('[dashboard] api 오류:', err)
            sendJson(res, 500, { error: 'INTERNAL' })
            return true
        }
    }
}

module.exports = { createDashboard }
