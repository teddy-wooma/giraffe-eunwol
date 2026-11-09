#!/usr/bin/env node
/**
 * tools/check-electron.cjs
 * =============================================================================
 * Electron 이 이 PC/터미널에서 정상적으로 창을 만들 수 있는지 확인하는 진단 도구.
 *
 *   npm run check
 *   (또는) node_modules\electron\dist\electron.exe tools\check-electron.cjs
 *
 * 런처 코드와 무관하게 "Electron 자체가 창을 띄울 수 있는 환경인가"만 봅니다.
 *   - 1단계  Node/Electron 버전, 환경 변수 확인
 *   - 2단계  app / BrowserWindow API 사용 가능 여부
 *   - 3단계  실제로 창을 하나 띄워 봄
 *
 * 3단계까지 통과하면 환경은 정상이고, 문제는 런처 코드 쪽입니다.
 * 2단계에서 멈추면 ELECTRON_RUN_AS_NODE 문제,
 * 창이 뜨지 않고 조용히 끝나면 터미널/보안 소프트웨어가 GUI 생성을 막고 있습니다.
 * =============================================================================
 */
'use strict'

function line(label, value) {
    console.log(`  ${label.padEnd(28)}: ${value}`)
}

console.log('=== 1단계: 실행 환경 ===')
line('process.versions.node', process.versions.node)
line('process.versions.electron', process.versions.electron ?? '(없음 - Electron 아님!)')
line('process.versions.chrome', process.versions.chrome ?? '(없음)')
line('ELECTRON_RUN_AS_NODE', JSON.stringify(process.env.ELECTRON_RUN_AS_NODE ?? null))
line('platform / arch', `${process.platform} / ${process.arch}`)
console.log('')

console.log('=== 2단계: Electron API ===')
let app
let BrowserWindow
try {
    const electron = require('electron')
    if (typeof electron === 'string') {
        console.log('  require("electron") 이 문자열을 반환했습니다:', electron)
        console.log('  => 일반 Node.js 로 실행 중입니다. GUI 를 만들 수 없습니다.')
        console.log('     ELECTRON_RUN_AS_NODE 를 제거하고 다시 실행하세요.')
        process.exit(2)
    }
    app = electron.app
    BrowserWindow = electron.BrowserWindow
    line('require("electron").app', typeof app)
    line('require("electron").BrowserWindow', typeof BrowserWindow)
} catch (err) {
    console.log('  require("electron") 실패:', err.message)
    process.exit(2)
}
console.log('')

if (app == null || BrowserWindow == null) {
    console.log('  app / BrowserWindow 를 사용할 수 없습니다. Electron 으로 실행되지 않았습니다.')
    process.exit(2)
}

console.log('=== 3단계: 창 생성 테스트 ===')
let windowCreated = false

app.disableHardwareAcceleration()

app.whenReady().then(() => {
    console.log('  app ready 이벤트 발생')
    try {
        const win = new BrowserWindow({
            width: 420,
            height: 260,
            title: 'Electron 진단 - 이 창이 보이면 정상입니다'
        })
        win.loadURL('data:text/html,' + encodeURIComponent(
            '<body style="font-family:sans-serif;background:#1b1b1b;color:#eee;padding:24px">' +
            '<h2>진단 성공</h2><p>Electron 이 정상적으로 창을 만들었습니다.</p>' +
            '<p>이 창은 6초 뒤 자동으로 닫힙니다.</p></body>'
        ))
        windowCreated = true
        console.log('  창 생성 요청 완료 (화면에 창이 떠야 합니다)')
    } catch (err) {
        console.log('  창 생성 실패:', err.message)
    }
})

app.on('window-all-closed', () => {
    console.log('  모든 창이 닫혔습니다.')
    app.quit()
})

// 안전장치: 6초 뒤 자동 종료
setTimeout(() => {
    console.log('')
    if (windowCreated) {
        console.log('결과: 정상 - Electron 이 창을 만들 수 있는 환경입니다.')
        console.log('      런처가 안 뜬다면 런처 코드 쪽 문제입니다.')
    } else {
        console.log('결과: 창이 만들어지지 않았습니다.')
        console.log('      터미널 또는 보안 소프트웨어가 GUI 생성을 막고 있을 수 있습니다.')
        console.log('      Windows 시작 메뉴에서 PowerShell 을 직접 열고 다시 시도해 보세요.')
    }
    app.quit()
}, 6000)
