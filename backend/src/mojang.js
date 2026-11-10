'use strict'

const { normalizeUuid } = require('./util')

/**
 * Minecraft 액세스 토큰을 Mojang API 로 검증하고 프로필을 돌려준다.
 * 개발 모드에서는 `dev:<uuid>:<nickname>` 형식을 허용한다.
 *
 * @param {string} token
 * @param {boolean} allowFake
 * @returns {Promise<{uuid: string, name: string}|null>}
 */
async function verifyMinecraftToken(token, allowFake = false) {
    if (typeof token !== 'string' || token.length === 0) {
        return null
    }

    if (allowFake && token.startsWith('dev:')) {
        const [, uuid, name] = token.split(':')
        if (!uuid) return null
        return { uuid: normalizeUuid(uuid), name: name || 'DevUser' }
    }

    try {
        const res = await fetch('https://api.minecraftservices.com/minecraft/profile', {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(8000)
        })
        if (!res.ok) {
            return null
        }
        const profile = await res.json()
        if (profile == null || !profile.id) {
            return null
        }
        return { uuid: normalizeUuid(profile.id), name: profile.name || 'unknown' }
    } catch (err) {
        console.error('[mojang] profile 조회 실패:', err.message)
        return null
    }
}

module.exports = { verifyMinecraftToken }
