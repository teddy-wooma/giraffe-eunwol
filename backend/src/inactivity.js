'use strict'

/**
 * 미접 사용자 집계
 * - 3일 이상 미접인 승인/대기 사용자
 * - 추방 기준 14일까지 남은 일수 포함
 */
const THRESHOLDS = [3, 5, 7, 10, 14]
const EXILE_DAYS = 14

function computeInactivity(db) {
    const now = Date.now()
    const rows = db.prepare(
        `SELECT uuid, nickname, status, last_seen_at FROM users
         WHERE status != 'banned' AND last_seen_at IS NOT NULL`
    ).all()

    const users = []
    for (const row of rows) {
        const seen = Date.parse(row.last_seen_at)
        if (Number.isNaN(seen)) continue

        const days = Math.floor((now - seen) / 86400000)
        if (days < THRESHOLDS[0]) continue

        const skill = db.prepare(
            'SELECT job, level FROM skill_events WHERE uuid = ? ORDER BY observed_at DESC LIMIT 1'
        ).get(row.uuid) || null

        users.push({
            uuid: row.uuid,
            nickname: row.nickname,
            last_seen_at: row.last_seen_at,
            days,
            remaining: Math.max(0, EXILE_DAYS - days),
            skill: skill ? { job: skill.job, level: skill.level } : null
        })
    }

    users.sort((a, b) => a.remaining - b.remaining)

    return {
        exileDays: EXILE_DAYS,
        users,
        buckets: THRESHOLDS.map((threshold) => ({
            days: threshold,
            count: users.filter((u) => u.days >= threshold).length,
            users: users.filter((u) => u.days >= threshold)
        }))
    }
}

module.exports = { computeInactivity, EXILE_DAYS, THRESHOLDS }
