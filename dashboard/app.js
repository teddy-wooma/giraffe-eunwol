'use strict'

const state = { tab: 'online', me: null }

function $(id) { return document.getElementById(id) }

function toast(message) {
    const el = $('toast')
    el.textContent = message
    el.classList.remove('hidden')
    clearTimeout(toast._timer)
    toast._timer = setTimeout(() => el.classList.add('hidden'), 2600)
}

async function api(path, options = {}) {
    const res = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        ...options
    })
    if (res.status === 401) {
        window.location.href = '/auth/discord'
        throw new Error('unauthorized')
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`)
    }
    return data
}

function fmtTime(iso) {
    if (!iso) return '-'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return new Intl.DateTimeFormat('ko-KR', {
        timeZone: 'Asia/Seoul',
        month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
    }).format(d)
}

function fmtDuration(seconds) {
    const s = Number(seconds || 0)
    if (s <= 0) return '-'
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    if (h > 0) return `${h}시간 ${m}분`
    return `${m}분`
}

function esc(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}

function statusChip(status) {
    const label = status === 'approved' ? '승인' : status === 'pending' ? '대기' : status === 'banned' ? '밴' : status
    return `<span class="chip ${esc(status)}">${esc(label)}</span>`
}

// ---------------------------------------------------------------------
// 데이터 로드
// ---------------------------------------------------------------------

async function loadMe() {
    const data = await api('/api/me')
    state.me = data.user
    $('meName').textContent = data.user.name
}

async function loadOverview() {
    const d = await api('/api/overview')
    $('cOnline').textContent = d.online
    $('cInGame').textContent = d.inGame
    $('cPending').textContent = d.pending
    $('cBanned').textContent = d.banned
    $('cToday').textContent = d.todayUnique
    $('cTotal').textContent = d.totalUsers

    const badge = $('pendingBadge')
    if (d.pending > 0) {
        badge.textContent = d.pending
        badge.classList.remove('hidden')
    } else {
        badge.classList.add('hidden')
    }
}

async function loadOnline() {
    const d = await api('/api/online')
    const body = $('onlineBody')
    $('onlineUpdated').textContent = `갱신 ${fmtTime(new Date().toISOString())}`

    if (!d.online.length) {
        body.innerHTML = '<tr><td colspan="6" class="empty">현재 접속자가 없습니다.</td></tr>'
        return
    }
    body.innerHTML = d.online.map((row) => `
        <tr>
            <td>${esc(row.nickname)}</td>
            <td>${esc(row.server_address || '-')}</td>
            <td class="mono">${esc((row.dimension || '-').replace('minecraft:', ''))}</td>
            <td>${fmtDuration(row.play_seconds)}</td>
            <td>${fmtDuration(row.afk_seconds)}</td>
            <td>${fmtTime(row.joined_at)}</td>
        </tr>`).join('')
}

async function loadPending() {
    const d = await api('/api/pending')
    const body = $('pendingBody')
    if (!d.pending.length) {
        body.innerHTML = '<tr><td colspan="5" class="empty">대기 중인 요청이 없습니다.</td></tr>'
        return
    }
    body.innerHTML = d.pending.map((row) => `
        <tr>
            <td class="mono">${esc(row.id)}</td>
            <td>${esc(row.nickname || '-')}</td>
            <td class="mono">${esc(row.uuid)}</td>
            <td>${fmtTime(row.requested_at)}</td>
            <td>
                <button class="action primary" data-action="decide" data-id="${esc(row.id)}" data-decision="approved">승인</button>
                <button class="action danger" data-action="decide" data-id="${esc(row.id)}" data-decision="denied">거절</button>
                <button class="action" data-action="decide" data-id="${esc(row.id)}" data-decision="held">보류</button>
            </td>
        </tr>`).join('')
}

async function loadBanned() {
    const d = await api('/api/banned')
    const body = $('bannedBody')
    if (!d.banned.length) {
        body.innerHTML = '<tr><td colspan="4" class="empty">밴된 마을원이 없습니다.</td></tr>'
        return
    }
    body.innerHTML = d.banned.map((row) => `
        <tr>
            <td>${esc(row.nickname)}</td>
            <td class="mono">${esc(row.uuid)}</td>
            <td>${esc(row.reason || '-')}</td>
            <td><button class="action" data-action="unban" data-uuid="${esc(row.uuid)}">해제</button></td>
        </tr>`).join('')
}

async function loadUsers(q = '') {
    const d = await api(`/api/users?q=${encodeURIComponent(q)}`)
    const body = $('usersBody')
    if (!d.users.length) {
        body.innerHTML = '<tr><td colspan="6" class="empty">마을원이 없습니다.</td></tr>'
        return
    }
    body.innerHTML = d.users.map((row) => `
        <tr>
            <td>${esc(row.nickname)}</td>
            <td>${statusChip(row.status)}</td>
            <td>${fmtDuration(row.total_play)}</td>
            <td>${row.session_count}</td>
            <td>${fmtTime(row.last_seen_at)}</td>
            <td>
                ${row.status === 'banned'
        ? `<button class="action" data-action="unban" data-uuid="${esc(row.uuid)}">해제</button>`
        : `<button class="action danger" data-action="ban" data-uuid="${esc(row.uuid)}">밴</button>`}
                <button class="action danger" data-action="delete" data-uuid="${esc(row.uuid)}" data-name="${esc(row.nickname)}">삭제</button>
            </td>
        </tr>`).join('')
}

async function loadAudit() {
    const d = await api('/api/audit?limit=200')
    const body = $('auditBody')
    if (!d.audit.length) {
        body.innerHTML = '<tr><td colspan="5" class="empty">로그가 없습니다.</td></tr>'
        return
    }
    body.innerHTML = d.audit.map((row) => `
        <tr>
            <td>${fmtTime(row.created_at)}</td>
            <td>${esc(row.actor || 'system')}</td>
            <td class="mono">${esc(row.action)}</td>
            <td class="mono">${esc(row.target_uuid || '-')}</td>
            <td class="mono">${esc(row.payload_json || '')}</td>
        </tr>`).join('')
}

// ---------------------------------------------------------------------
// 탭 / 액션
// ---------------------------------------------------------------------

function switchTab(tab) {
    state.tab = tab
    document.querySelectorAll('.tab').forEach((el) => {
        el.classList.toggle('active', el.dataset.tab === tab)
    })
    document.querySelectorAll('.panel').forEach((el) => {
        el.classList.toggle('active', el.id === `panel-${tab}`)
    })
    if (tab === 'online') loadOnline().catch(() => {})
    if (tab === 'pending') loadPending().catch(() => {})
    if (tab === 'banned') loadBanned().catch(() => {})
    if (tab === 'users') loadUsers($('userSearch').value).catch(() => {})
    if (tab === 'audit') loadAudit().catch(() => {})
}

async function handleAction(button) {
    const action = button.dataset.action
    try {
        if (action === 'decide') {
            const id = button.dataset.id
            const decision = button.dataset.decision
            const label = decision === 'approved' ? '승인' : decision === 'denied' ? '거절' : '보류'
            if (!confirm(`${id} 요청을 ${label}할까요?`)) return
            let note = null
            if (decision !== 'approved') {
                note = prompt('사유를 입력하세요 (선택)') || null
            }
            await api(`/api/requests/${encodeURIComponent(id)}/decision`, {
                method: 'POST',
                body: JSON.stringify({ decision, note })
            })
            toast(`${label} 처리했습니다.`)
            await loadPending()
            await loadOverview()
            return
        }

        if (action === 'ban') {
            const uuid = button.dataset.uuid
            const reason = prompt('밴 사유를 입력하세요', '마을 규칙 위반')
            if (reason == null) return
            await api(`/api/users/${encodeURIComponent(uuid)}/ban`, {
                method: 'POST',
                body: JSON.stringify({ reason })
            })
            toast('밴 처리했습니다.')
            await loadOverview()
            if (state.tab === 'users') await loadUsers($('userSearch').value)
            if (state.tab === 'banned') await loadBanned()
            return
        }

        if (action === 'delete') {
            const uuid = button.dataset.uuid
            const name = button.dataset.name || uuid
            if (!confirm(`${name} 님을 마을원에서 삭제할까요?\n세션·기록이 함께 삭제되며 되돌릴 수 없습니다.`)) return
            await api(`/api/users/${encodeURIComponent(uuid)}`, { method: 'DELETE' })
            toast('마을원을 삭제했습니다.')
            await loadOverview()
            await loadUsers($('userSearch').value)
            return
        }

        if (action === 'unban') {
            const uuid = button.dataset.uuid
            if (!confirm('밴을 해제할까요?')) return
            await api(`/api/users/${encodeURIComponent(uuid)}/unban`, {
                method: 'POST',
                body: JSON.stringify({})
            })
            toast('밴을 해제했습니다.')
            await loadOverview()
            if (state.tab === 'users') await loadUsers($('userSearch').value)
            if (state.tab === 'banned') await loadBanned()
        }
    } catch (err) {
        toast(`실패: ${err.message}`)
    }
}

document.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab')
    if (tab) {
        switchTab(tab.dataset.tab)
        return
    }
    const action = event.target.closest('button.action')
    if (action) {
        handleAction(action)
    }
})

$('logoutBtn').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' })
    window.location.href = '/'
})

$('auditRefresh').addEventListener('click', () => loadAudit().catch(() => {}))

let searchTimer = null
$('userSearch').addEventListener('input', (event) => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => loadUsers(event.target.value).catch(() => {}), 250)
})

// ---------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------

;(async () => {
    try {
        await loadMe()
        await loadOverview()
        switchTab('online')
    } catch (err) {
        console.error(err)
    }
})()

setInterval(() => {
    loadOverview().catch(() => {})
    if (state.tab === 'online') loadOnline().catch(() => {})
    if (state.tab === 'pending') loadPending().catch(() => {})
}, 15000)
