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

function fmtClock(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return [h, m, sec].map((v) => String(v).padStart(2, '0')).join(':')
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

function exileInfo(lastSeen) {
    if (!lastSeen) return null
    const seen = Date.parse(lastSeen)
    if (Number.isNaN(seen)) return null
    const days = Math.max(0, Math.floor((Date.now() - seen) / 86400000))
    const remaining = Math.max(0, 14 - days)
    const cls = remaining <= 3 ? 'exile-red' : remaining <= 6 ? 'exile-orange' : remaining <= 9 ? 'exile-yellow' : 'exile-white'
    const dot = remaining <= 3 ? '🔴' : remaining <= 6 ? '🟠' : remaining <= 9 ? '🟡' : '⚪'
    return { days, remaining, cls, dot }
}

function exileCell(lastSeen) {
    const info = exileInfo(lastSeen)
    if (info == null) return '<span class="muted">-</span>'
    const label = info.remaining > 0 ? `${info.remaining}일 남음` : '추방 기준 도달'
    return `<span class="${info.cls}">${info.dot} ${label}</span>`
}

function daysSince(iso) {
    if (!iso) return null
    const t = Date.parse(iso)
    if (Number.isNaN(t)) return null
    return Math.max(0, Math.floor((Date.now() - t) / 86400000))
}

function daysChip(iso) {
    const days = daysSince(iso)
    if (days == null) return '<span class="muted">-</span>'
    const cls = days >= 30 ? 'danger' : days >= 14 ? 'warn' : ''
    const label = days === 0 ? '오늘' : `${days}일`
    return `<span class="${cls}">${label}</span>`
}

function statusChip(status) {
    const label = status === 'approved' ? '승인' : status === 'pending' ? '대기' : status === 'banned' ? '밴' : status
    return `<span class="chip ${esc(status)}">${esc(label)}</span>`
}

// ---------------------------------------------------------------------
// 데이터 로드
// ---------------------------------------------------------------------

function avatarUrl(id, hash) {
    if (hash) return `https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=32`
    const index = Number(BigInt(id) >> 22n) % 6
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`
}

function renderAdmins(list) {
    const el = $('adminPresence')
    if (!el) return
    if (!list || list.length === 0) {
        el.innerHTML = ''
        return
    }
    el.innerHTML = list.map((a) => `<img class="presence-avatar" src="${avatarUrl(a.discord_id, a.avatar)}" title="${esc(a.name)}" alt="">`).join('')
        + `<span class="presence-count">관리자 ${list.length}명</span>`
}

async function sendPresence() {
    try {
        const d = await api('/api/presence', { method: 'POST', body: JSON.stringify({}) })
        renderAdmins(d.online)
    } catch (err) {
        console.error('presence 실패', err.message)
    }
}

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
        <tr class="clickable" data-uuid="${esc(row.uuid)}">
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
        body.innerHTML = '<tr><td colspan="8" class="empty">마을원이 없습니다.</td></tr>'
        return
    }
    body.innerHTML = d.users.map((row) => `
        <tr>
            <td><img class="avatar" src="https://mc-heads.net/avatar/${encodeURIComponent(row.nickname)}/32" alt="">${esc(row.nickname)}</td>
            <td>${statusChip(row.status)}</td>
            <td>${daysChip(row.last_seen_at)}</td>
            <td>${exileCell(row.last_seen_at)}</td>
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

async function loadInactivity() {
    const d = await api('/api/inactivity')
    const body = $('inactivityBody')
    if (!d.buckets || !d.buckets.length) {
        body.innerHTML = '<p class="muted">데이터가 없습니다.</p>'
        return
    }
    body.innerHTML = d.buckets.map((b) => `
        <div class="bucket">
            <h3>${b.days}일 이상 미접</h3>
            <div class="count">${b.count}명</div>
            <div class="names">${b.users.length
        ? b.users.slice(0, 20).map((u) => `<span>${esc(u.nickname)} (${u.days}일)</span>`).join('')
        : '<span>없음</span>'}</div>
        </div>`).join('')
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
            <td class="audit-time">${fmtTime(row.created_at)}</td>
            <td class="audit-actor">${esc(row.actor || 'system')}</td>
            <td class="mono audit-action">${esc(row.action)}</td>
            <td class="mono audit-target">${esc(row.target_uuid || '-')}</td>
            <td class="mono audit-payload-cell"><div class="audit-payload">${esc(row.payload_json || '')}</div></td>
        </tr>`).join('')
}

// ---------------------------------------------------------------------
// 탭 / 액션
// ---------------------------------------------------------------------

let drawerUuid = null
let drawerTimer = null
let liveTimer = null

function closeDrawer() {
    drawerUuid = null
    if (drawerTimer != null) {
        clearInterval(drawerTimer)
        drawerTimer = null
    }
    if (liveTimer != null) {
        clearInterval(liveTimer)
        liveTimer = null
    }
    $('drawer').classList.add('hidden')
}

function startLiveTicker(current) {
    if (liveTimer != null) {
        clearInterval(liveTimer)
        liveTimer = null
    }
    if (!current) return

    const base = Number(current.play_seconds || 0)
    const at = Date.parse(current.updated_at || current.joined_at)

    const tick = () => {
        const playEl = $('dPlay')
        const ageEl = $('dDataAge')
        if (playEl == null) return
        const elapsed = Number.isNaN(at) ? 0 : Math.max(0, Math.floor((Date.now() - at) / 1000))
        playEl.textContent = fmtClock(base + elapsed)
        if (ageEl != null) {
            const time = Number.isNaN(at) ? '-' : new Intl.DateTimeFormat('ko-KR', {
                timeZone: 'Asia/Seoul',
                hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
            }).format(new Date(at))
            ageEl.textContent = `${time} (${elapsed}초 전)`
        }
    }
    tick()
    liveTimer = setInterval(tick, 1000)
}

async function loadDetail() {
    if (drawerUuid == null) return
    const d = await api(`/api/users/${encodeURIComponent(drawerUuid)}/detail`)
    const u = d.user
    $('dName').textContent = u.nickname
    $('dMeta').textContent = `${u.uuid} · ${u.status === 'approved' ? '승인' : u.status === 'banned' ? '밴' : '대기'} · 총 플레이 ${fmtDuration(d.totalPlay)}`
    $('dUpdated').textContent = '갱신 ' + new Intl.DateTimeFormat('ko-KR', {
        timeZone: 'Asia/Seoul',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(new Date())

    const parts = []

    if (d.current) {
        const c = d.current
        const pos = c.last_x != null ? `${c.last_x.toFixed(1)}, ${c.last_y.toFixed(1)}, ${c.last_z.toFixed(1)}` : '-'
        parts.push(`
            <section class="d-section">
                <h3><span class="live-dot"></span>현재 세션 (실시간)</h3>
                <div class="d-grid">
                    <span class="k">서버</span><span>${esc(c.server_address || '-')}</span>
                    <span class="k">차원</span><span class="mono">${esc((c.dimension || '-').replace('minecraft:', ''))}</span>
                    <span class="k">좌표</span><span class="mono">${esc(pos)}</span>
                    <span class="k">플레이</span><span id="dPlay">${fmtClock(c.play_seconds)}</span>
                    <span class="k">AFK</span><span>${fmtDuration(c.afk_seconds)}</span>
                    <span class="k">마지막 수신</span><span id="dDataAge" class="mono">-</span>
                    <span class="k">접속 시작</span><span>${fmtTime(c.joined_at)}</span>
                </div>
            </section>`)
    } else {
        parts.push('<section class="d-section"><h3>현재 세션</h3><p class="muted">현재 게임에 접속해 있지 않습니다.</p></section>')
    }

    parts.push(`
        <section class="d-section">
            <h3>최근 게임 세션</h3>
            ${d.sessions.length === 0 ? '<p class="muted">기록이 없습니다.</p>' : d.sessions.map((s) => `
                <div class="d-row">
                    <span>${fmtTime(s.joined_at)} → ${s.left_at ? fmtTime(s.left_at) : '접속 중'}</span>
                    <span class="mono">${fmtDuration(s.play_seconds)} · AFK ${fmtDuration(s.afk_seconds)}</span>
                </div>`).join('')}
        </section>`)

    if (d.skills.length > 0 || d.money.length > 0) {
        parts.push(`
            <section class="d-section">
                <h3>활동 데이터</h3>
                ${d.skills.map((s) => `<div class="d-row"><span>숙련도 · ${esc(s.job)} Lv.${s.level ?? '-'}</span><span class="mono">${fmtTime(s.observed_at)}</span></div>`).join('')}
                ${d.money.map((m) => `<div class="d-row"><span>소지금</span><span class="mono">${Number(m.balance).toLocaleString()} · ${fmtTime(m.observed_at)}</span></div>`).join('')}
            </section>`)
    }

    parts.push(`
        <section class="d-section">
            <h3>런처 세션</h3>
            ${d.launcher.length === 0 ? '<p class="muted">기록이 없습니다.</p>' : d.launcher.map((l) => `
                <div class="d-row">
                    <span>${fmtTime(l.started_at)} → ${l.ended_at ? fmtTime(l.ended_at) : '실행 중'}</span>
                    <span class="mono">${esc(l.launcher_version || '-')} · ${esc(l.ip_masked || '-')}</span>
                </div>`).join('')}
        </section>`)

    if (d.bans.length > 0) {
        parts.push(`
            <section class="d-section">
                <h3>밴 이력</h3>
                ${d.bans.map((b) => `<div class="d-row"><span>${esc(b.reason || '-')}</span><span class="mono">${fmtTime(b.created_at)} · ${b.active ? '활성' : '해제'}</span></div>`).join('')}
            </section>`)
    }

    $('dBody').innerHTML = parts.join('')
    startLiveTicker(d.current || null)
}

async function openUser(uuid) {
    drawerUuid = uuid
    $('drawer').classList.remove('hidden')
    $('dBody').innerHTML = '<p class="muted">불러오는 중…</p>'
    try {
        await loadDetail()
    } catch (err) {
        $('dBody').innerHTML = `<p class="muted">불러오기 실패: ${esc(err.message)}</p>`
    }
    if (drawerTimer != null) clearInterval(drawerTimer)
    drawerTimer = setInterval(() => {
        loadDetail().catch(() => {})
    }, 5000)
}

async function loadBlocked() {
    const d = await api('/api/blocked')
    const body = $('blockedBody')
    if (!d.items || !d.items.length) {
        body.innerHTML = '<tr><td colspan="4" class="empty">차단된 IP가 없습니다.</td></tr>'
        return
    }
    body.innerHTML = d.items.map((row) => `
        <tr>
            <td class="mono">${esc(row.ip)}</td>
            <td>${esc(row.reason || '-')}</td>
            <td>${fmtTime(row.created_at)}</td>
            <td><button class="action" data-action="unblock" data-ip="${esc(row.ip)}">해제</button></td>
        </tr>`).join('')
}

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
    if (tab === 'inactivity') loadInactivity().catch(() => {})
    if (tab === 'users') loadUsers($('userSearch').value).catch(() => {})
    if (tab === 'audit') loadAudit().catch(() => {})
    if (tab === 'blocked') loadBlocked().catch(() => {})
}

async function handleAction(button) {
    const action = button.dataset.action
    try {
        if (action === 'unblock') {
            const ip = button.dataset.ip
            if (!confirm(`${ip} 차단을 해제할까요?`)) return
            await api(`/api/blocked/${encodeURIComponent(ip)}`, { method: 'DELETE' })
            toast('차단을 해제했습니다.')
            await loadBlocked()
            return
        }

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
        return
    }
    const row = event.target.closest('tr.clickable')
    if (row && row.dataset.uuid) {
        openUser(row.dataset.uuid)
    }
})

$('dClose').addEventListener('click', closeDrawer)
$('dRefresh').addEventListener('click', async () => {
    if (drawerUuid == null) return
    try {
        await loadDetail()
        toast('실시간 데이터를 갱신했습니다.')
    } catch (err) {
        toast(`갱신 실패: ${err.message}`)
    }
})
$('onlineRefresh').addEventListener('click', async () => {
    try {
        await loadOnline()
        await loadOverview()
        toast('접속자 목록을 갱신했습니다.')
    } catch (err) {
        toast(`갱신 실패: ${err.message}`)
    }
})
$('drawer').addEventListener('click', (event) => {
    if (event.target.id === 'drawer') closeDrawer()
})
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer()
})

$('logoutBtn').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' })
    window.location.href = '/'
})

$('auditRefresh').addEventListener('click', () => loadAudit().catch(() => {}))
$('inactivityRefresh').addEventListener('click', () => loadInactivity().catch(() => {}))

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
        await sendPresence()
        setInterval(sendPresence, 15000)
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
}, 5000)
