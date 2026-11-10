'use strict'

/**
 * 백엔드 스모크 테스트
 * - 승인 대기 → 관리자 승인 → 세션 발급 → 하트비트 → 모드 세션/이벤트
 * - 밴 → 하트비트 차단 → 해제
 *
 * 실행: node test/smoke.cjs
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildServer, loadConfig, open } = require('../src/server')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eunwol-backend-'))
const dbPath = path.join(tmpDir, 'test.sqlite')

const UUID = '8e99e23b-1f94-4dd7-b8f2-5e4481d72f8e'
const UUID_COMPACT = UUID.replace(/-/g, '')
const FAKE_TOKEN = `dev:${UUID_COMPACT}:Tester`
const ADMIN_KEY = 'admin-test-key'

const config = loadConfig({
    DB_PATH: dbPath,
    DEV_ALLOW_FAKE_TOKEN: '1',
    JWT_SECRET: 'test-secret-key',
    ADMIN_API_KEY: ADMIN_KEY,
    MIN_LAUNCHER_VERSION: '1.0.0',
    SERVER_ADDRESS: 'giraffemc.com',
    SERVER_PORT: '25565'
})

const db = open(dbPath)
const server = buildServer({ db, config })

let baseUrl = ''

async function call(method, route, { body, token, admin } = {}) {
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    if (admin) headers.Authorization = `Bearer ${ADMIN_KEY}`
    const res = await fetch(`${baseUrl}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    })
    const json = await res.json()
    return { status: res.status, json }
}

function assertError(result, status, code) {
    assert.equal(result.status, status, JSON.stringify(result.json))
    assert.equal(result.json.error.code, code, JSON.stringify(result.json))
}

async function main() {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`
    console.log(`[test] server ${baseUrl}`)

    // 1) 최초 실행 → 승인 대기
    let res = await call('POST', '/v1/launcher/session/start', {
        body: { minecraftAccessToken: FAKE_TOKEN, launcherVersion: '1.0.0', os: 'win32' }
    })
    assert.equal(res.status, 403, JSON.stringify(res.json))
    assert.equal(res.json.status, 'pending')
    assert.match(res.json.requestId, /^REQ-\d{8}-\d{3}$/)
    const requestId = res.json.requestId
    const pendingToken = res.json.pendingToken
    assert.ok(pendingToken)
    console.log('[test] pending:', requestId)

    // 2) 대기 상태 조회
    res = await call('GET', '/v1/launcher/status', { token: pendingToken })
    assert.equal(res.status, 200)
    assert.equal(res.json.status, 'pending')
    assert.equal(res.json.requestId, requestId)

    // 3) 관리자 대기 목록
    res = await call('GET', '/v1/admin/requests?status=pending', { admin: true })
    assert.equal(res.status, 200)
    assert.ok(res.json.requests.some((r) => r.id === requestId))

    // 4) 관리자 승인
    res = await call('POST', `/v1/admin/requests/${requestId}/decision`, {
        admin: true,
        body: { decision: 'approved', note: '가입 확인' }
    })
    assert.equal(res.status, 200, JSON.stringify(res.json))

    // 5) 상태 확인 → approved
    res = await call('GET', '/v1/launcher/status', { token: pendingToken })
    assert.equal(res.status, 200)
    assert.equal(res.json.status, 'approved')

    // 6) 세션 시작 → 토큰 발급
    res = await call('POST', '/v1/launcher/session/start', {
        body: { minecraftAccessToken: FAKE_TOKEN, launcherVersion: '1.0.0', os: 'win32' }
    })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.equal(res.json.status, 'approved')
    assert.equal(res.json.user.uuid, UUID)
    assert.equal(res.json.server.address, 'giraffemc.com')
    const sessionToken = res.json.sessionToken
    const modToken = res.json.modToken
    assert.ok(sessionToken && modToken)
    console.log('[test] approved session issued')

    // 7) 하트비트
    res = await call('POST', '/v1/launcher/heartbeat', {
        token: sessionToken,
        body: { launcherVersion: '1.0.0', uptimeSeconds: 30 }
    })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.equal(res.json.ok, true)

    // 8) 모드 세션 + 하트비트
    res = await call('POST', '/v1/mod/session/start', {
        token: modToken,
        body: { serverAddress: 'giraffemc.com', dimension: 'minecraft:overworld' }
    })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    const gameSessionId = res.json.sessionId

    res = await call('POST', '/v1/mod/heartbeat', {
        token: modToken,
        body: {
            sessionId: gameSessionId,
            dimension: 'minecraft:overworld',
            position: { x: 120.5, y: 64, z: -330.2 },
            afkSeconds: 0,
            playSeconds: 60
        }
    })
    assert.equal(res.status, 200, JSON.stringify(res.json))

    // 9) 이벤트 배치
    res = await call('POST', '/v1/mod/events', {
        token: modToken,
        body: {
            sessionId: gameSessionId,
            events: [
                { kind: 'skill', job: 'farmer', level: 12, exp: 340.5, source: 'chat' },
                { kind: 'money', balance: 152300, source: 'scoreboard' }
            ]
        }
    })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.equal(res.json.inserted, 2)

    // 10) 모드 세션 종료
    res = await call('POST', '/v1/mod/session/end', {
        token: modToken,
        body: { sessionId: gameSessionId, playSeconds: 120, afkSeconds: 5 }
    })
    assert.equal(res.status, 200, JSON.stringify(res.json))

    // 11) 사용자 조회
    res = await call('GET', `/v1/admin/users/${UUID}`, { admin: true })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.equal(res.json.user.status, 'approved')
    assert.equal(res.json.skills.length, 1)
    assert.equal(res.json.money.length, 1)

    // 12) 현황
    res = await call('GET', '/v1/admin/overview', { admin: true })
    assert.equal(res.status, 200)
    assert.equal(res.json.pendingRequests, 0)

    // 13) 밴 → 하트비트 차단
    res = await call('POST', `/v1/admin/users/${UUID}/ban`, {
        admin: true,
        body: { reason: '테스트 밴' }
    })
    assert.equal(res.status, 200, JSON.stringify(res.json))

    res = await call('POST', '/v1/launcher/heartbeat', { token: sessionToken, body: {} })
    assertError(res, 403, 'BANNED')
    console.log('[test] ban blocks heartbeat')

    // 14) 해제 → 다시 정상
    res = await call('POST', `/v1/admin/users/${UUID}/unban`, { admin: true })
    assert.equal(res.status, 200, JSON.stringify(res.json))

    res = await call('POST', '/v1/launcher/session/start', {
        body: { minecraftAccessToken: FAKE_TOKEN, launcherVersion: '1.0.0' }
    })
    assert.equal(res.status, 200, JSON.stringify(res.json))

    // 15) 구버전 → 426
    res = await call('POST', '/v1/launcher/session/start', {
        body: { minecraftAccessToken: FAKE_TOKEN, launcherVersion: '0.9.0' }
    })
    assertError(res, 426, 'OUTDATED_LAUNCHER')

    // 16) 관리자 키 오류 → 401
    const badAdmin = await fetch(`${baseUrl}/v1/admin/overview`, {
        headers: { Authorization: 'Bearer wrong-key' }
    })
    assert.equal(badAdmin.status, 401)

    // 17) 잘못된 토큰 → 401
    res = await call('POST', '/v1/launcher/session/start', {
        body: { minecraftAccessToken: 'not-a-real-token' }
    })
    assertError(res, 401, 'INVALID_TOKEN')

    console.log('\n[test] ✅ 모든 스모크 테스트 통과')
}

main()
    .catch((err) => {
        console.error('\n[test] ❌ 실패:', err)
        process.exitCode = 1
    })
    .finally(async () => {
        await new Promise((resolve) => server.close(resolve))
        try { db.close() } catch (_) { /* ignore */ }
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })
