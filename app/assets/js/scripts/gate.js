'use strict'

/**
 * 승인 게이트 UI/로직
 * - PLAY 시 백엔드에 세션 시작 요청
 * - pending: 승인 대기 화면 + 10초 폴링
 * - banned: 차단 화면
 * - 승인되면 자동으로 게임 실행 흐름 재개
 */

const ipc = require('electron').ipcRenderer

const gateContainer = document.getElementById('gateContainer')
const gateIcon = document.getElementById('gateIcon')
const gateTitle = document.getElementById('gateTitle')
const gateMessage = document.getElementById('gateMessage')
const gateMeta = document.getElementById('gateMeta')
const gateRetryButton = document.getElementById('gateRetryButton')
const gateCloseButton = document.getElementById('gateCloseButton')

const POLL_INTERVAL_MS = 10 * 1000

let pendingResolve = null
let pendingReject = null
let pollTimer = null
let currentAccount = null

function setVisible(visible) {
    if (gateContainer == null) return
    gateContainer.style.display = visible ? 'flex' : 'none'
}

function clearPoll() {
    if (pollTimer != null) {
        clearInterval(pollTimer)
        pollTimer = null
    }
}

function resetHandlers() {
    gateRetryButton.onclick = null
    gateCloseButton.onclick = null
    gateRetryButton.style.display = 'none'
    gateCloseButton.textContent = '닫기'
}

function showDialog({ icon, title, message, meta, retryLabel, onRetry, closeLabel, onClose }) {
    resetHandlers()
    gateIcon.innerHTML = icon || '&#128274;'
    gateTitle.textContent = title || ''
    gateMessage.textContent = message || ''
    gateMeta.textContent = meta || ''
    gateMeta.style.display = meta ? 'block' : 'none'

    if (typeof onRetry === 'function') {
        gateRetryButton.textContent = retryLabel || '다시 확인'
        gateRetryButton.style.display = ''
        gateRetryButton.onclick = onRetry
    }
    gateCloseButton.textContent = closeLabel || '닫기'
    gateCloseButton.onclick = onClose || (() => setVisible(false))

    setVisible(true)
}

function finishApproved() {
    clearPoll()
    setVisible(false)
    const resolve = pendingResolve
    pendingResolve = null
    pendingReject = null
    if (resolve != null) resolve(true)
}

function finishRejected() {
    clearPoll()
    const resolve = pendingResolve
    pendingResolve = null
    pendingReject = null
    if (resolve != null) resolve(false)
}

function showBanned(reason) {
    showDialog({
        icon: '&#9940;',
        title: '이용이 제한되었습니다',
        message: reason || '마을원 자격이 종료되었습니다.',
        meta: '문의: 마을 관리자 (디스코드)',
        closeLabel: '확인'
    })
    finishRejected()
}

function showError(message, retry) {
    showDialog({
        icon: '&#9888;&#65039;',
        title: '서버에 연결할 수 없습니다',
        message: message || '네트워크 상태를 확인한 뒤 다시 시도해 주세요.',
        retryLabel: '다시 시도',
        onRetry: retry,
        closeLabel: '닫기',
        onClose: () => {
            setVisible(false)
            finishRejected()
        }
    })
}

function showPending(requestId) {
    const meta = requestId ? `요청 번호: ${requestId}` : '요청 번호: 확인 중'
    showDialog({
        icon: '&#9203;',
        title: '관리자 승인 대기 중입니다',
        message: '마을 관리자에게 문의하세요. 승인되면 자동으로 시작됩니다.',
        meta,
        retryLabel: '지금 확인',
        onRetry: () => checkStatus(),
        closeLabel: '취소',
        onClose: () => {
            clearPoll()
            setVisible(false)
            finishRejected()
        }
    })
}

async function checkStatus() {
    try {
        const result = await ipc.invoke('backend:pollStatus')
        if (result.status === 'approved') {
            finishApproved()
        } else if (result.status === 'banned') {
            showBanned(result.reason)
        } else if (result.status === 'error') {
            showError(result.message, () => checkStatus())
        }
        // pending 은 그대로 대기
    } catch (err) {
        console.error('[gate] 상태 확인 실패:', err.message)
    }
}

function waitForApproval(requestId) {
    return new Promise((resolve) => {
        pendingResolve = resolve
        showPending(requestId)
        clearPoll()
        pollTimer = setInterval(checkStatus, POLL_INTERVAL_MS)
    })
}

async function ensureApproved(account) {
    currentAccount = account
    if (account == null || account.accessToken == null) {
        showError('로그인 정보가 없습니다. 다시 로그인해 주세요.')
        return false
    }

    let result
    try {
        result = await ipc.invoke('backend:sessionStart', {
            accessToken: account.accessToken
        })
    } catch (err) {
        showError('서버에 연결할 수 없습니다. 네트워크를 확인해 주세요.')
        return false
    }

    if (result.status === 'approved') {
        setVisible(false)
        return true
    }
    if (result.status === 'pending') {
        return waitForApproval(result.requestId)
    }
    if (result.status === 'banned') {
        showBanned(result.reason)
        return false
    }
    if (result.status === 'outdated') {
        showDialog({
            icon: '&#128260;',
            title: '런처 업데이트가 필요합니다',
            message: result.message || '최신 버전으로 업데이트해 주세요.',
            closeLabel: '확인'
        })
        return false
    }

    showError(result.message, () => {
        setVisible(false)
        ensureApproved(currentAccount)
    })
    return false
}

function broadcastBanned(reason) {
    showBanned(reason)
}

ipc.on('backend:banned', (_event, payload) => {
    broadcastBanned(payload && payload.reason)
})

window.Gate = {
    ensureApproved,
    showPending,
    showBanned,
    setVisible
}
