const fs        = require('fs-extra')
const path      = require('path')
const { ipcRenderer, shell, webUtils } = require('electron')
const { SHELL_OPCODE } = require('./ipcconstants')

// 1번째 그룹: 확장자를 뺀 파일 이름
// 2번째 그룹: 확장자 (jar, zip, litemod)
// 3번째 그룹: 비활성화 여부 (.disabled)
const MOD_REGEX = /^(.+(jar|zip|litemod))(?:\.(disabled))?$/
const DISABLED_EXT = '.disabled'


// 드래그 앤 드롭으로 받은 파일의 실제 경로를 구합니다.
// Electron 32 부터 File.path 가 없어져 webUtils.getPathForFile 을 씁니다.
function resolveDroppedPath(file) {
    if (file == null) {
        return null
    }
    if (typeof file.path === 'string' && file.path.length > 0) {
        return file.path
    }
    try {
        if (webUtils != null && typeof webUtils.getPathForFile === 'function') {
            const resolved = webUtils.getPathForFile(file)
            if (typeof resolved === 'string' && resolved.length > 0) {
                return resolved
            }
        }
    } catch (err) {
        console.error('드롭한 파일의 경로를 읽지 못했습니다.', err)
    }
    return null
}


exports.validateDir = function(dir) {
    fs.ensureDirSync(dir)
}


exports.scanForDropinMods = function(modsDir, version) {
    const modsDiscovered = []
    if(fs.existsSync(modsDir)){
        const modCandidates = fs.readdirSync(modsDir)
        let verCandidates = []
        const versionDir = path.join(modsDir, version)
        if(fs.existsSync(versionDir)){
            verCandidates = fs.readdirSync(versionDir)
        }
        for(const file of modCandidates){
            const match = MOD_REGEX.exec(file)
            if(match != null){
                modsDiscovered.push({
                    fullName: match[0],
                    name: match[1],
                    ext: match[2],
                    disabled: match[3] != null
                })
            }
        }
        for(const file of verCandidates){
            const match = MOD_REGEX.exec(file)
            if(match != null){
                modsDiscovered.push({
                    fullName: path.join(version, match[0]),
                    name: match[1],
                    ext: match[2],
                    disabled: match[3] != null
                })
            }
        }
    }
    return modsDiscovered
}


// 드래그 앤 드롭으로 받은 파일을 모드 폴더로 옮깁니다.
exports.addDropinMods = function(files, modsdir) {

    exports.validateDir(modsdir)

    let added = 0
    for(const f of files) {
        if(MOD_REGEX.exec(f.name) == null) {
            continue
        }
        const sourcePath = resolveDroppedPath(f)
        if(sourcePath == null) {
            console.error('드롭한 모드의 경로를 알 수 없습니다: ' + f.name)
            continue
        }
        try {
            fs.moveSync(sourcePath, path.join(modsdir, f.name), { overwrite: true })
            added++
        } catch (err) {
            console.error('모드를 옮기지 못했습니다: ' + f.name, err)
        }
    }
    return added
}


// 파일 선택 대화상자로 고른 파일을 모드 폴더로 복사합니다.
exports.addDropinModPaths = function(paths, modsdir) {

    exports.validateDir(modsdir)

    let added = 0
    for(const sourcePath of paths) {
        const fileName = path.basename(sourcePath)
        if(MOD_REGEX.exec(fileName) == null) {
            continue
        }
        try {
            fs.copySync(sourcePath, path.join(modsdir, fileName), { overwrite: true })
            added++
        } catch (err) {
            console.error('모드를 복사하지 못했습니다: ' + fileName, err)
        }
    }
    return added
}


exports.deleteDropinMod = async function(modsDir, fullName){

    const target = path.join(modsDir, fullName)
    const res = await ipcRenderer.invoke(SHELL_OPCODE.TRASH_ITEM, target)

    if(res != null && res.result) {
        return true
    }

    // 휴지통을 쓸 수 없는 환경(권한, 네트워크 드라이브 등)에서는 바로 삭제합니다.
    // 호출하는 쪽에서 확인 창을 띄운 뒤에만 이 함수를 부릅니다.
    try {
        fs.removeSync(target)
        return true
    } catch (err) {
        shell.beep()
        console.error('Error deleting drop-in mod.', err)
        return false
    }
}


exports.toggleDropinMod = function(modsDir, fullName, enable){
    return new Promise((resolve, reject) => {
        const oldPath = path.join(modsDir, fullName)
        const newPath = path.join(modsDir, enable ? fullName.substring(0, fullName.indexOf(DISABLED_EXT)) : fullName + DISABLED_EXT)

        fs.rename(oldPath, newPath, (err) => {
            if(err){
                reject(err)
            } else {
                resolve()
            }
        })
    })
}


exports.isDropinModEnabled = function(fullName){
    return !fullName.endsWith(DISABLED_EXT)
}
