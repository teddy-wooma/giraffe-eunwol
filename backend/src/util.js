'use strict'

function nowIso() {
    return new Date().toISOString()
}

function todayCompact() {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '')
}

/** 32자리 UUID 에 하이픈을 넣는다 */
function normalizeUuid(value) {
    const raw = String(value || '').trim().toLowerCase().replace(/-/g, '')
    if (raw.length !== 32) return String(value || '').toLowerCase()
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`
}

/** IPv4/IPv6 마스킹 (저장 정책용) */
function maskIp(ip) {
    if (!ip) return null
    let value = String(ip)
    if (value.startsWith('::ffff:')) value = value.slice(7)
    if (value.includes(':')) {
        const parts = value.split(':')
        return parts.slice(0, 4).join(':') + ':*'
    }
    const parts = value.split('.')
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.*`
    return value
}

/** 프록시 환경을 고려한 클라이언트 IP */
function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for']
    const raw = Array.isArray(forwarded) ? forwarded[0] : (forwarded || '')
    const first = String(raw).split(',')[0].trim()
    if (first) return first
    return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : null
}

/** "1.2.3" >= "1.2.0" */
function versionAtLeast(actual, required) {
    const parse = (v) => String(v || '0').split('-')[0].split('.').map((n) => {
        const parsed = Number.parseInt(n, 10)
        return Number.isFinite(parsed) ? parsed : 0
    })
    const a = parse(actual)
    const b = parse(required)
    const length = Math.max(a.length, b.length)
    for (let i = 0; i < length; i += 1) {
        const av = a[i] || 0
        const bv = b[i] || 0
        if (av > bv) return true
        if (av < bv) return false
    }
    return true
}

function newId() {
    return require('node:crypto').randomUUID()
}

module.exports = {
    nowIso,
    todayCompact,
    normalizeUuid,
    maskIp,
    clientIp,
    versionAtLeast,
    newId
}
