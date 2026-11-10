'use strict'

const crypto = require('node:crypto')

function b64url(input) {
    return Buffer.from(input).toString('base64url')
}

/**
 * HS256 JWT 서명
 * @param {object} payload
 * @param {string} secret
 * @param {number} ttlSeconds
 */
function sign(payload, secret, ttlSeconds) {
    const now = Math.floor(Date.now() / 1000)
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }))
    const data = `${header}.${body}`
    const signature = crypto.createHmac('sha256', secret).update(data).digest('base64url')
    return `${data}.${signature}`
}

/**
 * HS256 JWT 검증. 실패 시 null
 * @param {string} token
 * @param {string} secret
 */
function verify(token, secret) {
    if (typeof token !== 'string') return null
    const parts = token.split('.')
    if (parts.length !== 3) return null

    const [header, body, signature] = parts
    const expected = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest()

    let actual
    try {
        actual = Buffer.from(signature, 'base64url')
    } catch (_) {
        return null
    }
    if (actual.length !== expected.length) return null
    if (!crypto.timingSafeEqual(actual, expected)) return null

    let payload
    try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    } catch (_) {
        return null
    }
    if (payload == null) return null
    if (typeof payload.exp !== 'number') return null
    if (payload.exp < Math.floor(Date.now() / 1000)) return null

    return payload
}

module.exports = { sign, verify }
