#!/usr/bin/env node
/**
 * tools/reset-welcome.cjs
 * =============================================================================
 * `npm run reset:welcome`
 *
 * 개발용 데이터 폴더(.userdata)의 설정을 되돌려, 다음 `npm start` 때
 * 웰컴 화면(언어 선택)이 다시 나오게 합니다.
 *
 * 로그인 정보와 모드 설정은 그대로 둡니다. 언어 선택 여부만 초기화합니다.
 *
 * 참고:
 *   npm start 는 --user-data-dir=<프로젝트>/.userdata 로 실행됩니다.
 *   (설치된 앱의 %APPDATA%\은월 런처 와 섞이지 않습니다)
 * =============================================================================
 */
'use strict'

const fs = require('fs')
const path = require('path')

const configPath = path.join(__dirname, '..', '.userdata', 'config.json')

if (!fs.existsSync(configPath)) {
    console.log('[reset-welcome] 설정 파일이 아직 없습니다.')
    console.log('[reset-welcome] npm start 를 한 번 실행하면 만들어집니다.')
    console.log(`[reset-welcome] ${configPath}`)
    process.exit(0)
}

let config
try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
} catch (err) {
    console.error('[reset-welcome] 설정 파일을 읽지 못했습니다:', err.message)
    process.exit(1)
}

config.settings = config.settings || {}
config.settings.launcher = config.settings.launcher || {}

config.settings.launcher.languageChosen = false
config.settings.launcher.pendingWelcome = false
config.settings.launcher.pendingSettingsTab = null

fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf8')

const accounts = Object.keys(config.authenticationDatabase || {}).length
console.log('[reset-welcome] 초기화했습니다. 다음 npm start 때 웰컴 화면이 나옵니다.')
console.log(`[reset-welcome] 언어: ${config.settings.launcher.language}`)
console.log(`[reset-welcome] 로그인 계정: ${accounts}개 (그대로 유지)`)
