const remoteMain = require('@electron/remote/main')
remoteMain.initialize()

const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron')
const autoUpdater                       = require('electron-updater').autoUpdater
const ejse                              = require('ejs-electron')
const fs                                = require('fs')
const isDev                             = require('./app/assets/js/isdev')
const os                                = require('os')
const path                              = require('path')
const semver                            = require('semver')
const { spawn }                         = require('child_process')
const { pathToFileURL }                 = require('url')
const { AZURE_CLIENT_ID, MSFT_OPCODE, MSFT_REPLY_TYPE, MSFT_ERROR, SHELL_OPCODE } = require('./app/assets/js/ipcconstants')
const LangLoader                        = require('./app/assets/js/langloader')
const { createMacUpdater }              = require('./app/assets/js/macupdater')
const macUpdater                        = createMacUpdater({ app, shell })

LangLoader.setupLanguage()

// 자동 업데이트 피드(app-update.yml)가 없는 빌드에서는 확인 버튼이 오류를 내지 않고
// "최신 버전" 으로 조용히 처리되게 합니다.
function hasUpdateFeed() {
    const candidates = [
        path.join(process.resourcesPath || '', 'app-update.yml'),
        path.join(__dirname, 'app-update.yml'),
        path.join(__dirname, 'dev-app-update.yml')
    ]
    return candidates.some(p => p.length > 0 && fs.existsSync(p))
}

function initAutoUpdater(event, data) {

    if(data){
        autoUpdater.allowPrerelease = true
    }

    if(isDev){
        autoUpdater.autoInstallOnAppQuit = false
        autoUpdater.updateConfigPath = path.join(__dirname, 'dev-app-update.yml')
    }
    if(process.platform === 'darwin'){
        // macOS 는 서명 문제로 자체 DMG 교체기(macupdater)를 씁니다.
        return
    }
    autoUpdater.on('update-available', (info) => {
        event.sender.send('autoUpdateNotification', 'update-available', info)
    })
    autoUpdater.on('update-downloaded', (info) => {
        event.sender.send('autoUpdateNotification', 'update-downloaded', info)
    })
    autoUpdater.on('update-not-available', (info) => {
        event.sender.send('autoUpdateNotification', 'update-not-available', info)
    })
    autoUpdater.on('checking-for-update', () => {
        event.sender.send('autoUpdateNotification', 'checking-for-update')
    })
    autoUpdater.on('error', (err) => {
        event.sender.send('autoUpdateNotification', 'realerror', err)
    })
}

ipcMain.on('autoUpdateAction', (event, arg, data) => {
    switch(arg){
        case 'initAutoUpdater':
            console.log('Initializing auto updater.')
            initAutoUpdater(event, data)
            event.sender.send('autoUpdateNotification', 'ready')
            break
        case 'checkMacUpdate':
            if(!hasUpdateFeed()){
                event.sender.send('autoUpdateNotification', 'update-not-available')
                break
            }
            macUpdater.check(event.sender)
            break
        case 'checkForUpdate':
            if(!hasUpdateFeed()){
                // 배포 서버가 설정되지 않은 빌드: 조용히 최신 상태로 응답합니다.
                event.sender.send('autoUpdateNotification', 'update-not-available')
                break
            }
            if(process.platform === 'darwin'){
                macUpdater.check(event.sender)
                break
            }
            autoUpdater.checkForUpdates()
                .catch(err => {
                    event.sender.send('autoUpdateNotification', 'realerror', err)
                })
            break
        case 'allowPrereleaseChange':
            if(!data){
                const preRelComp = semver.prerelease(app.getVersion())
                if(preRelComp != null && preRelComp.length > 0){
                    autoUpdater.allowPrerelease = true
                } else {
                    autoUpdater.allowPrerelease = data
                }
            } else {
                autoUpdater.allowPrerelease = data
            }
            break
        case 'installUpdateNow':
            if(process.platform === 'darwin'){
                macUpdater.install(event.sender)
            } else {
                autoUpdater.quitAndInstall(true, true)
            }
            break
        default:
            console.log('Unknown argument', arg)
            break
    }
})

// 배포 인덱스는 preloader 가 렌더러 스크립트보다 먼저 끝나므로, 렌더러가 'dom-ready' 를 알리기 전까지
// 결과를 큐에 쌓아 둡니다. 그대로 보내면 메시지가 사라져 로딩 화면에서 멈춥니다.
const rendererDomReady = new WeakSet()
const pendingDistributionIndex = new WeakMap()

function sendDistributionIndexDone(webContents, res) {
    if (webContents.isDestroyed()) {
        return
    }
    webContents.send('distributionIndexDone', res === true)
}

function flushDistributionIndexDone(webContents) {
    if (!pendingDistributionIndex.has(webContents)) {
        return
    }
    const res = pendingDistributionIndex.get(webContents)
    pendingDistributionIndex.delete(webContents)
    sendDistributionIndexDone(webContents, res)
}

ipcMain.on('distributionIndexDone', (event, res) => {
    const webContents = event.sender
    if (rendererDomReady.has(webContents)) {
        sendDistributionIndexDone(webContents, res)
    } else {
        pendingDistributionIndex.set(webContents, res === true)
    }
})

ipcMain.handle(SHELL_OPCODE.TRASH_ITEM, async (event, ...args) => {
    try {
        await shell.trashItem(args[0])
        return {
            result: true
        }
    } catch(error) {
        return {
            result: false,
            error: error
        }
    }
})

// Windows 에서는 shell.openExternal 이 아무것도 열지 않고 성공하는 경우가 있어 cmd /c start 를 먼저 시도합니다.
function openExternalUrl(url) {
    if(process.platform === 'win32'){
        try {
            const child = spawn('cmd', ['/c', 'start', '', url], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            })
            child.unref()
            return
        } catch (err) {
            console.error('[Links] cmd start 실패, shell.openExternal 로 재시도합니다.', err)
        }
    }
    shell.openExternal(url).catch(err => {
        console.error('[Links] 브라우저를 열지 못했습니다:', url, err)
    })
}

ipcMain.handle('openExternal', (event, url) => {
    if(typeof url !== 'string' || !/^https?:\/\//i.test(url)){
        console.error('[Links] 허용되지 않은 URL 입니다:', url)
        return false
    }
    openExternalUrl(url)
    return true
})

// preload 는 @electron/remote 가 준비되기 전에 돌아 ConfigManager 를 쓸 수 없고,
// 언어는 EJS 렌더링 전에 정해져야 하므로 config.json 을 직접 읽습니다.
function readConfiguredLanguage() {
    const candidates = [
        path.join(app.getPath('userData'), 'config.json'),
        path.join(app.getPath('appData'), '.eunwol', 'config.json')
    ]
    for(const candidate of candidates){
        try {
            const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
            const value = parsed?.settings?.launcher?.language
            if(typeof value === 'string' && value.length > 0){
                return value
            }
        } catch (_err) {
            // 다음 후보를 확인합니다.
        }
    }
    return 'ko_KR'
}

ipcMain.on('getLanguage', (event) => {
    event.returnValue = readConfiguredLanguage()
})

// webContents.reload 로는 EJS 문구가 그대로 남고 앱 재시작은 돌아오지 않는 경우가 있어,
// loadURL 로 다시 그리고 메인 쪽 언어도 다시 읽습니다.
ipcMain.on('rerenderWindow', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if(win == null){
        return
    }
    LangLoader.setupLanguage()
    win.loadURL(pathToFileURL(path.join(__dirname, 'app', 'app.ejs')).toString())
})

app.disableHardwareAcceleration()

const REDIRECT_URI_PREFIX = 'https://login.microsoftonline.com/common/oauth2/nativeclient?'

let msftAuthWindow
let msftAuthSuccess
let msftAuthViewSuccess
let msftAuthViewOnClose
ipcMain.on(MSFT_OPCODE.OPEN_LOGIN, (ipcEvent, ...arguments_) => {
    if (msftAuthWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN, msftAuthViewOnClose)
        return
    }
    msftAuthSuccess = false
    msftAuthViewSuccess = arguments_[0]
    msftAuthViewOnClose = arguments_[1]
    msftAuthWindow = new BrowserWindow({
        title: LangLoader.queryJS('index.microsoftLoginTitle'),
        backgroundColor: '#0b1018',
        width: 520,
        height: 600,
        frame: true,
        icon: getPlatformIcon('SealCircle')
    })

    msftAuthWindow.on('closed', () => {
        msftAuthWindow = undefined
    })

    msftAuthWindow.on('close', () => {
        if(!msftAuthSuccess) {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED, msftAuthViewOnClose)
        }
    })

    msftAuthWindow.webContents.on('did-navigate', (_, uri) => {
        if (uri.startsWith(REDIRECT_URI_PREFIX)) {
            let queryMap = {}

            new URL(uri).searchParams.forEach((v, k) => {
                queryMap[k] = v
            })

            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.SUCCESS, queryMap, msftAuthViewSuccess)

            msftAuthSuccess = true
            msftAuthWindow.close()
            msftAuthWindow = null
        }
    })

    msftAuthWindow.removeMenu()
    msftAuthWindow.loadURL(`https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?prompt=select_account&client_id=${AZURE_CLIENT_ID}&response_type=code&scope=XboxLive.signin%20offline_access&redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient`)
})

let msftLogoutWindow
let msftLogoutSuccess
let msftLogoutSuccessSent
ipcMain.on(MSFT_OPCODE.OPEN_LOGOUT, (ipcEvent, uuid, isLastAccount) => {
    if (msftLogoutWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN)
        return
    }

    msftLogoutSuccess = false
    msftLogoutSuccessSent = false
    msftLogoutWindow = new BrowserWindow({
        title: LangLoader.queryJS('index.microsoftLogoutTitle'),
        backgroundColor: '#0b1018',
        width: 520,
        height: 600,
        frame: true,
        icon: getPlatformIcon('SealCircle')
    })

    msftLogoutWindow.on('closed', () => {
        msftLogoutWindow = undefined
    })

    msftLogoutWindow.on('close', () => {
        if(!msftLogoutSuccess) {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED)
        } else if(!msftLogoutSuccessSent) {
            msftLogoutSuccessSent = true
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.SUCCESS, uuid, isLastAccount)
        }
    })

    msftLogoutWindow.webContents.on('did-navigate', (_, uri) => {
        if(uri.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/logoutsession')) {
            msftLogoutSuccess = true
            setTimeout(() => {
                if(!msftLogoutSuccessSent) {
                    msftLogoutSuccessSent = true
                    ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.SUCCESS, uuid, isLastAccount)
                }

                if(msftLogoutWindow) {
                    msftLogoutWindow.close()
                    msftLogoutWindow = null
                }
            }, 5000)
        }
    })

    msftLogoutWindow.removeMenu()
    msftLogoutWindow.loadURL('https://login.microsoftonline.com/common/oauth2/v2.0/logout')
})

let win

function createWindow() {

    win = new BrowserWindow({
        width: 980,
        height: 552,
        minWidth: 880,
        minHeight: 500,
        icon: getPlatformIcon('SealCircle'),
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, 'app', 'assets', 'js', 'preloader.js'),
            nodeIntegration: true,
            contextIsolation: false
        },
        backgroundColor: '#080c14'
    })
    remoteMain.enable(win.webContents)

    // 'once' 로 두면 새로 고침 뒤에도 준비됨으로 남아 메시지가 사라지므로(무한 로딩) 매번 초기화합니다.
    win.webContents.on('did-start-loading', () => {
        rendererDomReady.delete(win.webContents)
    })
    win.webContents.on('dom-ready', () => {
        rendererDomReady.add(win.webContents)
        flushDistributionIndexDone(win.webContents)
    })

    const data = {
        bkid: Math.floor((Math.random() * fs.readdirSync(path.join(__dirname, 'app', 'assets', 'images', 'backgrounds')).length)),
        lang: (str, placeHolders) => LangLoader.queryEJS(str, placeHolders)
    }
    Object.entries(data).forEach(([key, val]) => ejse.data(key, val))

    win.loadURL(pathToFileURL(path.join(__dirname, 'app', 'app.ejs')).toString())

    win.removeMenu()

    win.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') {
            return
        }
        const isF12 = input.key === 'F12'
        const isDevToolsCombo = input.control && input.shift && input.key.toLowerCase() === 'i'
        if (isF12 || isDevToolsCombo) {
            win.webContents.toggleDevTools()
            event.preventDefault()
        }
    })

    win.resizable = true

    win.on('closed', () => {
        win = null
    })
}

function createMenu() {

    if(process.platform === 'darwin') {

        let applicationSubMenu = {
            label: 'Application',
            submenu: [{
                label: 'About Application',
                selector: 'orderFrontStandardAboutPanel:'
            }, {
                type: 'separator'
            }, {
                label: 'Quit',
                accelerator: 'Command+Q',
                click: () => {
                    app.quit()
                }
            }]
        }

        let editSubMenu = {
            label: 'Edit',
            submenu: [{
                label: 'Undo',
                accelerator: 'CmdOrCtrl+Z',
                selector: 'undo:'
            }, {
                label: 'Redo',
                accelerator: 'Shift+CmdOrCtrl+Z',
                selector: 'redo:'
            }, {
                type: 'separator'
            }, {
                label: 'Cut',
                accelerator: 'CmdOrCtrl+X',
                selector: 'cut:'
            }, {
                label: 'Copy',
                accelerator: 'CmdOrCtrl+C',
                selector: 'copy:'
            }, {
                label: 'Paste',
                accelerator: 'CmdOrCtrl+V',
                selector: 'paste:'
            }, {
                label: 'Select All',
                accelerator: 'CmdOrCtrl+A',
                selector: 'selectAll:'
            }]
        }

        let menuTemplate = [applicationSubMenu, editSubMenu]
        let menuObject = Menu.buildFromTemplate(menuTemplate)

        Menu.setApplicationMenu(menuObject)

    }

}

function getPlatformIcon(filename){
    let ext
    switch(process.platform) {
        case 'win32':
            ext = 'ico'
            break
        case 'darwin':
        case 'linux':
        default:
            ext = 'png'
            break
    }

    return path.join(__dirname, 'app', 'assets', 'images', `${filename}.${ext}`)
}

require('./backend-client').register()

app.on('ready', () => {
    // 어떤 이유로든 이 호출이 실패해도 창은 반드시 떠야 합니다.
    try { launchLogSystemInfo() } catch (err) { console.error('[launchLog]', err) }
})
app.on('ready', createWindow)
app.on('ready', createMenu)

app.on('window-all-closed', () => {
    launchLog('SYS', '모든 창이 닫혀 런처를 종료합니다.')
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

app.on('activate', () => {
    if (win === null) {
        createWindow()
    }
})

// ===== 런처 진단 로그 =====
// 플레이 버튼을 누른 시점부터의 모든 과정을 파일로 남깁니다.
//   위치: <userData>/logs/launcher.log     (예: %APPDATA%\은월 런처\logs\launcher.log)
//
// 목적: 게임이 logs/latest.log 를 만들기 전에 실패하면 아무 흔적도 남지 않습니다.
//       ("왜 게임이 안 켜지나" 를 알 수 없게 되는 문제) 그 구간을 기록합니다.

const LAUNCH_LOG_MAX_BYTES = 8 * 1024 * 1024
let launchLogFile = null
let launchLogReady = false

function launchLogPath() {
    if (launchLogFile == null) {
        launchLogFile = path.join(app.getPath('userData'), 'logs', 'launcher.log')
    }
    return launchLogFile
}

function launchLogTimestamp() {
    const d = new Date()
    const p = n => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
        + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.'
        + String(d.getMilliseconds()).padStart(3, '0')
}

function launchLogEnsure() {
    if (launchLogReady) {
        return
    }
    const file = launchLogPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
        // 무한히 커지지 않게, 일정 크기를 넘으면 한 번만 옮겨 둡니다.
        if (fs.existsSync(file) && fs.statSync(file).size > LAUNCH_LOG_MAX_BYTES) {
            fs.renameSync(file, file + '.old')
        }
    } catch (_err) { /* 무시 */ }
    launchLogReady = true
}

function launchLog(scope, message) {
    try {
        launchLogEnsure()
        let text
        if (message == null) {
            text = ''
        } else if (typeof message === 'string') {
            text = message
        } else if (message instanceof Error) {
            text = message.stack || message.message
        } else {
            try { text = JSON.stringify(message) } catch (_err) { text = String(message) }
        }
        fs.appendFileSync(launchLogPath(), '[' + launchLogTimestamp() + '] [' + scope + '] ' + text + '\n', 'utf8')
    } catch (_err) {
        // 로그를 못 써도 앱 동작에는 영향이 없게 합니다.
    }
}

function launchLogSection(title) {
    launchLog('----', '')
    launchLog('----', '==================== ' + title + ' ====================')
}

function launchLogSystemInfo() {
    // 로깅이 앱 시작을 막으면 안 됩니다.
    try {
        const cpus = os.cpus() || []
        launchLogSection('런처 시작')
        launchLog('SYS', '런처 버전   : ' + app.getVersion())
        launchLog('SYS', '플랫폼      : ' + process.platform + ' / ' + process.arch)
        launchLog('SYS', 'OS          : ' + os.type() + ' ' + os.release() + ' (빌드 ' + os.version() + ')')
        launchLog('SYS', 'CPU         : ' + ((cpus[0] || {}).model || '?') + '  (' + cpus.length + ' 코어)')
        launchLog('SYS', '메모리      : 전체 ' + (os.totalmem() / 1073741824).toFixed(1) + 'GB / 여유 ' + (os.freemem() / 1073741824).toFixed(1) + 'GB')
        launchLog('SYS', 'Electron    : ' + process.versions.electron + '   Chrome ' + process.versions.chrome + '   Node ' + process.versions.node)
        launchLog('SYS', 'userData    : ' + app.getPath('userData'))
        launchLog('SYS', 'appData     : ' + app.getPath('appData'))
        launchLog('SYS', '실행 파일   : ' + app.getPath('exe'))
        launchLog('SYS', '개발 모드   : ' + isDev)
    } catch (err) {
        console.error('[launchLog] 시스템 정보 기록 실패:', err)
    }
}

// 렌더러(화면 쪽)에서 보내는 로그를 받아 같은 파일에 씁니다.
ipcMain.on('launcherLog', (event, scope, message) => {
    launchLog(scope || 'UI', message)
})

// 로그 파일이 있는 폴더를 열어 줍니다. (사용자가 파일을 찾기 쉽게)
ipcMain.on('launcherLogOpenFolder', () => {
    try {
        launchLogEnsure()
        shell.showItemInFolder(launchLogPath())
    } catch (err) {
        launchLog('WARN', '로그 폴더 열기 실패: ' + (err.message || err))
    }
})

ipcMain.handle('launcherLogPathGet', () => launchLogPath())

// 예기치 못한 오류도 남깁니다. (이게 없으면 조용히 죽습니다)
process.on('uncaughtException', (err) => {
    launchLog('FATAL', 'uncaughtException: ' + (err && err.stack ? err.stack : String(err)))
})
process.on('unhandledRejection', (reason) => {
    launchLog('FATAL', 'unhandledRejection: ' + (reason && reason.stack ? reason.stack : String(reason)))
})
