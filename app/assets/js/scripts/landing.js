
const {
    MojangRestAPI
}                             = require('helios-core/mojang')
const {
    RestResponseStatus,
    validateLocalFile
}                             = require('helios-core/common')
const {
    FullRepair,
    DistributionIndexProcessor,
    MojangIndexProcessor,
    downloadFile
}                             = require('helios-core/dl')
const {
    validateSelectedJvm,
    ensureJavaDirIsRoot,
    javaExecFromRoot,
    discoverBestJvmInstallation,
    latestOpenJDK,
    extractJdk
}                             = require('helios-core/java')


const DiscordWrapper          = require('./assets/js/discordwrapper')
const ProcessBuilder          = require('./assets/js/processbuilder')


const launch_content          = document.getElementById('launch_content')
const launch_details          = document.getElementById('launch_details')
const launch_progress         = document.getElementById('launch_progress')
const launch_progress_label   = document.getElementById('launch_progress_label')
const launch_details_text     = document.getElementById('launch_details_text')
const server_selection_button = document.getElementById('server_selection_button')
const user_text               = document.getElementById('user_text')

const loggerLanding = LoggerUtil.getLogger('Landing')


function toggleLaunchArea(loading){
    if(loading){
        launch_details.style.display = 'flex'
        launch_content.style.display = 'none'
    } else {
        launch_details.style.display = 'none'
        launch_content.style.display = 'inline-flex'
    }
}


// ===== 진단 로그 (플레이 버튼부터의 전 과정) =====
// main 프로세스로 보내 <userData>/logs/launcher.log 에 기록합니다.
function logLaunch(scope, message){
    try {
        require('electron').ipcRenderer.send('launcherLog', scope, message)
    } catch(err) {
        // 로그를 못 남겨도 실행을 막지 않습니다.
    }
}


function logLaunchSection(title){
    logLaunch('----', '')
    logLaunch('----', '========== ' + title + ' ==========')
}


function setLaunchDetails(details){
    logLaunch('STEP', details)
    launch_details_text.innerHTML = details
}


function setLaunchPercentage(percent){
    const rounded = Math.round(percent)
    if(rounded === 0 || rounded === 100 || rounded % 25 === 0){
        logLaunch('PROGRESS', rounded + '%')
    }
    launch_progress.setAttribute('max', 100)
    launch_progress.setAttribute('value', percent)
    launch_progress_label.innerHTML = percent + '%'
}


function setDownloadPercentage(percent){
    remote.getCurrentWindow().setProgressBar(percent/100)
    setLaunchPercentage(percent)
}


function setLaunchEnabled(val){
    document.getElementById('launch_button').disabled = !val
}



document.querySelectorAll('.dualSlot').forEach(btn => {
    btn.addEventListener('click', () => startSlot(btn.dataset.slot))
})
const dualBusyOk = document.getElementById('dualBusyOk')
if(dualBusyOk != null){
    dualBusyOk.addEventListener('click', () => {
        const modal = document.getElementById('dualBusyModal')
        if(modal != null) modal.classList.remove('open')
    })
}
const dualCancelBtn = document.getElementById('dualCancel')
if(dualCancelBtn != null) dualCancelBtn.addEventListener('click', closeDualModal)
const dualConfirmBtn = document.getElementById('dualConfirm')
if(dualConfirmBtn != null){
    dualConfirmBtn.addEventListener('click', () => {
        if(dualPending == null || dualPending.account == null) return
        ConfigManager.setDualSlot(dualPending.slot, dualPending.account)
        ConfigManager.save()
        closeDualModal()
        renderDualSlots()
    })
}
document.getElementById('launch_button').addEventListener('click', async e => {
    loggerLanding.info('Launching game..')

    logLaunchSection('플레이 버튼 클릭')
    logLaunch('PLAY', '선택된 프로필 : ' + ConfigManager.getSelectedServer())
    logLaunch('PLAY', '저장된 Java 경로 : ' + ConfigManager.getJavaExecutable(ConfigManager.getSelectedServer()))
    logLaunch('PLAY', '게임 폴더 : ' + ConfigManager.getInstanceDirectory())
    logLaunch('PLAY', '데이터 폴더 : ' + ConfigManager.getDataDirectory())
    try {
        const server = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())
        const jExe = ConfigManager.getJavaExecutable(ConfigManager.getSelectedServer())
        if(jExe == null){
            await asyncSystemScan(server.effectiveJavaOptions)
        } else {

            setLaunchDetails(Lang.queryJS('landing.launch.pleaseWait'))
            toggleLaunchArea(true)
            setLaunchPercentage(0, 100)

            const details = await validateSelectedJvm(ensureJavaDirIsRoot(jExe), server.effectiveJavaOptions.supported)
            if(details != null){
                loggerLanding.info('Jvm Details', details)
                await dlAsync()

            } else {
                await asyncSystemScan(server.effectiveJavaOptions)
            }
        }
    } catch(err) {
        loggerLanding.error('Unhandled error in during launch process.', err)
        showLaunchFailure(Lang.queryJS('landing.launch.failureTitle'), Lang.queryJS('landing.launch.failureText'))
    }
})


document.getElementById('settingsMediaButton').onclick = async e => {
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings)
}


document.getElementById('avatarOverlay').onclick = async e => {
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
        settingsNavItemListener(document.getElementById('settingsNavAccount'), false)
    })
}



// ---------------------------------------------------------------------------
// 듀얼 계정 슬롯 (본계정 / 부계정)
// ---------------------------------------------------------------------------

const slotRuntime = {
    main: { booting: false, running: false, startedAt: 0, timer: null, launchStarted: false },
    alt: { booting: false, running: false, startedAt: 0, timer: null, launchStarted: false }
}
let bootingSlot = null

function pad2(n){ return String(n).padStart(2, '0') }

function formatElapsed(ms){
    const total = Math.floor(ms / 1000)
    const d = Math.floor(total / 86400)
    const h = Math.floor((total % 86400) / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    return `${d}:${pad2(h)}:${pad2(m)}:${pad2(s)}`
}

function startSlotTimer(slot){
    stopSlotTimer(slot)
    const rt = slotRuntime[slot]
    const tick = () => {
        const el = document.getElementById(slot === 'main' ? 'dualTimerMain' : 'dualTimerAlt')
        if(el != null && rt.running) el.textContent = formatElapsed(Date.now() - rt.startedAt)
    }
    rt.timer = setInterval(tick, 1000)
    tick()
}

function stopSlotTimer(slot){
    const rt = slotRuntime[slot]
    if(rt.timer != null){ clearInterval(rt.timer); rt.timer = null }
}

function resetSlotRuntime(slot){
    const rt = slotRuntime[slot]
    if(rt == null) return
    stopSlotTimer(slot)
    rt.booting = false
    rt.running = false
    rt.startedAt = 0
    rt.launchStarted = false
    if(bootingSlot === slot) bootingSlot = null
    const timerEl = document.getElementById(slot === 'main' ? 'dualTimerMain' : 'dualTimerAlt')
    if(timerEl != null) timerEl.textContent = ''
}

function showBusyWarning(message){
    const modal = document.getElementById('dualBusyModal')
    const text = document.getElementById('dualBusyText')
    if(modal == null || text == null){ return }
    text.textContent = message
    modal.classList.add('open')
}

let dualPending = null

function dualAccountFor(slot){
    const info = ConfigManager.getDualSlots()[slot]
    if(info == null) return null
    return ConfigManager.getAuthAccounts()[info.uuid] || null
}

function renderDualSlots(){
    const area = document.getElementById('dualSlotArea')
    const single = document.getElementById('singleLaunchArea')
    if(area == null || single == null) return
    const accounts = Object.values(ConfigManager.getAuthAccounts() || {})
    const dual = accounts.length >= 2
    area.classList.toggle('active', dual)
    single.style.display = dual ? 'none' : ''
    const serverBtn = document.getElementById('server_selection_button')
    if(serverBtn != null) serverBtn.style.display = dual ? 'none' : ''
    if(!dual) return
    for(const slot of ['main', 'alt']){
        const nameEl = document.getElementById(slot === 'main' ? 'dualNameMain' : 'dualNameAlt')
        const acc = dualAccountFor(slot)
        nameEl.textContent = acc != null ? acc.displayName : '계정 선택'
        const btn = document.querySelector(`.dualSlot[data-slot="${slot}"]`)
        if(btn != null) btn.classList.toggle('unbound', acc == null)

        const rt = slotRuntime[slot]
        const playEl = document.getElementById(slot === 'main' ? 'dualPlayMain' : 'dualPlayAlt')
        const timerEl = document.getElementById(slot === 'main' ? 'dualTimerMain' : 'dualTimerAlt')
        if(playEl != null){
            playEl.textContent = rt.running ? '실행중' : (rt.booting ? '부팅 중...' : 'PLAY')
        }
        if(timerEl != null && !rt.running) timerEl.textContent = ''
    }
}

function closeDualModal(){
    const modal = document.getElementById('dualSlotModal')
    if(modal != null) modal.classList.remove('open')
    dualPending = null
}

function openDualModal(slot){
    const modal = document.getElementById('dualSlotModal')
    const list = document.getElementById('dualAccountList')
    const warning = document.getElementById('dualWarning')
    const confirm = document.getElementById('dualConfirm')
    const title = document.getElementById('dualModalTitle')
    if(modal == null || list == null) return

    const other = slot === 'main' ? 'alt' : 'main'
    const otherInfo = ConfigManager.getDualSlots()[other]
    const accounts = Object.values(ConfigManager.getAuthAccounts() || {})
        .filter(a => otherInfo == null || a.uuid !== otherInfo.uuid)

    if(accounts.length === 0){
        alert('귀속할 수 있는 계정이 없습니다. 먼저 계정을 추가해 주세요.')
        return
    }

    dualPending = { slot, account: null }
    title.textContent = slot === 'main' ? '본계정 선택' : '부계정 선택'
    warning.classList.remove('show')
    warning.textContent = ''
    confirm.disabled = true

    list.innerHTML = ''
    for(const acc of accounts){
        const row = document.createElement('button')
        row.className = 'dualAccountRow'
        row.innerHTML = `<span class="accName">${acc.displayName || acc.username}</span><span class="accUuid">${acc.uuid}</span>`
        row.onclick = () => {
            dualPending.account = acc
            list.querySelectorAll('.dualAccountRow').forEach(el => el.classList.remove('selected'))
            row.classList.add('selected')
            const role = slot === 'main' ? '본계정' : '부계정'
            warning.textContent = `⚠️ 이 버튼은 ${role} [${acc.displayName}] 계정에 영구 귀속됩니다. 인스턴스 폴더가 분리되며, 런처를 재설치하기 전까지 계정을 변경할 수 없습니다.`
            warning.classList.add('show')
            confirm.disabled = false
        }
        list.appendChild(row)
    }

    modal.classList.add('open')
}

async function startSlot(slot){
    const acc = dualAccountFor(slot)
    if(acc == null){
        openDualModal(slot)
        return
    }
    const rt = slotRuntime[slot]
    if(rt.running){
        showBusyWarning('이미 실행 중인 클라이언트입니다.')
        return
    }
    if(rt.booting){
        showBusyWarning('이미 부팅 중인 클라이언트입니다.')
        return
    }
    if(bootingSlot != null){
        showBusyWarning('다른 클라이언트가 부팅 중입니다. 해당 클라이언트가 완전히 켜진 뒤에 실행해 주세요.')
        return
    }
    // 본계/부계 각각의 만료된 Microsoft 토큰을 갱신한다.
    // 실패 시 다른 계정 토큰으로 대체하지 않고 실행을 중단한다.
    if(acc.type === 'microsoft'){
        const valid = await require('./assets/js/authmanager').validateAccount(acc.uuid)
        if(!valid){
            showLaunchFailure('계정 로그인 만료', '선택한 계정의 로그인을 갱신하지 못했습니다. 런처에서 다시 로그인해 주세요.')
            return
        }
    }
    rt.booting = true
    bootingSlot = slot
    renderDualSlots()
    try {
        const server = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())
        const jExe = ConfigManager.getJavaExecutable(ConfigManager.getSelectedServer())
        if(jExe == null){
            await asyncSystemScan(server.effectiveJavaOptions)
            return
        }
        setLaunchDetails(Lang.queryJS('landing.launch.pleaseWait'))
        toggleLaunchArea(true)
        setLaunchPercentage(0, 100)
        const details = await validateSelectedJvm(ensureJavaDirIsRoot(jExe), server.effectiveJavaOptions.supported)
        if(details != null){
            await dlAsync(true, slot)
            if(slotRuntime[slot].booting && !slotRuntime[slot].launchStarted){
                resetSlotRuntime(slot)
                renderDualSlots()
            }
        } else {
            await asyncSystemScan(server.effectiveJavaOptions)
            resetSlotRuntime(slot)
            renderDualSlots()
        }
    } catch(err) {
        loggerLanding.error('Unhandled error in dual slot launch.', err)
        resetSlotRuntime(slot)
        renderDualSlots()
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), err.message || String(err))
    }
}

function updateSelectedAccount(authUser){
    let username = Lang.queryJS('landing.selectedAccount.noAccountSelected')
    if(authUser != null){
        if(authUser.displayName != null){
            username = authUser.displayName
        }
        if(authUser.uuid != null){
            // 스킨 이미지는 외부 서비스라서, 하나씩 차례로 시도합니다.
            // CSS 배경은 onerror 를 받을 수 없어 미리 불러와 확인합니다.
            const avatarContainer = document.getElementById('avatarContainer')
            const urls = skinServiceUrls('body', authUser.uuid, 128)
            const tryNextService = (index) => {
                if(index >= urls.length){
                    return
                }
                const probe = new Image()
                probe.onload = () => {
                    avatarContainer.style.backgroundImage = `url('${urls[index]}')`
                }
                probe.onerror = () => tryNextService(index + 1)
                probe.src = urls[index]
            }
            tryNextService(0)
        }
    }
    user_text.innerHTML = username
    renderDualSlots()
}
updateSelectedAccount(ConfigManager.getSelectedAccount())


function updateSelectedServer(serv){
    if(getCurrentView() === VIEWS.settings){
        fullSettingsSave()
    }
    ConfigManager.setSelectedServer(serv != null ? serv.rawServer.id : null)
    ConfigManager.save()
    server_selection_button.innerHTML = '&#8226; ' + (serv != null ? serv.rawServer.name : Lang.queryJS('landing.selectedServer.noSelection'))
    if(getCurrentView() === VIEWS.settings){
        animateSettingsTabRefresh()
    }
    setLaunchEnabled(serv != null)
}

server_selection_button.innerHTML = '&#8226; ' + Lang.queryJS('landing.selectedServer.loading')
server_selection_button.onclick = async e => {
    e.target.blur()
    await toggleServerSelection(true)
}


const refreshMojangStatuses = async function(){
    loggerLanding.info('Refreshing Mojang Statuses..')

    let status = 'grey'
    let tooltipEssentialHTML = ''
    let tooltipNonEssentialHTML = ''

    const response = await MojangRestAPI.status()
    let statuses
    if(response.responseStatus === RestResponseStatus.SUCCESS) {
        statuses = response.data
    } else {
        loggerLanding.warn('Unable to refresh Mojang service status.')
        statuses = MojangRestAPI.getDefaultStatuses()
    }

    greenCount = 0
    greyCount = 0

    for(let i=0; i<statuses.length; i++){
        const service = statuses[i]

        const tooltipHTML = `<div class="mojangStatusContainer">
            <span class="mojangStatusIcon" style="color: ${MojangRestAPI.statusToHex(service.status)};">&#8226;</span>
            <span class="mojangStatusName">${service.name}</span>
        </div>`
        if(service.essential){
            tooltipEssentialHTML += tooltipHTML
        } else {
            tooltipNonEssentialHTML += tooltipHTML
        }

        if(service.status === 'yellow' && status !== 'red'){
            status = 'yellow'
        } else if(service.status === 'red'){
            status = 'red'
        } else {
            if(service.status === 'grey'){
                ++greyCount
            }
            ++greenCount
        }

    }

    if(greenCount === statuses.length){
        if(greyCount === statuses.length){
            status = 'grey'
        } else {
            status = 'green'
        }
    }

    document.getElementById('mojangStatusEssentialContainer').innerHTML = tooltipEssentialHTML
    document.getElementById('mojangStatusNonEssentialContainer').innerHTML = tooltipNonEssentialHTML
    document.getElementById('mojang_status_icon').style.color = MojangRestAPI.statusToHex(status)
}

refreshMojangStatuses()


let mojangStatusListener = setInterval(() => refreshMojangStatuses(true), 60*60*1000)


function showLaunchFailure(title, desc){
    logLaunchSection('실행 실패 — 화면에 표시된 내용')
    logLaunch('FAIL', '제목 : ' + title)
    logLaunch('FAIL', '내용 : ' + desc)
    setOverlayContent(
        title,
        desc,
        Lang.queryJS('landing.launch.okay')
    )
    setOverlayHandler(null)
    toggleOverlay(true)
    toggleLaunchArea(false)
}


async function asyncSystemScan(effectiveJavaOptions, launchAfter = true){

    setLaunchDetails(Lang.queryJS('landing.systemScan.checking'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    const jvmDetails = await discoverBestJvmInstallation(
        ConfigManager.getDataDirectory(),
        effectiveJavaOptions.supported
    )

    if(jvmDetails == null) {


        setOverlayContent(
            Lang.queryJS('landing.systemScan.noCompatibleJava'),
            Lang.queryJS('landing.systemScan.installJavaMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
            Lang.queryJS('landing.systemScan.installJava'),
            Lang.queryJS('landing.systemScan.installJavaManually')
        )
        setOverlayHandler(() => {
            setLaunchDetails(Lang.queryJS('landing.systemScan.javaDownloadPrepare'))
            toggleOverlay(false)

            try {
                downloadJava(effectiveJavaOptions, launchAfter)
            } catch(err) {
                loggerLanding.error('Unhandled error in Java Download', err)
                showLaunchFailure(Lang.queryJS('landing.systemScan.javaDownloadFailureTitle'), Lang.queryJS('landing.systemScan.javaDownloadFailureText'))
            }
        })
        setDismissHandler(() => {
            $('#overlayContent').fadeOut(250, () => {

                setOverlayContent(
                    Lang.queryJS('landing.systemScan.javaRequired', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredDismiss'),
                    Lang.queryJS('landing.systemScan.javaRequiredCancel')
                )
                setOverlayHandler(() => {
                    toggleLaunchArea(false)
                    toggleOverlay(false)
                })
                setDismissHandler(() => {
                    toggleOverlay(false, true)

                    asyncSystemScan(effectiveJavaOptions, launchAfter)
                })
                $('#overlayContent').fadeIn(250)
            })
        })
        toggleOverlay(true, true)
    } else {

        const javaExec = javaExecFromRoot(jvmDetails.path)
        ConfigManager.setJavaExecutable(ConfigManager.getSelectedServer(), javaExec)
        ConfigManager.save()


        settingsJavaExecVal.value = javaExec
        await populateJavaExecDetails(settingsJavaExecVal.value)


        if(launchAfter){
            await dlAsync()
        }
    }

}

async function downloadJava(effectiveJavaOptions, launchAfter = true) {


    const asset = await latestOpenJDK(
        effectiveJavaOptions.suggestedMajor,
        ConfigManager.getDataDirectory(),
        effectiveJavaOptions.distribution)

    if(asset == null) {
        throw new Error(Lang.queryJS('landing.downloadJava.findJdkFailure'))
    }

    let received = 0
    await downloadFile(asset.url, asset.path, ({ transferred }) => {
        received = transferred
        setDownloadPercentage(Math.trunc((transferred/asset.size)*100))
    })
    setDownloadPercentage(100)

    if(received != asset.size) {
        loggerLanding.warn(`Java Download: Expected ${asset.size} bytes but received ${received}`)
        if(!await validateLocalFile(asset.path, asset.algo, asset.hash)) {
            log.error(`Hashes do not match, ${asset.id} may be corrupted.`)

            throw new Error(Lang.queryJS('landing.downloadJava.javaDownloadCorruptedError'))
        }
    }


    remote.getCurrentWindow().setProgressBar(2)


    const eLStr = Lang.queryJS('landing.downloadJava.extractingJava')
    let dotStr = ''
    setLaunchDetails(eLStr)
    const extractListener = setInterval(() => {
        if(dotStr.length >= 3){
            dotStr = ''
        } else {
            dotStr += '.'
        }
        setLaunchDetails(eLStr + dotStr)
    }, 750)

    const newJavaExec = await extractJdk(asset.path)


    remote.getCurrentWindow().setProgressBar(-1)


    ConfigManager.setJavaExecutable(ConfigManager.getSelectedServer(), newJavaExec)
    ConfigManager.save()

    clearInterval(extractListener)
    setLaunchDetails(Lang.queryJS('landing.downloadJava.javaInstalled'))


    asyncSystemScan(effectiveJavaOptions, launchAfter)

}


let proc

let hasRPC = false


const GAME_JOINED_REGEX = /\[.+\]: Sound engine started/
const GAME_LAUNCH_REGEX = /^\[.+\]: (?:MinecraftForge .+ Initialized|ModLauncher .+ starting: .+|Loading Minecraft .+ with Fabric Loader .+)$/
const MIN_LINGER = 5000


async function writeTelemetryConfig(instanceDir = null) {
    try {
        const fs = require('fs-extra')
        const path = require('path')
        const electronIpc = require('electron').ipcRenderer
        const info = await electronIpc.invoke('backend:telemetry')
        if (info == null || !info.modToken) {
            return
        }
        const configDir = path.join(instanceDir || ConfigManager.getInstanceDirectory(), ConfigManager.getSelectedServer(), 'config')
        await fs.ensureDir(configDir)
        await fs.writeJson(path.join(configDir, 'eunwol-telemetry.json'), {
            backendUrl: info.backendUrl,
            token: info.modToken,
            enabled: true
        }, { spaces: 2 })
        loggerLanding.info('Telemetry config written.')
    } catch (err) {
        loggerLanding.warn('Telemetry config write failed:', err.message)
    }
}

function installOptionalMods(instanceDir) {
    try {
        const fs = require('fs')
        const path = require('path')
        const { app } = require('electron')
        const sourceDir = app != null && app.isPackaged
            ? path.join(process.resourcesPath, 'optional-mods')
            : path.join(__dirname, '..', '..', '..', '..', 'optional-mods')
        if (!fs.existsSync(sourceDir)) return
        const targetDir = path.join(instanceDir, 'mods')
        fs.mkdirSync(targetDir, { recursive: true })
        for (const name of fs.readdirSync(sourceDir)) {
            if (!name.endsWith('.jar')) continue
            const enabled = path.join(targetDir, name)
            const disabled = enabled + '.disabled'
            if (fs.existsSync(enabled) || fs.existsSync(disabled)) continue
            fs.copyFileSync(path.join(sourceDir, name), disabled)
            loggerLanding.info('[optional] installed disabled: ' + name)
        }
    } catch (err) {
        loggerLanding.warn('[optional] install failed: ' + err.message)
    }
}

function enforceKeybinds(instanceDir) {
    try {
        const fs = require('fs')
        const path = require('path')
        const file = path.join(instanceDir, 'options.txt')
        if (!fs.existsSync(file)) return
        const targets = new Set([
            'key_key.chat',
            'key_iris.keybind.reload',
            'key_gui.xaero_minimap_settings'
        ])
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
        let changed = false
        const out = lines.map((line) => {
            const idx = line.indexOf(':')
            if (idx < 0) return line
            const key = line.slice(0, idx)
            if (!targets.has(key)) return line
            const next = key + ':key.keyboard.unknown'
            if (next !== line) changed = true
            return next
        })
        if (changed) fs.writeFileSync(file, out.join('\n'), 'utf8')
    } catch (_) { /* ignore */ }
}

async function ensureLatestLauncher(notify) {
    try {
        const info = await require('electron').ipcRenderer.invoke('launcher:checkVersion')
        if (info == null || info.ok !== true || info.outdated !== true) {
            return true
        }
        if (notify) {
            await require('electron').ipcRenderer.invoke('launcher:showOutdated', info)
        }
        require('electron').ipcRenderer.send('autoUpdateAction', 'initAutoUpdater', true)
        require('electron').ipcRenderer.send('autoUpdateAction', 'checkForUpdate')
        showLandingUpdateNotice({ version: info.latest }, false)
        return false
    } catch (_) {
        return true
    }
}

async function dlAsync(login = true, slot = null) {
    if (!(await ensureLatestLauncher(true))) {
        return
    }
    logLaunchSection('게임 실행 준비 시작')


    const loggerLaunchSuite = LoggerUtil.getLogger('LaunchSuite')

    setLaunchDetails(Lang.queryJS('landing.dlAsync.loadingServerInfo'))

    let distro

    try {
        distro = await DistroAPI.refreshDistributionOrFallback()
        onDistroRefresh(distro)
    } catch(err) {
        loggerLaunchSuite.error('Unable to refresh distribution index.', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.fatalError'), Lang.queryJS('landing.dlAsync.unableToLoadDistributionIndex'))
        return
    }

    const serv = distro.getServerById(ConfigManager.getSelectedServer())
    const slotInfo = slot != null ? ConfigManager.getDualSlots()[slot] : null
    const authUser = slot != null
        ? (slotInfo != null ? (ConfigManager.getAuthAccounts()[slotInfo.uuid] || null) : null)
        : ConfigManager.getSelectedAccount()
    const instanceDir = slot != null ? ConfigManager.getInstanceDirectoryForSlot(slot) : ConfigManager.getInstanceDirectoryForSlot('main')
    installOptionalMods(instanceDir)
    enforceKeybinds(instanceDir)
    const instanceBase = slot != null ? ConfigManager.getInstanceBaseForSlot(slot) : ConfigManager.getInstanceDirectory()

    if(login) {
        if(authUser == null){
            loggerLanding.error('You must be logged into an account.')
            return
        }
    }

    // 마을 승인 게이트: 승인되지 않은 계정은 게임을 실행할 수 없습니다.
    if(login) {
        const approved = await Gate.ensureApproved(authUser)
        if(!approved) {
            setLaunchDetails('')
            toggleLaunchArea(false)
            return
        }
    }

    await writeTelemetryConfig(instanceBase)

    setLaunchDetails(Lang.queryJS('landing.dlAsync.pleaseWait'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    const fullRepairModule = new FullRepair(
        ConfigManager.getCommonDirectory(),
        instanceBase,
        ConfigManager.getLauncherDirectory(),
        ConfigManager.getSelectedServer(),
        DistroAPI.isDevMode()
    )

    fullRepairModule.spawnReceiver()

    fullRepairModule.childProcess.on('error', (err) => {
        loggerLaunchSuite.error('Error during launch', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), err.message || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
    })
    fullRepairModule.childProcess.on('close', (code, _signal) => {
        if(code !== 0){
            loggerLaunchSuite.error(`Full Repair Module exited with code ${code}, assuming error.`)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
        }
    })

    loggerLaunchSuite.info('Validating files.')
    setLaunchDetails(Lang.queryJS('landing.dlAsync.validatingFileIntegrity'))
    let invalidFileCount = 0
    try {
        invalidFileCount = await fullRepairModule.verifyFiles(percent => {
            setLaunchPercentage(percent)
        })
        setLaunchPercentage(100)
    } catch (err) {

        const detail = (err && (err.displayable || err.message)) || String(err)
        loggerLaunchSuite.error(`Error during file validation: ${detail}`, err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileVerificationTitle'), detail)
        return
    }


    if(invalidFileCount > 0) {
        loggerLaunchSuite.info('Downloading files.')
        setLaunchDetails(Lang.queryJS('landing.dlAsync.downloadingFiles'))
        setLaunchPercentage(0)
        try {
            await fullRepairModule.download(percent => {
                setDownloadPercentage(percent)
            })
            setDownloadPercentage(100)
        } catch(err) {
            const detail = (err && (err.displayable || err.message)) || String(err)
            loggerLaunchSuite.error(`Error during file download: ${detail}`, err)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileDownloadTitle'), detail)
            return
        }
    } else {
        loggerLaunchSuite.info('No invalid files, skipping download.')
    }


    remote.getCurrentWindow().setProgressBar(-1)

    fullRepairModule.destroyReceiver()

    setLaunchDetails(Lang.queryJS('landing.dlAsync.preparingToLaunch'))

    const mojangIndexProcessor = new MojangIndexProcessor(
        ConfigManager.getCommonDirectory(),
        serv.rawServer.minecraftVersion)
    const distributionIndexProcessor = new DistributionIndexProcessor(
        ConfigManager.getCommonDirectory(),
        distro,
        serv.rawServer.id
    )

    const modLoaderData = await distributionIndexProcessor.loadModLoaderVersionJson(serv)
    const versionData = await mojangIndexProcessor.getVersionJson()

    if(login) {
        loggerLaunchSuite.info(`Sending selected account (${authUser.displayName}) to ProcessBuilder.`)
        try {
            await require('electron').ipcRenderer.invoke('backend:cleanupSecureMods', require('path').join(instanceDir, 'mods'))
        } catch (_) { /* ignore */ }
        let secureMods = null
        try {
            secureMods = await require('electron').ipcRenderer.invoke('backend:secureMods')
        } catch (_) {
            secureMods = { ok: false, error: '보안 모드 초기화 실패' }
        }
        if (secureMods == null || secureMods.ok !== true) {
            showLaunchFailure('보안 모드 로드 실패', (secureMods && secureMods.error) || '보안 모드를 불러오지 못했습니다.')
            return
        }
        try {
            await require('electron').ipcRenderer.invoke('backend:buildGiraffePack', instanceDir)
        } catch (_) { /* ignore */ }
        let telemetryInfo = null
        try {
            telemetryInfo = await require('electron').ipcRenderer.invoke('backend:telemetry')
        } catch (_) { /* ignore */ }
        let slotModToken = null
        let slotRefreshToken = null
        if (slot == null) {
            slotModToken = telemetryInfo != null ? telemetryInfo.modToken : null
            slotRefreshToken = telemetryInfo != null ? telemetryInfo.refreshToken : null
        } else {
            const slotAccount = dualAccountFor(slot)
            if (slotAccount == null || slotAccount.accessToken == null) {
                showLaunchFailure('계정 세션 실패', '슬롯 계정의 로그인 정보가 없습니다. 런처에서 다시 로그인해 주세요.')
                return
            }
            let session = null
            try {
                session = await require('electron').ipcRenderer.invoke('backend:sessionFor', slotAccount.accessToken)
            } catch (err) {
                session = { ok: false, error: err.message }
            }
            if (session == null || session.ok !== true || session.modToken == null) {
                showLaunchFailure('계정 세션 실패', (session && session.error) || '슬롯 계정의 모드 토큰을 발급하지 못했습니다.')
                return
            }
            slotModToken = session.modToken
            slotRefreshToken = session.refreshToken || null
        }
        let pb = new ProcessBuilder(serv, versionData, modLoaderData, authUser, remote.app.getVersion(), instanceDir,
            slotModToken,
            slotRefreshToken,
            telemetryInfo != null ? telemetryInfo.backendUrl : null,
            secureMods.jars)
        setLaunchDetails(Lang.queryJS('landing.dlAsync.launchingGame'))


        const SERVER_JOINED_REGEX = new RegExp(`\\[.+\\]: \\[CHAT\\] ${authUser.displayName} joined the game`)

        const onLoadComplete = () => {
            toggleLaunchArea(false)
            if(slot != null){
                slotRuntime[slot].booting = false
                slotRuntime[slot].running = true
                slotRuntime[slot].startedAt = Date.now()
                if(bootingSlot === slot) bootingSlot = null
                startSlotTimer(slot)
                renderDualSlots()
            }
            if(hasRPC){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.loading'))
                proc.stdout.on('data', gameStateChange)
            }
            proc.stdout.removeListener('data', tempListener)
            proc.stderr.removeListener('data', gameErrorListener)
        }
        const start = Date.now()


        const tempListener = function(data){
            if(GAME_LAUNCH_REGEX.test(data.trim())){
                const diff = Date.now()-start
                if(diff < MIN_LINGER) {
                    setTimeout(onLoadComplete, MIN_LINGER-diff)
                } else {
                    onLoadComplete()
                }
            }
        }


        const gameStateChange = function(data){
            data = data.trim()
            if(SERVER_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.joined'))
            } else if(GAME_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.joining'))
            }
        }

        const gameErrorListener = function(data){
            data = data.trim()
            if(data.indexOf('Could not find or load main class net.minecraft.launchwrapper.Launch') > -1){
                loggerLaunchSuite.error('Game launch failed, LaunchWrapper was not downloaded properly.')
                showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.launchWrapperNotDownloaded'))
            }
        }

        try {

            logLaunch('LAUNCH', 'ProcessBuilder.build() 호출 — 게임 프로세스를 띄웁니다')
            if(slot != null) slotRuntime[slot].launchStarted = true
            proc = pb.build()

            // 여기서도 오류를 잡습니다. 핸들러가 없으면 조용히 실패해
            // 화면에는 '완료' 로만 남고 게임 창이 뜨지 않습니다.
            proc.on('error', (err) => {
                logLaunchSection('게임 프로세스 시작 실패')
                logLaunch('ERROR', (err && err.message) ? err.message : String(err))
                logLaunch('ERROR', '코드 : ' + (err && err.code) + '   경로 : ' + (err && err.path))
                showLaunchFailure(
                    '게임을 실행하지 못했습니다',
                    ((err && err.message) ? err.message : String(err))
                        + '\n\n진단 로그를 확인해 주세요:\n' + ConfigManager.getLauncherDirectory() + '\\logs\\launcher.log'
                )
            })


            proc.stdout.on('data', tempListener)
            proc.stderr.on('data', gameErrorListener)

            if(slot != null){
                proc.on('close', () => {
                    resetSlotRuntime(slot)
                    renderDualSlots()
                })
                proc.on('error', () => {
                    resetSlotRuntime(slot)
                    renderDualSlots()
                })
            }

            setLaunchDetails(Lang.queryJS('landing.dlAsync.doneEnjoyServer'))


            if(distro.rawDistribution.discord != null && serv.rawServer.discord != null){
                DiscordWrapper.initRPC(distro.rawDistribution.discord, serv.rawServer.discord)
                hasRPC = true
                proc.on('close', (code, signal) => {
                    loggerLaunchSuite.info('Shutting down Discord Rich Presence..')
                    DiscordWrapper.shutdownRPC()
                    hasRPC = false
                    proc = null
                })
            }

        } catch(err) {

            loggerLaunchSuite.error('Error during launch', err)
            logLaunchSection('게임 실행 중 예외')
            logLaunch('ERROR', (err && err.stack) ? err.stack : String(err))
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.checkConsoleForDetails'))

        }
    }

}



function readTail(file, maxBytes = 400000) {
    try {
        const fs = require('fs')
        if(!fs.existsSync(file)) return null
        const stat = fs.statSync(file)
        const start = Math.max(0, stat.size - maxBytes)
        const fd = fs.openSync(file, 'r')
        const buf = Buffer.alloc(stat.size - start)
        fs.readSync(fd, buf, 0, buf.length, start)
        fs.closeSync(fd)
        return buf.toString('utf8')
    } catch (err) {
        return '[read failed] ' + err.message
    }
}

function readFiltered(file, maxLines = 300) {
    try {
        const fs = require('fs')
        if(!fs.existsSync(file)) return null
        const text = fs.readFileSync(file, 'utf8')
        const lines = text.split(/\r?\n/)
        const matched = lines.filter((line) => /(ERROR|WARN|FATAL|Exception|Caused by|crash|OutOfMemory)/i.test(line))
        return matched.slice(-maxLines).join('\n')
    } catch (err) {
        return '[read failed] ' + err.message
    }
}

function findLatestCrash(dir) {
    try {
        const fs = require('fs')
        const path = require('path')
        const crashDir = path.join(dir, 'crash-reports')
        if(!fs.existsSync(crashDir)) return null
        const files = fs.readdirSync(crashDir).filter((f) => f.endsWith('.txt')).sort()
        if(files.length === 0) return null
        return readTail(path.join(crashDir, files[files.length - 1]), 120000)
    } catch (_) { return null }
}

function collectSupportReport() {
    const os = require('os')
    const fs = require('fs')
    const path = require('path')
    const { spawnSync } = require('child_process')

    const account = ConfigManager.getSelectedAccount()
    const server = ConfigManager.getSelectedServer()
    const javaExe = server != null ? ConfigManager.getJavaExecutable(server) : null

    let javaVersion = null
    if(javaExe != null){
        try {
            const r = spawnSync(javaExe, ['-version'], { encoding: 'utf8', timeout: 5000 })
            javaVersion = ((r.stdout || '') + (r.stderr || '')).trim().slice(0, 2000)
        } catch (err) { javaVersion = 'error: ' + err.message }
    }

    const dataDir = ConfigManager.getDataDirectory()
    let disk = null
    try {
        const st = fs.statfsSync(dataDir)
        disk = {
            freeGB: Math.round((st.bsize * st.bavail) / 1073741824 * 10) / 10,
            totalGB: Math.round((st.bsize * st.blocks) / 1073741824 * 10) / 10
        }
    } catch (_) { disk = null }

    const mainDir = ConfigManager.getInstanceDirectoryForSlot ? ConfigManager.getInstanceDirectoryForSlot('main') : null
    const altDir = ConfigManager.getInstanceDirectoryForSlot ? ConfigManager.getInstanceDirectoryForSlot('alt') : null
    const launcherLog = path.join(ConfigManager.getLauncherDirectory(), 'logs', 'launcher.log')

    const report = {
        launcherVersion: remote.app.getVersion(),
        sentAt: new Date().toISOString(),
        account: account != null ? { uuid: account.uuid, displayName: account.displayName } : null,
        server,
        os: {
            platform: os.platform(),
            release: os.release(),
            arch: os.arch(),
            hostname: os.hostname(),
            uptimeSec: Math.round(os.uptime()),
            cpu: (os.cpus()[0] || {}).model || null,
            cpuCount: os.cpus().length
        },
        memory: {
            totalGB: Math.round(os.totalmem() / 1073741824 * 10) / 10,
            freeGB: Math.round(os.freemem() / 1073741824 * 10) / 10,
            process: process.memoryUsage()
        },
        disk,
        java: { path: javaExe, version: javaVersion },
        paths: { dataDir, mainDir, altDir },
        logs: {
            launcher: readTail(launcherLog),
            mainLatest: mainDir != null ? readTail(path.join(mainDir, 'logs', 'latest.log')) : null,
            altLatest: altDir != null ? readTail(path.join(altDir, 'logs', 'latest.log')) : null,
            launcherErrors: readFiltered(launcherLog),
            mainErrors: mainDir != null ? readFiltered(path.join(mainDir, 'logs', 'latest.log')) : null,
            altErrors: altDir != null ? readFiltered(path.join(altDir, 'logs', 'latest.log')) : null,
            crashReport: mainDir != null ? findLatestCrash(mainDir) : null
        }
    }

    // 1MB 제한에 맞게 로그 축소
    // 1차: 로그 꼬리를 80KB로, 2차: 40KB로 축소 (오류 필터/크래시 리포트는 유지)
    for(const limit of [200000, 80000]){
        if(Buffer.byteLength(JSON.stringify(report)) <= 4000000) break
        for(const k of ['launcher', 'mainLatest', 'altLatest']){
            if(report.logs[k] != null) report.logs[k] = report.logs[k].slice(-limit)
        }
    }
    return report
}

function bindSendLogsButton() {
    const btn = document.getElementById('sendLogsButton')
    if(btn == null) return
    btn.addEventListener('click', async () => {
        if(!confirm('진단 로그(시스템 정보/메모리/디스크/자바/최근 로그)를 서버로 보낼까요?')) return
        const original = btn.textContent
        btn.disabled = true
        btn.textContent = '보내는 중...'
        try {
            const payload = collectSupportReport()
            const reportAccount = ConfigManager.getSelectedAccount()
        if (reportAccount != null && reportAccount.accessToken != null) {
            payload.accessToken = reportAccount.accessToken
        }
        const res = await require('electron').ipcRenderer.invoke('backend:sendReport', payload)
            if(res.ok){
                alert('로그를 보냈습니다. 감사합니다!')
            } else {
                alert('로그 전송에 실패했습니다.\n' + (res.error || res.body && res.body.error && res.body.error.message || ('HTTP ' + res.status)))
            }
        } catch (err) {
            alert('로그 전송 중 오류: ' + err.message)
        } finally {
            btn.disabled = false
            btn.textContent = original
        }
    })
}

bindSendLogsButton()

function restorePendingSettingsTab(){
    const pending = ConfigManager.getPendingSettingsTab()
    if(pending == null){
        return
    }

    ConfigManager.setPendingSettingsTab(null)
    ConfigManager.save()


    let attempts = 0
    const tryRestore = () => {
        const navItem = document.getElementById(pending)
        if(navItem != null && getCurrentView() === VIEWS.landing){
            switchView(VIEWS.landing, VIEWS.settings, 0, 0, () => {
                settingsNavItemListener(navItem, false)
            })
            return
        }
        if(++attempts < 60){
            setTimeout(tryRestore, 500)
        } else {
            loggerLanding.warn('설정 탭으로 돌아가지 못했습니다. 랜딩 화면에 머무릅니다.')
        }
    }
    setTimeout(tryRestore, 500)
}

restorePendingSettingsTab()


// 런처 업데이트가 있으면 홈 화면 상단 가운데에 알립니다.
// 설정 → 업데이트 탭까지 들어가지 않아도 바로 설치할 수 있게 합니다.
function showLandingUpdateNotice(info, downloaded){
    const notice = document.getElementById('updateNotice')
    if(notice == null){
        return
    }

    const version = document.getElementById('updateNoticeVersion')
    if(version != null && info != null && info.version != null){
        version.textContent = `v${info.version}`
    }

    const button = document.getElementById('updateNoticeButton')
    if(button != null){
        button.textContent = downloaded
            ? Lang.queryJS('uicore.autoUpdate.installNowButton')
            : Lang.queryJS('settings.updates.downloadingButton')
        button.disabled = !downloaded
        button.onclick = downloaded ? requestUpdateInstall : null
    }

    notice.style.display = ''
}

function hideLandingUpdateNotice(){
    const notice = document.getElementById('updateNotice')
    if(notice != null){
        notice.style.display = 'none'
    }
}

ipcRenderer.on('autoUpdateNotification', (event, arg, info) => {
    if(arg === 'update-available'){
        // macOS 는 서명이 없어도 자체 교체로 바로 설치할 수 있습니다.
        showLandingUpdateNotice(info, process.platform === 'darwin')
    } else if(arg === 'update-downloaded'){
        showLandingUpdateNotice(info, true)
    } else if(arg === 'update-not-available'){
        hideLandingUpdateNotice()
    }
})


// uibinder 가 메인 화면을 띄우기 전에 이 스크립트의 초기화가 끝났는지 확인합니다.
window.__landingReady = true

setTimeout(() => { ensureLatestLauncher(true).catch(() => {}) }, 1200)
