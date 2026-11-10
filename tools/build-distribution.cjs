#!/usr/bin/env node
/**
 * build-distribution.cjs
 * =============================================================================
 * `app/assets/distribution.json` (배포 인덱스)를 생성합니다.
 *
 *   node tools/build-distribution.cjs
 *
 * 하는 일:
 *   1. Fabric 메타 API 에서 설정한 마인크래프트 버전의 로더 프로파일을 받습니다.
 *   2. 프로파일에 들어 있는 라이브러리(asm, mixin ...)와 로더 jar 를 내려받아
 *      MD5·크기를 기록합니다. (런처가 이 값으로 파일을 검증/복구합니다)
 *   3. 완성된 인덱스를 app/assets/distribution.json 에 씁니다.
 *
 * 마인크래프트나 로더 버전을 바꾸면 이 스크립트를 다시 실행하세요.
 * 해시는 실제 파일에서 계산하므로 손으로 고칠 필요가 없습니다.
 * =============================================================================
 */
'use strict'

const crypto = require('crypto')
const fs = require('fs')
const https = require('https')
const path = require('path')
const { URL } = require('url')

// -----------------------------------------------------------------------------
// 설정
// -----------------------------------------------------------------------------
const CONFIG = {
    // 런처가 실행할 프로필. 서버에 접속하지 않는 "클린" 실행기이므로
    // address 는 쓰지 않지만 Helios 형식상 하나는 있어야 합니다.
    profile: {
        // 내부 id. 바꾸면 플레이어의 인스턴스 폴더가 새로 만들어집니다.
        id: 'eunwol',
        name: '은월',
        description: '기린월드 · giraffemc.com',
        address: 'giraffemc.com',
        minecraftVersion: '26.2',
        // PLAY 를 누르면 서버에 자동 접속합니다.
        autoconnect: true
    },

    // https://meta.fabricmc.net/v2/versions/loader/<mcVersion> 의 안정 버전.
    fabricLoaderVersion: '0.20.1',

    // Java 요구 사항. 마인크래프트 26.2 는 Java 25 런타임을 씁니다.
    // 런처가 맞는 JDK(Temurin)를 자동으로 내려받으므로,
    // 플레이어 PC 에 Java 가 없어도 실행할 수 있습니다.
    java: {
        supported: '>=25.x',
        suggestedMajor: 25,
        ram: {
            recommended: 4096, // MB. 512 의 배수여야 합니다.
            minimum: 2048
        }
    },

    // Discord Rich Presence. 자기 애플리케이션 id 가 있을 때만 켜세요.
    discord: null,

    // 소식 패널에 쓸 RSS 주소. null 이면 소식 기능을 쓰지 않습니다.
    rss: null,

    // 소식 패널에 쓸 커뮤니티 게시판 주소. null 이면 사용하지 않습니다.
    news: null,

    fabricMaven: 'https://maven.fabricmc.net/',
    fabricMeta: 'https://meta.fabricmc.net',
    userAgent: 'eunwol-launcher-distro-builder',

    outputPath: path.join(__dirname, '..', 'app', 'assets', 'distribution.json'),

    // 커스텀 모드 jar 를 업로드할 CDN 경로(끝에 / 없이). dist-mods/ 안의 파일명 그대로 올리면 됩니다.
    modsBaseUrl: 'https://raw.githubusercontent.com/teddy-wooma/giraffe-eunwol/main/dist-mods',

    // 배포에 포함할 모드.
    //  - url  : 공개 저장소(Modrinth CDN, maven) 주소를 그대로 사용
    //  - file : dist-mods/ 안의 로컬 jar (modsBaseUrl 기준으로 업로드 후 배포)
    mods: [
        {
            id: 'net.fabricmc.fabric-api:fabric-api:0.161.0+26.2',
            name: 'Fabric API 0.161.0+26.2',
            url: 'https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/0.161.0%2B26.2/fabric-api-0.161.0%2B26.2.jar'
        },
        {
            id: 'com.terraformersmc:modmenu:20.0.3',
            name: 'Mod Menu 20.0.3',
            url: 'https://cdn.modrinth.com/data/mOgUt4GM/versions/iRo7AZXf/modmenu-20.0.3.jar'
        },
        {
            id: 'me.shedaniel.cloth:cloth-config:26.2.155',
            name: 'Cloth Config 26.2.155',
            url: 'https://cdn.modrinth.com/data/9s6osm5g/versions/Nv3xnWXd/cloth-config-26.2.155.jar'
        },
        {
            id: 'generated:autorun:2.0.0',
            name: 'Auto-Run 2.0.0',
            url: 'https://cdn.modrinth.com/data/2i7tg1Wv/versions/TSZ0XkU4/autorun-mc26.2-v2.0.0.jar'
        },
        {
            id: 'generated:clearwaterlava:26.2',
            name: 'Clear Water/Lava/PowderSnow 26.2',
            url: 'https://cdn.modrinth.com/data/UFRJve4V/versions/CfrLhK7U/ClearWaterLava-Fabric-26.2.jar'
        },
        {
            id: 'generated:commandkeys:3.103.2+26.2',
            name: 'Command Keys 3.103.2+26.2',
            url: 'https://cdn.modrinth.com/data/65UyswbY/versions/X2VJ6to4/commandkeys-fabric-3.103.2%2B26.2.jar'
        },
        {
            id: 'generated:multi-key-bindings:1.3.5+26.2',
            name: 'Multi Key Bindings 1.3.5+26.2',
            url: 'https://cdn.modrinth.com/data/2VF6JEnL/versions/gScg51wq/multi-key-bindings-1.3.5%2B26.2.jar'
        },
        {
            id: 'generated:mozzitrigger:1.3.2+26.2',
            name: 'Mozzi Trigger 1.3.2+26.2',
            file: 'dist-mods/MozziTrigger-1.3.2+26.2.jar'
        },
        {
            id: 'generated:gfactionbar:3.4.0+26.2',
            name: 'gfActionbar 3.4.0+26.2',
            file: 'dist-mods/gfactionbar-3.4.0+26.2.jar'
        },
        {
            id: 'generated:aquaticlog:2.0.0+26.2',
            name: 'Aquatic Log 2.0.0+26.2',
            file: 'dist-mods/aquaticlog-2.0.0+26.2.jar'
        },
        {
            id: 'generated:dawn:0.2.6',
            name: 'Dawn Loader 0.2.6',
            file: 'dist-mods/dawn-standalone.jar'
        },
        {
            id: 'generated:eunwol-telemetry:0.2.0',
            name: 'Eunwol Telemetry 0.2.0',
            file: 'dist-mods/eunwol-telemetry.jar'
        },
        {
            id: 'generated:bobby:5.2.15+mc26.2',
            name: 'Bobby 5.2.15',
            url: 'https://cdn.modrinth.com/data/M08ruV16/versions/KLiFVFju/bobby-5.2.15%2Bmc26.2.jar'
        },
        {
            id: 'generated:entity-model-features:3.3.12+26.2',
            name: 'Entity Model Features 3.3.12',
            url: 'https://cdn.modrinth.com/data/4I1XuqiY/versions/hyDf8pNd/entity_model_features-3.3.12-26.2-fabric.jar'
        },
        {
            id: 'generated:entity-texture-features:7.2.7+26.2',
            name: 'Entity Texture Features 7.2.7',
            url: 'https://cdn.modrinth.com/data/BVzZfTc1/versions/nJCXY7Tp/entity_texture_features-7.2.7-26.2-fabric.jar'
        },
        {
            id: 'generated:entityculling:1.11.3',
            name: 'Entity Culling 1.11.3',
            url: 'https://cdn.modrinth.com/data/NNAgCjsB/versions/uXe0pIaz/entityculling-fabric-1.11.3-mc26.2.jar'
        },
        {
            id: 'generated:ferrite-core:9.0.0',
            name: 'FerriteCore 9.0.0',
            url: 'https://cdn.modrinth.com/data/uXXizFIs/versions/d5ddUdiB/ferritecore-9.0.0-fabric.jar'
        },
        {
            id: 'generated:iris:1.11.4+26.2',
            name: 'Iris Shaders 1.11.4',
            url: 'https://cdn.modrinth.com/data/YL57xq9U/versions/gxZWWnKH/iris-fabric-1.11.4%2Bmc26.2.jar'
        },
        {
            id: 'generated:sodium:0.9.2+mc26.2',
            name: 'Sodium 0.9.2',
            url: 'https://cdn.modrinth.com/data/AANobbMI/versions/xJZxADzI/sodium-fabric-0.9.2%2Bmc26.2.jar'
        },
        {
            id: 'generated:inventory-profiles-next:2.3.8',
            name: 'Inventory Profiles Next 2.3.8',
            url: 'https://cdn.modrinth.com/data/O7RBXm3n/versions/oQFRysLk/InventoryProfilesNext-fabric-26.2-2.3.8.jar'
        },
        {
            id: 'generated:libipn:6.9.0',
            name: 'libIPN 6.9.0',
            url: 'https://cdn.modrinth.com/data/onSQdWhM/versions/gCGiN7gp/libIPN-fabric-26.2-6.9.0.jar'
        },
        {
            id: 'generated:malilib:0.29.6',
            name: 'MaLiLib 0.29.6',
            url: 'https://cdn.modrinth.com/data/GcWjdA9I/versions/KvjmGjAV/malilib-fabric-26.2-0.29.6.jar'
        },
        {
            id: 'generated:placeholder-api:3.1.0-beta.1+26.2',
            name: 'Text Placeholder API 3.1.0-beta.1',
            url: 'https://cdn.modrinth.com/data/eXts2L7r/versions/NDqH16LT/placeholder-api-3.1.0-beta.1%2B26.2.jar'
        },
        {
            id: 'generated:xaeros-minimap:26.6.2',
            name: "Xaero's Minimap 26.6.2",
            url: 'https://cdn.modrinth.com/data/1bokaNcj/versions/kYWdcLLn/xaerominimap-fabric-26.2-26.6.2.jar'
        },
        {
            id: 'generated:xaeros-world-map:1.47.2',
            name: "Xaero's World Map 1.47.2",
            url: 'https://cdn.modrinth.com/data/NcUtCpym/versions/W8qSt5Gs/xaeroworldmap-fabric-26.2-1.47.2.jar'
        },
        {
            id: 'generated:koreanchat:1.6',
            name: 'KoreanChat 1.6',
            url: 'https://cdn.modrinth.com/data/b6DSxiIM/versions/wTkcKegs/KoreanChat-1.6.jar'
        },
        {
            id: 'generated:shulkerboxtooltip:5.4.3+26.2',
            name: 'Shulker Box Tooltip 5.4.3',
            url: 'https://cdn.modrinth.com/data/2M01OLQq/versions/woHKruB1/shulkerboxtooltip-fabric-5.4.3%2B26.2.jar'
        },
        {
            id: 'generated:fabric-language-kotlin:1.14.2+26.2',
            name: 'Fabric Language Kotlin 1.14.2',
            url: 'https://cdn.modrinth.com/data/Ha28R6CL/versions/SKW1BTL3/fabric-language-kotlin-1.14.2%2Bkotlin.2.4.21.jar'
        },
        {
            id: 'generated:fancymenu:3.9.14+26.2',
            name: 'FancyMenu 3.9.14',
            url: 'https://cdn.modrinth.com/data/Wq5SjeWM/versions/2BXE3l12/fancymenu_fabric_3.9.14_MC_26.2.jar'
        },
        {
            id: 'generated:melody:1.0.17+26.2',
            name: 'Melody 1.0.17',
            url: 'https://cdn.modrinth.com/data/CVT4pFB2/versions/ItVQn1cW/melody_fabric_1.0.17_MC_26.2.jar'
        },
        {
            id: 'generated:konkrete:1.11.1+26.2',
            name: 'Konkrete 1.11.1',
            url: 'https://cdn.modrinth.com/data/J81TRJWm/versions/Ra1AWDOa/konkrete_fabric_1.11.1_MC_26.2.jar'
        },
    ]
}

// 서버 목록 아이콘 (외부 이미지 호스팅 없이 쓰는 인라인 SVG, 은월 씰)
const PROFILE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<defs><radialGradient id="g" cx="42%" cy="38%" r="70%">
<stop offset="0" stop-color="#2e4468"/><stop offset="0.6" stop-color="#18263f"/><stop offset="1" stop-color="#070b14"/>
</radialGradient></defs>
<rect width="128" height="128" rx="26" fill="url(#g)"/>
<circle cx="64" cy="64" r="47" fill="none" stroke="#e6eefc" stroke-opacity="0.85" stroke-width="2.5"/>
<path d="M78 30a36 36 0 1 0 0 68 30 30 0 1 1 0-68z" fill="#e9f1fc"/>
<circle cx="44" cy="42" r="1.8" fill="#dfe9f7"/>
<circle cx="92" cy="56" r="1.4" fill="#dfe9f7"/>
<circle cx="86" cy="92" r="1.6" fill="#dfe9f7"/>
</svg>`

// -----------------------------------------------------------------------------
// 유틸
// -----------------------------------------------------------------------------

function fetchBuffer(url, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        https
            .get(url, { headers: { 'user-agent': CONFIG.userAgent } }, res => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume()
                    if (redirectsLeft <= 0) {
                        reject(new Error(`Too many redirects for ${url}`))
                        return
                    }
                    resolve(fetchBuffer(new URL(res.headers.location, url).toString(), redirectsLeft - 1))
                    return
                }
                if (res.statusCode !== 200) {
                    res.resume()
                    reject(new Error(`HTTP ${res.statusCode} for ${url}`))
                    return
                }
                const chunks = []
                res.on('data', c => chunks.push(c))
                res.on('end', () => resolve(Buffer.concat(chunks)))
                res.on('error', reject)
            })
            .on('error', reject)
    })
}

function md5Of(buffer) {
    return crypto.createHash('md5').update(buffer).digest('hex')
}

/** maven 좌표 파싱: group:artifact:version[:classifier][@extension] */
function parseMaven(name) {
    const [coords, ext] = name.split('@')
    const [group, artifact, version, classifier] = coords.split(':')
    return { group, artifact, version, classifier, extension: ext || 'jar' }
}

function mavenUrl(repo, c) {
    const groupPath = c.group.replace(/\./g, '/')
    const file = `${c.artifact}-${c.version}${c.classifier ? `-${c.classifier}` : ''}.${c.extension}`
    return `${repo}${groupPath}/${c.artifact}/${c.version}/${file}`
}

/** maven 아티팩트를 받아 { size, MD5, url } 아티팩트 블록을 만든다. */
async function describeArtifact(url) {
    const buffer = await fetchBuffer(url)
    return {
        size: buffer.length,
        MD5: md5Of(buffer),
        url
    }
}

function dataUri(mime, text) {
    return `data:${mime};base64,${Buffer.from(text, 'utf8').toString('base64')}`
}

// -----------------------------------------------------------------------------
// 빌드
// -----------------------------------------------------------------------------

async function main() {
    const { profile, fabricLoaderVersion, fabricMaven, fabricMeta } = CONFIG

    console.log(`Fabric 프로파일 조회: ${profile.minecraftVersion} / ${fabricLoaderVersion} ..`)
    const profileUrl = `${fabricMeta}/v2/versions/loader/${profile.minecraftVersion}/${fabricLoaderVersion}/profile/json`
    const profileBuffer = await fetchBuffer(profileUrl)
    const fabricProfile = JSON.parse(profileBuffer.toString('utf8'))

    if (fabricProfile.inheritsFrom !== profile.minecraftVersion) {
        throw new Error(
            `Fabric 프로파일이 ${fabricProfile.inheritsFrom} 를 상속합니다. ` +
                `${profile.minecraftVersion} 를 기대했습니다. 로더 버전을 확인하세요.`
        )
    }

    // 런처는 버전 매니페스트를 versions/<id>/<id>.json 으로 저장하고 그 id 로
    // 바닐라 버전을 찾으므로, Fabric 이 배포한 id 를 그대로 써야 합니다.
    const versionManifestId = fabricProfile.id

    const subModules = []
    const libraries = []

    // --- Fabric 라이브러리 ---------------------------------------------------
    for (const lib of fabricProfile.libraries) {
        const coords = parseMaven(lib.name)

        // fabric-loader 는 아래에서 부모 모듈로 따로 넣습니다.
        if (coords.group === 'net.fabricmc' && coords.artifact === 'fabric-loader') {
            continue
        }

        // Fabric 은 라이브러리마다 저장소 URL 을 주지만, 없으면 Fabric maven 을 씁니다.
        const repo = lib.url || fabricMaven
        const artifactUrl = mavenUrl(repo, coords)

        console.log(`  라이브러리 ${lib.name}`)
        const artifact = await describeArtifact(artifactUrl)

        subModules.push({
            id: lib.name,
            name: `Fabric (${coords.artifact})`,
            type: 'Library',
            artifact
        })
        libraries.push(lib.name)
    }

    // --- Fabric 버전 매니페스트 ---------------------------------------------
    subModules.push({
        id: versionManifestId,
        name: 'Fabric (version.json)',
        type: 'VersionManifest',
        artifact: {
            size: profileBuffer.length,
            MD5: md5Of(profileBuffer),
            url: profileUrl
        }
    })

    // --- Fabric 로더 jar (부모 모듈) ----------------------------------------
    const loaderCoords = parseMaven(`net.fabricmc:fabric-loader:${fabricLoaderVersion}`)
    const loaderUrl = mavenUrl(fabricMaven, loaderCoords)
    console.log(`  로더 ${loaderCoords.group}:${loaderCoords.artifact}:${loaderCoords.version}`)
    const loaderArtifact = await describeArtifact(loaderUrl)

    // --- 모드 ---------------------------------------------------------------
    const modModules = []
    for (const mod of CONFIG.mods) {
        let artifact

        if (mod.file) {
            const filePath = path.join(__dirname, '..', mod.file)
            const buffer = fs.readFileSync(filePath)
            artifact = {
                size: buffer.length,
                MD5: md5Of(buffer),
                url: `${CONFIG.modsBaseUrl}/${path.basename(filePath)}`
            }
            console.log(`  모드 ${mod.name} (로컬 ${mod.file})`)
        } else {
            console.log(`  모드 ${mod.name}`)
            artifact = await describeArtifact(mod.url)
        }

        modModules.push({
            id: mod.id,
            name: mod.name,
            type: 'FabricMod',
            artifact
        })
    }

    // --- 인덱스 조립 ---------------------------------------------------------
    const distro = {
        version: '1.0.0'
    }

    if (CONFIG.discord) {
        distro.discord = CONFIG.discord
    }
    if (CONFIG.rss) {
        distro.rss = CONFIG.rss
    }
    if (CONFIG.news) {
        distro.news = CONFIG.news
    }

    distro.servers = [
        {
            id: profile.id,
            name: profile.name,
            description: profile.description,
            icon: dataUri('image/svg+xml', PROFILE_ICON_SVG),
            version: '1.0.0',
            address: profile.address,
            minecraftVersion: profile.minecraftVersion,
            mainServer: true,
            autoconnect: profile.autoconnect,
            javaOptions: CONFIG.java,
            modules: [
                {
                    id: `net.fabricmc:fabric-loader:${fabricLoaderVersion}`,
                    name: `Fabric Loader ${fabricLoaderVersion}`,
                    type: 'Fabric',
                    artifact: loaderArtifact,
                    subModules
                },
                ...modModules
            ]
        }
    ]

    const outPath = CONFIG.outputPath
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, JSON.stringify(distro, null, 4) + '\n', 'utf8')

    console.log('')
    console.log(`저장: ${outPath}`)
    console.log(`  프로필    : ${profile.name} (${profile.id})`)
    console.log(`  마인크래프트: ${profile.minecraftVersion}`)
    console.log(`  Fabric    : ${fabricLoaderVersion}`)
    console.log(`  라이브러리 : ${libraries.length} + 버전 매니페스트`)
    console.log(`  로더 jar  : ${(loaderArtifact.size / 1024).toFixed(0)} KiB`)
    console.log('')
    console.log('다음: node tools/verify-distribution.cjs')
}

main().catch(err => {
    console.error('')
    console.error('실패:', err.message)
    process.exitCode = 1
})
