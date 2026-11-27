const loginOptionsCancelContainer = document.getElementById('loginOptionCancelContainer')
const loginOptionMicrosoft = document.getElementById('loginOptionMicrosoft')
const loginOptionMojang = document.getElementById('loginOptionMojang')
const loginOptionBrowser = document.getElementById('loginOptionBrowser')
const loginOptionsCancelButton = document.getElementById('loginOptionCancelButton')
const browserLoginPanel = document.getElementById('browserLoginPanel')
const browserLoginCode = document.getElementById('browserLoginCode')
const browserLoginSubmit = document.getElementById('browserLoginSubmit')
const browserLoginCancel = document.getElementById('browserLoginCancel')
const browserLoginStatus = document.getElementById('browserLoginStatus')
const browserLoginActions = document.querySelector('.loginOptionActions')
let AZURE_CLIENT_ID = '1ce6e35a-126f-48fd-97fb-54d143ac6d45'
try {
    const ipcConstants = require('./assets/js/ipcconstants')
    if(ipcConstants && ipcConstants.AZURE_CLIENT_ID){
        AZURE_CLIENT_ID = ipcConstants.AZURE_CLIENT_ID
    }
} catch (_) { /* ipcconstants를 못 읽어도 기본 client id로 동작 */ }

let loginOptionsCancellable = false

let loginOptionsViewOnLoginSuccess
let loginOptionsViewOnLoginCancel
let loginOptionsViewOnCancel
let loginOptionsViewCancelHandler
let browserLoginBusy = false

function loginOptionsCancelEnabled(val){
    if(val){
        $(loginOptionsCancelContainer).show()
    } else {
        $(loginOptionsCancelContainer).hide()
    }
}

function showBrowserLogin(show){
    browserLoginPanel.style.display = show ? 'block' : 'none'
    browserLoginActions.style.display = show ? 'none' : 'flex'
    loginOptionsCancelContainer.style.display = show ? 'none' : ''
    if(show){
        browserLoginStatus.textContent = ''
        browserLoginCode.value = ''
        setTimeout(() => browserLoginCode.focus(), 50)
    } else {
        browserLoginCode.value = ''
        browserLoginStatus.textContent = ''
    }
}

function buildMicrosoftBrowserUrl(){
    const params = new URLSearchParams({
        prompt: 'select_account',
        client_id: AZURE_CLIENT_ID,
        response_type: 'code',
        scope: 'XboxLive.signin offline_access',
        redirect_uri: 'https://login.microsoftonline.com/common/oauth2/nativeclient'
    })
    return 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?' + params.toString()
}

function extractAuthCode(raw){
    const value = String(raw == null ? '' : raw).trim()
    if(!value) return ''

    // 사용자가 주소창 전체를 붙여넣은 경우 code 파라미터만 추출한다.
    try {
        const parsed = new URL(value)
        const code = parsed.searchParams.get('code')
        if(code) return code
    } catch (_) { /* URL이 아니면 아래에서 처리 */ }

    const match = value.match(/[?&#]code=([^&#\s]+)/i)
    if(match) return decodeURIComponent(match[1])

    return value.replace(/^code=/i, '')
}

function setBrowserLoginBusy(busy){
    browserLoginBusy = busy
    browserLoginSubmit.disabled = busy
    browserLoginCancel.disabled = busy
    browserLoginCode.disabled = busy
}

function browserLoginError(error){
    if(error && error.title){
        return error.desc ? `${error.title}\n${error.desc}` : error.title
    }
    return '로그인에 실패했습니다. code가 올바른지 확인해 주세요.'
}

loginOptionBrowser.onclick = (e) => {
    showBrowserLogin(true)
    ipcRenderer.invoke('openExternal', buildMicrosoftBrowserUrl()).catch((err) => {
        browserLoginStatus.textContent = '브라우저를 열지 못했습니다: ' + err.message
    })
}

browserLoginSubmit.onclick = () => {
    if(browserLoginBusy) return
    const code = extractAuthCode(browserLoginCode.value)
    if(!code){
        browserLoginStatus.textContent = 'code를 입력해 주세요.'
        browserLoginCode.focus()
        return
    }

    setBrowserLoginBusy(true)
    browserLoginStatus.textContent = 'Microsoft 계정 확인 중…'

    Promise.resolve(AuthManager.addMicrosoftAccount(code))
        .then((value) => {
            updateSelectedAccount(value)
            showBrowserLogin(false)
            switchView(getCurrentView(), loginOptionsViewOnLoginSuccess || VIEWS.landing, 500, 500)
        })
        .catch((error) => {
            setBrowserLoginBusy(false)
            browserLoginStatus.textContent = browserLoginError(error)
        })
}

browserLoginCancel.onclick = () => {
    if(browserLoginBusy) return
    showBrowserLogin(false)
}

browserLoginCode.addEventListener('keydown', (event) => {
    if(event.key === 'Enter') browserLoginSubmit.click()
})

loginOptionMicrosoft.onclick = (e) => {
    switchView(getCurrentView(), VIEWS.waiting, 500, 500, () => {
        ipcRenderer.send(
            MSFT_OPCODE.OPEN_LOGIN,
            loginOptionsViewOnLoginSuccess,
            loginOptionsViewOnLoginCancel
        )
    })
}

loginOptionMojang.onclick = (e) => {
    switchView(getCurrentView(), VIEWS.login, 500, 500, () => {
        loginViewOnSuccess = loginOptionsViewOnLoginSuccess
        loginViewOnCancel = loginOptionsViewOnLoginCancel
        loginCancelEnabled(true)
    })
}

loginOptionsCancelButton.onclick = (e) => {
    switchView(getCurrentView(), loginOptionsViewOnCancel, 500, 500, () => {


        loginUsername.value = ''
        loginPassword.value = ''
        if(loginOptionsViewCancelHandler != null){
            loginOptionsViewCancelHandler()
            loginOptionsViewCancelHandler = null
        }
    })
}
