'use strict'

/**
 * 은월 백엔드 클라이언트 (메인 프로세스)
 *
 * - 세션 시작/하트비트/종료
 * - 승인 대기 폴링
 * - 밴 감지 시 렌더러에 알림
 *
 * 백엔드 주소는 EUNWOL_API_URL 환경변수로 덮어쓸 수 있다.
 */

const { ipcMain, app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DEFAULT_BASE_URL = 'https://eunwol.duckdns.org'
const HEARTBEAT_INTERVAL_MS = 30 * 1000
const REQUEST_TIMEOUT_MS = 10 * 1000

const state = {
    baseUrl: (process.env.EUNWOL_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    accessToken: null,
    sessionToken: null,
    modToken: null,
    refreshToken: null,
    pendingToken: null,
    requestId: null,
    heartbeatTimer: null,
    intentionalQuit: false
}

function apiUrl(path) {
    return `${state.baseUrl}${path}`
}

async function request(method, path, { token, body } = {}) {
    const headers = { Accept: 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    if (body != null) headers['Content-Type'] = 'application/json'

    const response = await fetch(apiUrl(path), {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })

    let json = null
    try {
        json = await response.json()
    } catch (_) {
        json = null
    }

    return { http: response.status, body: json }
}

async function reportSecurity(kind, detail) {
    try {
        await request('POST', '/v1/security/report', {
            token: state.sessionToken,
            body: { kind, detail }
        })
    } catch (_) { /* ignore */ }
}

async function ensureSecureMods() {
    await flushSecurity()
    if (state.sessionToken == null) {
        throw new Error('로그인 세션이 없습니다.')
    }

    const keyRes = await request('GET', '/v1/mod/key', { token: state.sessionToken })
    if (keyRes.http !== 200 || keyRes.body == null || !keyRes.body.key) {
        throw new Error('보안 모드 키를 받을 수 없습니다.')
    }
    const key = Buffer.from(keyRes.body.key, 'base64')
    if (key.length !== 32) throw new Error('보안 모드 키 형식이 올바르지 않습니다.')

    const manifestUrl = apiUrl('/secure-mods/manifest.json?t=' + Date.now())
    const manifestRes = await fetch(manifestUrl, { signal: AbortSignal.timeout(20000) })
    if (!manifestRes.ok) throw new Error('보안 모드 목록을 받을 수 없습니다.')
    const manifestText = await manifestRes.text()

    const expected = crypto.createHmac('sha256', key).update(manifestText).digest('hex')
    const sigRes = await fetch(apiUrl('/secure-mods/manifest.sig'), { signal: AbortSignal.timeout(10000) })
    const actual = (await sigRes.text()).trim()
    if (expected !== actual) throw new Error('보안 모드 목록 서명이 올바르지 않습니다.')

    const manifest = JSON.parse(manifestText)
    const cacheDir = path.join(app.getPath('userData'), 'secure-mods',
        crypto.createHash('sha256').update(manifestText).digest('hex').slice(0, 16))
    fs.mkdirSync(cacheDir, { recursive: true })

    let count = 0
    const jars = []
    for (const file of manifest.files) {
        const target = path.join(cacheDir, file.file.replace(/\.enc$/, ''))
        const encRes = await fetch(apiUrl('/secure-mods/' + encodeURIComponent(file.file) + '?v=' + encodeURIComponent(file.sha256)), { signal: AbortSignal.timeout(600000) })
        if (!encRes.ok) throw new Error('보안 모드 다운로드 실패: ' + file.file)
        const payload = Buffer.from(await encRes.arrayBuffer())
        const digest = crypto.createHash('sha256').update(payload).digest('hex')
        if (digest !== file.sha256) {
            await reportSecurity('integrity_failed', { file: file.file, reason: 'sha256_mismatch' })
            throw new Error('보안 모드 무결성 검증 실패: ' + file.file)
        }

        const nonce = payload.subarray(8, 20)
        const tag = payload.subarray(20, 36)
        const body = payload.subarray(36)
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
        decipher.setAuthTag(tag)
        let plain
        try {
            plain = Buffer.concat([decipher.update(body), decipher.final()])
        } catch (err) {
            await reportSecurity('integrity_failed', { file: file.file, reason: 'decrypt_failed' })
            throw err
        }
        fs.writeFileSync(target, plain)
        jars.push(target)
        count++
    }

    const localChat = process.env.EUNWOL_LOCAL_CHAT_JAR
    if (localChat && fs.existsSync(localChat)) {
        const index = jars.findIndex((jar) => /eunwolcore-chat-/i.test(String(jar)))
        if (index >= 0) {
            fs.copyFileSync(localChat, jars[index])
            console.log('[backend] local chat jar injected:', localChat)
        }
    }
    return { dir: cacheDir, count, jars }
}

function markIntentionalQuit() {
    state.intentionalQuit = true
}

function stopHeartbeat() {
    if (state.heartbeatTimer != null) {
        clearInterval(state.heartbeatTimer)
        state.heartbeatTimer = null
    }
}

function notifyRenderer(channel, payload) {
    for (const window of BrowserWindow.getAllWindows()) {
        try {
            window.webContents.send(channel, payload)
        } catch (_) {
            // 창이 닫히는 중일 수 있음
        }
    }
}

const slotHeartbeatTimers = new Map()

function startSlotHeartbeat(token) {
    if (token == null || token === '' || slotHeartbeatTimers.has(token)) return
    const timer = setInterval(async () => {
        try {
            await request('POST', '/v1/launcher/heartbeat', {
                token,
                body: { launcherVersion: app.getVersion(), uptimeSeconds: Math.round(process.uptime()) }
            })
        } catch (_) {
            // 다음 주기에 재시도
        }
    }, HEARTBEAT_INTERVAL_MS)
    slotHeartbeatTimers.set(token, timer)
}

function startHeartbeat() {
    stopHeartbeat()
    state.heartbeatTimer = setInterval(async () => {
        if (state.sessionToken == null) {
            return
        }
        try {
            const result = await request('POST', '/v1/launcher/heartbeat', {
                token: state.sessionToken,
                body: { launcherVersion: app.getVersion(), uptimeSeconds: Math.round(process.uptime()) }
            })
            if (result.http === 403 && result.body != null && result.body.error != null) {
                stopHeartbeat()
                notifyRenderer('backend:banned', {
                    reason: result.body.error.message || '마을원 자격이 종료되었습니다.'
                })
            }
        } catch (err) {
            // 네트워크 오류는 다음 하트비트에서 재시도
            console.error('[backend] heartbeat 실패:', err.message)
        }
    }, HEARTBEAT_INTERVAL_MS)
}

async function startSession(accessToken) {
    state.accessToken = accessToken

    const result = await request('POST', '/v1/launcher/session/start', {
        body: {
            minecraftAccessToken: accessToken,
            launcherVersion: app.getVersion(),
            os: process.platform,
            hwidHash: computeHwidHash()
        }
    })

    const body = result.body || {}

    if (result.http === 200 && body.status === 'approved' && body.sessionToken != null) {
        state.sessionToken = body.sessionToken
        state.modToken = body.modToken || null
        state.refreshToken = body.refreshToken || null
        state.pendingToken = null
        state.requestId = null
        startHeartbeat()
        return { status: 'approved' }
    }

    if (body.status === 'pending') {
        state.pendingToken = body.pendingToken || null
        state.requestId = body.requestId || null
        state.sessionToken = null
        return {
            status: 'pending',
            requestId: state.requestId,
            message: body.message || '관리자 승인 대기 중입니다.'
        }
    }

    if (result.http === 403 && body.error != null) {
        return {
            status: body.error.code === 'BANNED' ? 'banned' : 'error',
            reason: body.error.message || '사용할 수 없는 계정입니다.'
        }
    }

    if (result.http === 426) {
        return {
            status: 'outdated',
            message: (body.error && body.error.message) || '런처를 업데이트해 주세요.'
        }
    }

    return {
        status: 'error',
        message: (body.error && body.error.message) || `서버 응답 오류 (${result.http})`
    }
}

async function pollStatus() {
    if (state.pendingToken == null) {
        return { status: 'pending', requestId: state.requestId }
    }

    const result = await request('GET', '/v1/launcher/status', { token: state.pendingToken })

    if (result.http === 200 && result.body != null && result.body.status === 'approved') {
        // 승인됨 → 실제 세션 발급
        if (state.accessToken != null) {
            return startSession(state.accessToken)
        }
        return { status: 'approved' }
    }

    if (result.http === 403 && result.body != null && result.body.error != null) {
        return { status: 'banned', reason: result.body.error.message || '마을원 자격이 종료되었습니다.' }
    }

    if (result.http === 401) {
        return { status: 'error', message: '승인 정보가 만료되었습니다. 다시 로그인해 주세요.' }
    }

    return { status: 'pending', requestId: state.requestId }
}

async function endSession() {
    stopHeartbeat()
    if (state.sessionToken == null) {
        return { ok: true }
    }
    try {
        await request('POST', '/v1/launcher/session/end', {
            token: state.sessionToken,
            body: { uptimeSeconds: Math.round(process.uptime()) }
        })
    } catch (_) {
        // 종료 시점 오류는 무시
    }
    state.sessionToken = null
    state.modToken = null
    return { ok: true }
}

function computeHwidHash() {
    const os = require('os')
    const raw = [os.hostname(), os.userInfo().username, process.platform, process.arch].join('|')
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

function pendingSecurityPath() {
    return path.join(app.getPath('userData'), 'pending-security.json')
}

function queueSecurity(kind, detail) {
    try {
        const file = pendingSecurityPath()
        const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []
        list.push({ kind, detail, at: new Date().toISOString() })
        fs.writeFileSync(file, JSON.stringify(list.slice(-50)), 'utf8')
    } catch (_) { /* ignore */ }
}

async function flushSecurity() {
    try {
        const file = pendingSecurityPath()
        if (!fs.existsSync(file)) return
        const list = JSON.parse(fs.readFileSync(file, 'utf8'))
        const remain = []
        for (const item of list) {
            try {
                const res = await request('POST', '/v1/security/report', {
                    token: state.sessionToken,
                    body: { kind: item.kind, detail: item.detail }
                })
                if (res.http !== 200) remain.push(item)
            } catch (_) { remain.push(item) }
        }
        if (remain.length === 0) fs.unlinkSync(file)
        else fs.writeFileSync(file, JSON.stringify(remain), 'utf8')
    } catch (_) { /* ignore */ }
}

function register() {
    ipcMain.handle('backend:sessionStart', async (_event, payload) => {
        const accessToken = payload && payload.accessToken
        if (!accessToken) {
            return { status: 'error', message: '로그인 정보가 없습니다.' }
        }
        try {
            return await startSession(accessToken)
        } catch (err) {
            console.error('[backend] session start 실패:', err.message)
            return { status: 'error', message: '서버에 연결할 수 없습니다. 네트워크를 확인해 주세요.' }
        }
    })

    ipcMain.handle('backend:pollStatus', async () => {
        try {
            return await pollStatus()
        } catch (err) {
            console.error('[backend] status poll 실패:', err.message)
            return { status: 'pending', requestId: state.requestId }
        }
    })

    ipcMain.handle('backend:sessionFor', async (_event, accessToken) => {
        if (accessToken == null || accessToken === '') {
            return { ok: false, error: 'no access token' }
        }
        try {
            const res = await request('POST', '/v1/launcher/session/start', {
                body: {
                    minecraftAccessToken: accessToken,
                    launcherVersion: app.getVersion(),
                    os: process.platform,
                    hwidHash: computeHwidHash()
                }
            })
            if (res.http === 200 && res.body != null && res.body.modToken != null) {
                if (res.body.sessionToken) startSlotHeartbeat(res.body.sessionToken)
                return {
                    ok: true,
                    modToken: res.body.modToken,
                    refreshToken: res.body.refreshToken || null,
                    sessionToken: res.body.sessionToken || null,
                    nickname: res.body.user ? res.body.user.nickname : null
                }
            }
            return { ok: false, status: res.body ? res.body.status : null, error: res.body ? res.body.message : 'session failed' }
        } catch (err) {
            return { ok: false, error: err.message }
        }
    })

    ipcMain.handle('backend:buildGiraffePack', async (_event, instanceDir) => {
        try {
            const capturePath = path.join(instanceDir, 'config', 'eunwol-resourcepack.json')
            if (!fs.existsSync(capturePath)) return { ok: true, built: false, reason: 'no_capture' }
            const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'))
            let url = String(capture.url || '').split('#')[0]
            let hash = String(capture.hash || '').toLowerCase()
            try {
                const sharedRes = await fetch(apiUrl('/v1/resourcepack'), { signal: AbortSignal.timeout(10000) })
                if (sharedRes.ok) {
                    const shared = await sharedRes.json()
                    if (shared && shared.pack && shared.pack.url && shared.pack.hash) {
                        url = String(shared.pack.url).split('#')[0]
                        hash = String(shared.pack.hash).toLowerCase()
                    }
                }
            } catch (_) { }
            if (!url || !hash) return { ok: true, built: false, reason: 'invalid_capture' }

            const resourceDir = path.join(instanceDir, 'resourcepacks')
            const packPath = path.join(resourceDir, 'eunwol-giraffe-resourcepack.zip')
            const metaPath = path.join(resourceDir, '.eunwol-giraffe-pack.json')
            let previous = null
            try { previous = JSON.parse(fs.readFileSync(metaPath, 'utf8')) } catch (_) { }
            if (previous && previous.url === url && previous.hash === hash && fs.existsSync(packPath)) {
                return { ok: true, built: false }
            }

            fs.mkdirSync(resourceDir, { recursive: true })
            try { fs.rmSync(path.join(resourceDir, '[은월-기린 리소스팩].zip'), { force: true }) } catch (_) { }
            const response = await fetch(url, { signal: AbortSignal.timeout(300000) })
            if (!response.ok) throw new Error('resourcepack HTTP ' + response.status)
            const payload = Buffer.from(await response.arrayBuffer())
            const digest = crypto.createHash('sha1').update(payload).digest('hex')
            if (digest !== hash) throw new Error('resourcepack sha1 mismatch')

            const temporary = packPath + '.tmp'
            fs.writeFileSync(temporary, payload)
            fs.renameSync(temporary, packPath)

            const optionsPath = path.join(instanceDir, 'options.txt')
            let options = fs.existsSync(optionsPath) ? fs.readFileSync(optionsPath, 'utf8') : ''
            const packId = 'file/eunwol-giraffe-resourcepack.zip'
            const line = options.split(/\r?\n/).find((value) => value.startsWith('resourcePacks:'))
            if (line == null) {
                options += (options.endsWith('\n') || options.length === 0 ? '' : '\n') + 'resourcePacks:["' + packId + '"]\n'
            } else if (!line.includes(packId)) {
                const match = line.match(/^resourcePacks:(.*)$/)
                let list = []
                try { list = JSON.parse(match ? match[1] : '[]') } catch (_) { list = [] }
                if (!Array.isArray(list)) list = []
                list = list.filter((item) => !String(item).includes('[은월-기린 리소스팩]'))
                list.push(packId)
                options = options.replace(line, 'resourcePacks:' + JSON.stringify(list))
            }
            const incompatibleLine = options.split(/\r?\n/).find((value) => value.startsWith('incompatibleResourcePacks:'))
            if (incompatibleLine == null) {
                options += (options.endsWith('\n') || options.length === 0 ? '' : '\n') + 'incompatibleResourcePacks:["' + packId + '"]\n'
            } else if (!incompatibleLine.includes(packId)) {
                const match = incompatibleLine.match(/^incompatibleResourcePacks:(.*)$/)
                let list = []
                try { list = JSON.parse(match ? match[1] : '[]') } catch (_) { list = [] }
                if (!Array.isArray(list)) list = []
                list = list.filter((item) => !String(item).includes('[은월-기린 리소스팩]'))
                list.push(packId)
                options = options.replace(incompatibleLine, 'incompatibleResourcePacks:' + JSON.stringify(list))
            }
            fs.writeFileSync(optionsPath, options, 'utf8')
            fs.writeFileSync(metaPath, JSON.stringify({ url, hash, size: payload.length }, null, 2) + '\n', 'utf8')
            return { ok: true, built: true, size: payload.length }
        } catch (err) {
            console.error('[backend] giraffe resourcepack build failed:', err.message)
            return { ok: false, error: err.message }
        }
    })

    ipcMain.handle('backend:cleanupSecureMods', async (_event, modsDir) => {
        const legacy = [
            'MozziTrigger-1.3.2+26.2.jar',
            'gfactionbar-3.4.0+26.2.jar',
            'aquaticlog-2.0.0+26.2.jar',
            'eunwol-telemetry.jar',
            'eunwol-minimap-icons-1.0.0+26.2.jar',
            'eunwol-container-summary-1.0.0+26.2.jar',
            'chattingplus-2.0.0+26.2.jar',
            'koreanpatch-1.9.6+26.2.jar'
        ]
        const patterns = [
            /^MozziTrigger-/i, /^gfactionbar-/i, /^aquaticlog-/i, /^eunwol-telemetry/i,
            /^eunwol-minimap-icons-/i, /^eunwol-container-summary-/i, /^chattingplus-/i, /^koreanpatch-/i, /^eunwolcore-/i,
            /^giraffe-clientinfo-/i, /^giraffe-assets-/i, /^emotecraft-/i, /^mcef-modern-/i, /^PlayerAnimationLib/i
        ]
        let removed = 0
        try {
            for (const name of fs.readdirSync(modsDir)) {
                if (!name.endsWith('.jar')) continue
                if (!patterns.some((re) => re.test(name))) continue
                fs.unlinkSync(path.join(modsDir, name))
                removed++
            }
        } catch (err) {
            console.error('[backend] legacy mod cleanup failed:', err.message)
        }
        try {
            const configDir = path.join(path.dirname(modsDir), 'config')
            fs.mkdirSync(configDir, { recursive: true })
            const updaterConfig = path.join(configDir, 'giraffe-updater.json')
            let current = {}
            try { current = JSON.parse(fs.readFileSync(updaterConfig, 'utf8')) } catch (_) { }
            current.enabled = false
            current.manifestUrl = current.manifestUrl || 'http://giraffemc.com:8090/manifest.json'
            fs.writeFileSync(updaterConfig, JSON.stringify(current, null, 2) + '\n', 'utf8')
        } catch (err) {
            console.error('[backend] giraffe updater config failed:', err.message)
        }
        return { ok: true, removed }
    })

    ipcMain.handle('backend:secureMods', async () => {
        try {
            return { ok: true, ...(await ensureSecureMods()) }
        } catch (err) {
            console.error('[backend] secure mods failed:', err.message)
            queueSecurity('secure_mods_unavailable', { reason: err.message })
            await reportSecurity('secure_mods_unavailable', { reason: err.message })
            return { ok: false, error: err.message }
        }
    })

    ipcMain.handle('backend:sendReport', async (_event, payload) => {
        const reportToken = payload && payload.accessToken ? payload.accessToken : state.accessToken
        if (payload != null) delete payload.accessToken
        if (state.sessionToken == null && reportToken != null) {
            try {
                await startSession(reportToken)
            } catch (err) {
                console.error('[backend] session for report failed:', err.message)
            }
        }
        if (state.sessionToken == null) {
            return { ok: false, error: '로그인 세션이 없습니다.' }
        }
        try {
            const result = await request('POST', '/v1/support/report', { token: state.sessionToken, body: payload })
            return { ok: result.http === 200, status: result.http, body: result.body }
        } catch (err) {
            return { ok: false, error: err.message }
        }
    })

    ipcMain.handle('backend:telemetry', async () => ({
        backendUrl: state.baseUrl,
        modToken: state.modToken,
        refreshToken: state.refreshToken
    }))

    ipcMain.handle('backend:sessionEnd', async () => {
        return endSession()
    })

    app.on('before-quit', () => {
        if (state.intentionalQuit) {
            endSession()
        }
    })
}

module.exports = { register, state, markIntentionalQuit }
