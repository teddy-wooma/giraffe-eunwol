'use strict'

/** 백엔드 관리자 API 클라이언트 (봇은 127.0.0.1 로 접근) */
class Backend {
    constructor({ baseUrl, adminKey }) {
        this.baseUrl = baseUrl.replace(/\/+$/, '')
        this.adminKey = adminKey
    }

    headers() {
        return {
            Authorization: `Bearer ${this.adminKey}`,
            'Content-Type': 'application/json'
        }
    }

    async request(method, path, body) {
        const res = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers: this.headers(),
            body: body == null ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(10000)
        })
        let json = null
        try {
            json = await res.json()
        } catch (_) {
            json = null
        }
        return { status: res.status, body: json }
    }

    async listPending() {
        const res = await this.request('GET', '/v1/admin/requests?status=pending&limit=50')
        if (res.status !== 200 || res.body == null) {
            throw new Error(`pending 조회 실패 (${res.status})`)
        }
        return res.body.requests || []
    }

    async decide(requestId, decision, note, actor) {
        return this.request('POST', `/v1/admin/requests/${requestId}/decision`, {
            decision,
            note: note || null,
            actor: actor || 'discord'
        })
    }

    async overview() {
        const res = await this.request('GET', '/v1/admin/overview')
        return res.body
    }
}

module.exports = { Backend }
