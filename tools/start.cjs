#!/usr/bin/env node
/**
 * tools/start.cjs
 * =============================================================================
 * `npm start` 로 런처를 실행하는 런처 스크립트.
 *
 * 왜 필요한가:
 *   환경 변수 ELECTRON_RUN_AS_NODE 가 설정되어 있으면 Electron 바이너리가
 *   GUI 앱 대신 "일반 Node.js" 로 동작합니다. 이때 require('electron') 은
 *   Electron API 대신 npm 패키지 경로(문자열)를 돌려주기 때문에 ipcMain/app
 *   이 없어서, 창이 뜨지 않고 곧바로 종료됩니다.
 *
 *   일부 터미널/샌드박스/CI 환경이 이 변수를 설정해 두기 때문에, 여기서
 *   자식 프로세스의 환경에서 해당 변수를 제거한 뒤 Electron 을 실행합니다.
 *
 * 사용법:
 *   npm start            (추가 인자는 그대로 Electron 에 전달됩니다)
 *   npm start -- --enable-logging
 * =============================================================================
 */
'use strict'

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

// require('electron') from plain Node.js returns the absolute path of the
// Electron executable (it reads node_modules/electron/path.txt).
const electronPath = require('electron')

if (typeof electronPath !== 'string') {
    console.error('[start] Electron 실행 파일 경로를 찾지 못했습니다.')
    console.error('[start] node_modules 를 지우고 `npm install` 을 다시 실행해 주세요.')
    process.exit(1)
}

const projectDir = path.join(__dirname, '..')

const env = { ...process.env }
if (env.ELECTRON_RUN_AS_NODE) {
    console.log('[start] ELECTRON_RUN_AS_NODE 가 설정되어 있어 제거하고 실행합니다.')
    delete env.ELECTRON_RUN_AS_NODE
}

// 게임 데이터(common, instances, java)도 프로젝트 안으로 돌립니다.
//
// --user-data-dir 는 설정 파일 위치만 바꿉니다. 게임 데이터는 기본적으로
// %APPDATA%\.eunwol 를 쓰는데, 프로젝트 밖 쓰기를 막는 환경에서는
// 그 때문에 파일 검증이 EPERM 으로 실패합니다. (1.21.11.json 을 쓰지 못함)
// 이 환경 변수로 그 문제를 없앱니다.
const defaultDataDir = path.join(projectDir, '.userdata', 'data')
if (!env.EUNWOL_DATA_DIR) {
    env.EUNWOL_DATA_DIR = defaultDataDir
    console.log(`[start] 게임 데이터 폴더: ${defaultDataDir}`)
}

// 임시 폴더도 프로젝트 안으로 돌립니다.
//
// 게임 실행에 필요한 네이티브 라이브러리를 %TEMP%\WCNatives 에 풀기 때문에,
// 프로젝트 밖 쓰기를 막는 환경에서는 그 단계에서도 EPERM 이 납니다.
// os.tmpdir() 는 TEMP/TMP 환경 변수를 읽으므로 여기서 바꿔 주면 됩니다.
const defaultTempDir = path.join(projectDir, '.userdata', 'temp')
if (!env.EUNWOL_KEEP_TEMP) {
    fs.mkdirSync(defaultTempDir, { recursive: true })
    env.TEMP = defaultTempDir
    env.TMP = defaultTempDir
    console.log(`[start] 임시 폴더: ${defaultTempDir}`)
}

// 추가 인자는 그대로 Electron 에 전달됩니다.
//   npm start -- --disable-gpu-sandbox
const extraArgs = process.argv.slice(2)
if (extraArgs.length > 0) {
    console.log(`[start] Electron 옵션: ${extraArgs.join(' ')}`)
}

// 개발 실행은 프로젝트 안에 자기 데이터 폴더를 따로 씁니다.
//  - 설치된 앱의 설정(%APPDATA%\은월 런처)과 섞이지 않습니다.
//  - 프로젝트 폴더 밖 쓰기를 막는 환경(에이전트 샌드박스 등)에서도
//    설정 파일을 쓸 수 있습니다.
const defaultUserDataDir = path.join(projectDir, '.userdata')
const hasUserDataArg = extraArgs.some(a => a.startsWith('--user-data-dir'))
const electronArgs = hasUserDataArg
    ? [projectDir, ...extraArgs]
    : [projectDir, `--user-data-dir=${defaultUserDataDir}`, ...extraArgs]

if (!hasUserDataArg) {
    console.log(`[start] 데이터 폴더: ${defaultUserDataDir}`)
}

const child = spawn(electronPath, electronArgs, {
    stdio: 'inherit',
    env
})

child.on('error', err => {
    console.error('[start] Electron 실행에 실패했습니다:', err.message)
    process.exit(1)
})

child.on('close', code => {
    process.exit(code == null ? 0 : code)
})
