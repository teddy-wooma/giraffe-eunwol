'use strict'

const {
    Client,
    GatewayIntentBits,
    Partials,
    Events,
    ChannelType,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require('discord.js')
const { Backend } = require('./backend')
const store = require('./db')

// -----------------------------------------------------------------------------
// 설정
// -----------------------------------------------------------------------------

const config = {
    token: process.env.DISCORD_TOKEN || '',
    guildId: process.env.GUILD_ID || '',
    forumChannelId: process.env.FORUM_CHANNEL_ID || '',
    adminRoleId: process.env.ADMIN_ROLE_ID || '',
    adminRoleName: process.env.ADMIN_ROLE_NAME || '마을관리',
    backendUrl: process.env.BACKEND_URL || 'http://127.0.0.1:8787',
    adminKey: process.env.ADMIN_API_KEY || '',
    pollMs: Number(process.env.POLL_INTERVAL_MS || 30000),
    dbPath: process.env.BOT_DB_PATH || './data/bot.sqlite',
    reportChannelId: process.env.REPORT_CHANNEL_ID || '',
    reportHourKst: Number(process.env.REPORT_HOUR_KST || 9)
}

if (!config.token || !config.forumChannelId || !config.adminKey) {
    console.error('[bot] DISCORD_TOKEN, FORUM_CHANNEL_ID, ADMIN_API_KEY 가 필요합니다.')
    process.exit(1)
}

const TAGS = {
    pending: '대기',
    approved: '승인',
    denied: '거절',
    held: '보류',
    done: '완료'
}
const TAG_NAMES = Object.values(TAGS)

const backend = new Backend({ baseUrl: config.backendUrl, adminKey: config.adminKey })
const db = store.open(config.dbPath)

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
})

let forumChannel = null
let pollTimer = null
let polling = false

// -----------------------------------------------------------------------------
// 유틸
// -----------------------------------------------------------------------------

function kst(iso) {
    if (!iso) return '-'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return String(iso)
    return new Intl.DateTimeFormat('ko-KR', {
        timeZone: 'Asia/Seoul',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
    }).format(d)
}

function durationText(fromIso, toIso) {
    const from = Date.parse(fromIso)
    const to = Date.parse(toIso)
    if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null
    const minutes = Math.round((to - from) / 60000)
    if (minutes < 60) return `${minutes}분`
    const hours = Math.floor(minutes / 60)
    return `${hours}시간 ${minutes % 60}분`
}

function tagId(name) {
    if (forumChannel == null) return null
    const tag = forumChannel.availableTags.find((t) => t.name === name)
    return tag ? tag.id : null
}

function isAdmin(member) {
    if (member == null) return false
    if (config.adminRoleId && member.roles && member.roles.cache.has(config.adminRoleId)) {
        return true
    }
    return Boolean(member.roles && member.roles.cache.some((role) => role.name === config.adminRoleName))
}

async function ensureTags() {
    const missing = TAG_NAMES.filter((name) => !forumChannel.availableTags.some((t) => t.name === name))
    if (missing.length === 0) return

    const current = forumChannel.availableTags.map((t) => ({ id: t.id, name: t.name, moderated: t.moderated }))
    const next = [...current, ...missing.map((name) => ({ name }))]

    await forumChannel.setAvailableTags(next)
    forumChannel = await client.channels.fetch(config.forumChannelId)
    console.log('[bot] 포럼 태그 생성:', missing.join(', '))
}

function decisionEmbed(record, decision, actor, note) {
    const label = decision === 'approved' ? '승인' : decision === 'denied' ? '거절' : '보류'
    const color = decision === 'approved' ? 0x4caf50 : decision === 'denied' ? 0xe05252 : 0xe0a852
    const embed = new EmbedBuilder()
        .setTitle(`요청 ${record.request_id} · ${label}`)
        .setColor(color)
        .setDescription(
            `신청 ${kst(record.requested_at)} → 처리 ${kst(new Date().toISOString())}` +
            (durationText(record.requested_at, new Date().toISOString()) ? ` (소요 ${durationText(record.requested_at, new Date().toISOString())})` : '')
        )
        .addFields(
            { name: '닉네임', value: record.nickname || '-', inline: true },
            { name: 'UUID', value: record.uuid || '-', inline: false },
            { name: '처리자', value: actor || '관리자', inline: true }
        )
        .setTimestamp(new Date())
    if (note) embed.addFields({ name: '메모', value: note })
    return embed
}

// -----------------------------------------------------------------------------
// 승인 요청 → 포럼 스레드 생성
// -----------------------------------------------------------------------------

async function createThreadForRequest(request) {
    const shortUuid = String(request.uuid || '').slice(0, 8) || 'unknown'
    const embed = new EmbedBuilder()
        .setTitle('마을원 승인 요청')
        .setColor(0x5b8def)
        .setDescription('아래 버튼 또는 이 스레드에 **승인** / **거절 사유** / **보류 사유** 를 남겨주세요.')
        .addFields(
            { name: '닉네임', value: request.nickname || '-', inline: true },
            { name: '요청 ID', value: request.id, inline: true },
            { name: 'UUID', value: request.uuid || '-', inline: false },
            { name: '신청 시각', value: kst(request.requested_at), inline: false }
        )
        .setFooter({ text: '승인 시 다음 실행부터 정상 이용됩니다.' })
        .setTimestamp(new Date())

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`dec|${request.id}|approved`)
            .setLabel('승인')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`dec|${request.id}|denied`)
            .setLabel('거절')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`dec|${request.id}|held`)
            .setLabel('보류')
            .setStyle(ButtonStyle.Secondary)
    )

    const thread = await forumChannel.threads.create({
        name: `[승인] ${request.nickname || '알 수 없음'} (${shortUuid})`,
        message: { embeds: [embed], components: [row] },
        appliedTags: [tagId(TAGS.pending)].filter(Boolean)
    })

    store.save(db, request, thread.id)
    console.log(`[bot] 스레드 생성: ${request.id} → ${thread.id}`)
    return thread
}

async function poll() {
    if (polling) return
    polling = true
    try {
        const pending = await backend.listPending()
        for (const request of pending) {
            if (store.get(db, request.id) != null) continue
            try {
                await createThreadForRequest(request)
            } catch (err) {
                console.error(`[bot] 스레드 생성 실패 ${request.id}:`, err.message)
            }
        }
    } catch (err) {
        console.error('[bot] pending 조회 실패:', err.message)
    } finally {
        polling = false
    }
}

// -----------------------------------------------------------------------------
// 결정 처리
// -----------------------------------------------------------------------------

async function applyDecision(requestId, decision, actor, note) {
    const record = store.get(db, requestId)
    if (record == null) {
        return { ok: false, message: '이 요청은 디스코드 스레드와 연결되어 있지 않습니다.' }
    }
    if (record.status !== 'pending' && record.status !== 'held') {
        return { ok: false, message: '이미 처리된 요청입니다.' }
    }

    const res = await backend.decide(requestId, decision, note, actor)
    if (res.status === 409) {
        store.setStatus(db, requestId, decision)
        return { ok: false, message: '이미 처리된 요청입니다.' }
    }
    if (res.status !== 200) {
        return {
            ok: false,
            message: `처리 실패 (${res.status}) ${res.body && res.body.error ? res.body.error.message : ''}`
        }
    }

    store.setStatus(db, requestId, decision)

    try {
        const thread = await client.channels.fetch(record.thread_id)
        const embed = decisionEmbed(record, decision, actor, note)
        await thread.send({ embeds: [embed] })
        const tag = tagId(TAGS[decision] || TAGS.done)
        if (tag) await thread.setAppliedTags([tag])
        await thread.setLocked(true)
        setTimeout(() => {
            thread.setArchived(true).catch(() => {})
        }, 3000)
    } catch (err) {
        console.error('[bot] 스레드 갱신 실패:', err.message)
    }

    return { ok: true, message: `${decision === 'approved' ? '승인' : decision === 'denied' ? '거절' : '보류'} 처리했습니다.` }
}

async function syncDashboardDecisions() {
    try {
        const res = await backend.request('GET', '/v1/admin/audit?limit=50')
        if (res.status !== 200 || res.body == null) return
        const rows = res.body.audit || []

        for (const row of rows) {
            if (!row.action || !row.action.startsWith('approval_')) continue

            let payload = {}
            try {
                payload = JSON.parse(row.payload_json || '{}')
            } catch (_) {
                payload = {}
            }
            if (payload.source !== 'dashboard' || !payload.requestId) continue

            const record = store.get(db, payload.requestId)
            if (record == null) continue
            if (record.status !== 'pending' && record.status !== 'held') continue

            const decision = row.action.replace('approval_', '')
            const label = decision === 'approved' ? '승인' : decision === 'denied' ? '거절' : '보류'

            try {
                const thread = await client.channels.fetch(record.thread_id)
                await thread.send(
                    `- 대시보드에서 ${label}됨\n처리자: ${row.actor || '알 수 없음'}\n시각: ${kst(row.created_at)}`
                )
                const tag = tagId(TAGS[decision] || TAGS.done)
                if (tag) await thread.setAppliedTags([tag])
                await thread.setLocked(true)
                setTimeout(() => {
                    thread.setArchived(true).catch(() => {})
                }, 3000)
            } catch (err) {
                console.error('[bot] 대시보드 결정 스레드 갱신 실패:', err.message)
            }

            store.setStatus(db, payload.requestId, decision)
            console.log(`[bot] 대시보드 결정 반영: ${payload.requestId} ${decision} by ${row.actor}`)
        }
    } catch (err) {
        console.error('[bot] audit 조회 실패:', err.message)
    }
}

function exileColor(remaining) {
    if (remaining <= 3) return 0xe74c3c
    if (remaining <= 6) return 0xe67e22
    if (remaining <= 9) return 0xf1c40f
    return 0xffffff
}

function exileDot(remaining) {
    if (remaining <= 3) return '🔴'
    if (remaining <= 6) return '🟠'
    if (remaining <= 9) return '🟡'
    return '⚪'
}

async function sendInactivityReport() {
    if (!config.reportChannelId) return
    try {
        const res = await backend.request('GET', '/v1/admin/inactivity')
        if (res.status !== 200 || res.body == null) return

        const data = res.body
        const users = Array.isArray(data.users) ? data.users : []
        if (users.length === 0) {
            console.log('[bot] 미접 인원 없음')
            store.setMeta(db, 'last_report', kstDayKey())
            return
        }

        const embeds = users.slice(0, 40).map((user) => {
            const color = exileColor(user.remaining)

            return new EmbedBuilder()
                .setTitle(user.nickname)
                .setColor(color)
                .setThumbnail(`https://mc-heads.net/avatar/${encodeURIComponent(user.nickname)}/128`)
                .addFields(
                    { name: '닉네임 / UUID', value: `${user.nickname}\n${user.uuid}`, inline: false },
                    { name: '마지막 접속', value: kst(user.last_seen_at), inline: true },
                    { name: '미접', value: `${user.days}일`, inline: true },
                    { name: '추방까지', value: user.remaining > 0 ? `${exileDot(user.remaining)} ${user.remaining}일 남음` : '🔴 추방 기준 도달', inline: true },
                    { name: '숙련도', value: user.skill ? `${user.skill.job} Lv.${user.skill.level}` : '수집 준비 중', inline: true }
                )
                .setFooter({ text: `추방 기준 ${data.exileDays || 14}일` })
        })

        const channel = await client.channels.fetch(config.reportChannelId)
        const isForum = channel.type === ChannelType.GuildForum
        const title = `[미접] ${kstDayKey()} · ${users.length}명`

        let target = channel
        if (isForum) {
            target = await channel.threads.create({
                name: title,
                message: { embeds: embeds.slice(0, 10) }
            })
        } else {
            await channel.send({ embeds: embeds.slice(0, 10) })
        }

        for (let i = 10; i < embeds.length; i += 10) {
            await target.send({ embeds: embeds.slice(i, i + 10) })
        }

        store.setMeta(db, 'last_report', kstDayKey())
        console.log(`[bot] 미접 리포트 전송 (${users.length}명)`)
    } catch (err) {
        console.error('[bot] 미접 리포트 실패:', err.message)
    }
}

function kstDayKey() {
    return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function kstHourMinute() {
    const d = new Date(Date.now() + 9 * 60 * 60 * 1000)
    return { hour: d.getUTCHours(), minute: d.getUTCMinutes() }
}

function scheduleInactivityReport() {
    setInterval(async () => {
        if (!config.reportChannelId) return
        const { hour, minute } = kstHourMinute()
        const key = kstDayKey()
        if (hour === config.reportHourKst && minute < 10 && store.getMeta(db, 'last_report') !== key) {
            await sendInactivityReport()
        }
    }, 60 * 1000)
}

// -----------------------------------------------------------------------------
// 이벤트
// -----------------------------------------------------------------------------

client.once(Events.ClientReady, async (readyClient) => {
    console.log(`[bot] 로그인: ${readyClient.user.tag}`)

    try {
        const channel = await readyClient.channels.fetch(config.forumChannelId)
        if (channel == null || channel.type !== ChannelType.GuildForum) {
            console.error('[bot] FORUM_CHANNEL_ID 가 포럼 채널이 아닙니다.')
            process.exit(1)
        }
        forumChannel = channel
        await ensureTags()
    } catch (err) {
        console.error('[bot] 포럼 채널 초기화 실패:', err.message)
        process.exit(1)
    }

    readyClient.user.setPresence({
        activities: [{ name: '마을 승인 대기', type: 3 }],
        status: 'online'
    })

    await poll()
    pollTimer = setInterval(poll, config.pollMs)

    await syncDashboardDecisions()
    setInterval(syncDashboardDecisions, 15000)

    scheduleInactivityReport()

    // 최초 1회 리포트 전송
    if (config.reportChannelId && store.getMeta(db, 'last_report') === null) {
        await sendInactivityReport()
    }
})

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return
    if (!interaction.customId.startsWith('dec|')) return

    if (!isAdmin(interaction.member)) {
        await interaction.reply({ content: '처리 권한이 없습니다.', flags: MessageFlags.Ephemeral })
        return
    }

    const [, requestId, decision] = interaction.customId.split('|')
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })

    try {
        const result = await applyDecision(requestId, decision, `${interaction.user.tag} (${interaction.user.id})`, null)
        await interaction.editReply(result.message)
    } catch (err) {
        console.error('[bot] 버튼 처리 실패:', err)
        await interaction.editReply('처리 중 오류가 발생했습니다.')
    }
})

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return
    if (!message.channel.isThread()) return
    if (message.channel.parentId !== config.forumChannelId) return
    if (!isAdmin(message.member)) return

    const record = store.getByThread(db, message.channel.id)
    if (record == null) return

    const match = /^(승인|거절|보류)\s*([\s\S]*)$/.exec(message.content.trim())
    if (match == null) return

    const decision = match[1] === '승인' ? 'approved' : match[1] === '거절' ? 'denied' : 'held'
    const note = match[2].trim() || null

    try {
        const result = await applyDecision(record.request_id, decision, `${message.author.tag} (${message.author.id})`, note)
        await message.reply(result.message)
    } catch (err) {
        console.error('[bot] 댓글 처리 실패:', err)
        await message.reply('처리 중 오류가 발생했습니다.')
    }
})

client.on(Events.Error, (err) => {
    console.error('[bot] 클라이언트 오류:', err.message)
})

process.on('SIGINT', () => {
    if (pollTimer) clearInterval(pollTimer)
    client.destroy()
    process.exit(0)
})

client.login(config.token).catch((err) => {
    console.error('[bot] 로그인 실패:', err.message)
    process.exit(1)
})
