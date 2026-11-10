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

const DEFAULT_BASE_URL = 'https://eunwol.duckdns.org'
const HEARTBEAT_INTERVAL_MS = 30 * 1000
const REQUEST_TIMEOUT_MS = 10 * 1000

const state = {
    baseUrl: (process.env.EUNWOL_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    accessToken: null,
    sessionToken: null,
    pendingToken: null,
    requestId: null,
    heartbeatTimer: null
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
            os: process.platform
        }
    })

    const body = result.body || {}

    if (result.http === 200 && body.status === 'approved' && body.sessionToken != null) {
        state.sessionToken = body.sessionToken
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
    return { ok: true }
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

    ipcMain.handle('backend:sessionEnd', async () => {
        return endSession()
    })

    app.on('before-quit', () => {
        endSession()
    })
}

module.exports = { register, state }
