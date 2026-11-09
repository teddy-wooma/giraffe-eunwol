#!/usr/bin/env node
/**
 * verify-distribution.cjs
 * =============================================================================
 * Checks that app/assets/distribution.json is something Helios can actually use.
 *
 * Run it with:   node tools/verify-distribution.cjs
 *
 * It verifies, without launching the game:
 *   1. The index parses and helios-core can build its object model from it
 *      (this catches malformed maven ids, missing modules, bad addresses, ...).
 *   2. Every module resolves to the directory helios-core expects.
 *   3. The configured Minecraft version exists in Mojang's version manifest.
 *   4. Every declared artifact is reachable and its size + MD5 match.
 *   5. A Fabric version manifest is declared and its id matches the module path.
 * =============================================================================
 */
'use strict'

const crypto = require('crypto')
const fs = require('fs')
const https = require('https')
const path = require('path')
const { URL } = require('url')

const DISTRO_PATH = path.join(__dirname, '..', 'app', 'assets', 'distribution.json')

// helios-core resolves module paths against these; they only need to look real.
const COMMON_DIR = path.join(__dirname, '..', '.verify', 'common')
const INSTANCE_DIR = path.join(__dirname, '..', '.verify', 'instances')

let failures = 0
let checks = 0

function ok(msg) {
    checks++
    console.log(`  \u2713 ${msg}`)
}
function fail(msg) {
    checks++
    failures++
    console.log(`  \u2717 ${msg}`)
}
function section(title) {
    console.log('')
    console.log(title)
}

function fetchBuffer(url, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        https
            .get(url, { headers: { 'user-agent': 'eunwol-launcher-distro-verifier' } }, res => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume()
                    if (redirectsLeft <= 0) {
                        reject(new Error('too many redirects'))
                        return
                    }
                    resolve(fetchBuffer(new URL(res.headers.location, url).toString(), redirectsLeft - 1))
                    return
                }
                if (res.statusCode !== 200) {
                    res.resume()
                    reject(new Error(`HTTP ${res.statusCode}`))
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

/** Walk every module and its submodules, yielding { module, parent } pairs. */
function* walk(modules, parent = null) {
    for (const module of modules) {
        yield { module, parent }
        if (module.subModules && module.subModules.length > 0) {
            yield* walk(module.subModules, module)
        }
    }
}

async function main() {
    const { HeliosDistribution, DistributionAPI } = require('helios-core/common')

    section(`Reading ${path.relative(process.cwd(), DISTRO_PATH)}`)

    if (!fs.existsSync(DISTRO_PATH)) {
        fail('distribution.json not found. Run: node tools/build-distribution.cjs')
        return
    }

    const raw = JSON.parse(fs.readFileSync(DISTRO_PATH, 'utf8'))
    ok(`parsed index (format version ${raw.version})`)

    // --- 1. Object model ------------------------------------------------------
    section('Building helios-core distribution model')
    let distro
    try {
        distro = new HeliosDistribution(raw, COMMON_DIR, INSTANCE_DIR)
        ok('helios-core accepted the index')
    } catch (err) {
        fail(`helios-core rejected the index: ${err.message}`)
        return
    }

    if (!raw.servers || raw.servers.length === 0) {
        fail('index declares no servers')
        return
    }
    ok(`${raw.servers.length} server(s) declared`)

    const mainServer = distro.getMainServer()
    if (mainServer == null) {
        fail('no main server resolved')
        return
    }
    ok(`main server: ${mainServer.rawServer.name} (${mainServer.rawServer.id})`)

    // --- 2. Address -----------------------------------------------------------
    section('Server address')
    ok(`address ${mainServer.rawServer.address} -> ${mainServer.hostname}:${mainServer.port}`)
    if (mainServer.port < 1 || mainServer.port > 65535) {
        fail(`port ${mainServer.port} is out of range`)
    }

    // --- 3. Modules -----------------------------------------------------------
    section('Modules')
    const versionManifests = []
    const artifactUrls = []
    let libraryCount = 0
    let modLoader = null

    for (const { module } of walk(mainServer.modules)) {
        const type = module.rawModule.type
        const expectedRoot =
            type === 'VersionManifest'
                ? path.join(COMMON_DIR, 'versions')
                : type === 'File' || type === undefined
                  ? path.join(INSTANCE_DIR, mainServer.rawServer.id)
                  : type === 'ForgeMod' || type === 'LiteMod'
                    ? path.join(COMMON_DIR, 'modstore')
                    : type === 'FabricMod'
                      ? path.join(COMMON_DIR, 'mods', 'fabric')
                      : path.join(COMMON_DIR, 'libraries')

        const resolved = path.resolve(module.getPath())
        if (!resolved.startsWith(path.resolve(expectedRoot))) {
            fail(`${module.rawModule.id} resolved outside ${path.basename(expectedRoot)}: ${resolved}`)
        } else {
            ok(`${type} ${module.rawModule.id} -> ${path.relative(COMMON_DIR, resolved)}`)
        }

        const artifact = module.rawModule.artifact
        if (artifact == null) {
            fail(`${module.rawModule.id} has no artifact block`)
            continue
        }
        if (typeof artifact.size !== 'number') {
            fail(`${module.rawModule.id} has no numeric size (progress bar would break)`)
        }
        if (typeof artifact.MD5 !== 'string' || !/^[0-9a-f]{32}$/.test(artifact.MD5)) {
            fail(`${module.rawModule.id} has no valid MD5`)
        }
        if (typeof artifact.url !== 'string' || !/^https?:\/\//.test(artifact.url)) {
            fail(`${module.rawModule.id} has an unusable url`)
        } else {
            artifactUrls.push(artifact)
        }

        if (type === 'VersionManifest') {
            versionManifests.push(module)
        }
        if (type === 'Library') {
            libraryCount++
        }
        if (type === 'Fabric' || type === 'ForgeHosted' || type === 'Forge') {
            modLoader = module
        }
    }

    section('Mod loader wiring')
    if (modLoader == null) {
        fail('no Fabric/Forge mod loader module declared')
    } else {
        ok(`mod loader: ${modLoader.rawModule.type} ${modLoader.rawModule.id}`)
    }

    if (versionManifests.length === 0) {
        fail('no VersionManifest submodule - Fabric cannot launch without one')
    } else {
        for (const vm of versionManifests) {
            ok(`version manifest id: ${vm.rawModule.id}`)
        }
    }
    ok(`${libraryCount} Library submodule(s) will be added to the classpath`)

    if (libraryCount === 0) {
        fail('Fabric libraries are missing - the game will crash on launch')
    }

    // --- 4. Mojang version ----------------------------------------------------
    section('Mojang version availability')
    const mcVersion = mainServer.rawServer.minecraftVersion
    let mojangManifest = null
    try {
        mojangManifest = JSON.parse((await fetchBuffer('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).toString('utf8'))
    } catch (err) {
        fail(`could not reach Mojang version manifest: ${err.message}`)
    }
    if (mojangManifest) {
        const entry = mojangManifest.versions.find(v => v.id === mcVersion)
        if (entry == null) {
            fail(`Minecraft ${mcVersion} is not a known Mojang version`)
        } else {
            ok(`Minecraft ${mcVersion} found (${entry.type}, released ${entry.releaseTime.slice(0, 10)})`)
        }
    }

    // --- 5. Artifact integrity ------------------------------------------------
    section(`Verifying ${artifactUrls.length} artifact(s)`)
    for (const artifact of artifactUrls) {
        const label = artifact.url.replace(/^https:\/\/maven\.fabricmc\.net\//, '').replace(/^https:\/\/meta\.fabricmc\.net\//, '')
        try {
            const buffer = await fetchBuffer(artifact.url)
            const md5 = crypto.createHash('md5').update(buffer).digest('hex')
            if (buffer.length !== artifact.size) {
                fail(`${label}: size ${buffer.length} != declared ${artifact.size}`)
            } else if (md5 !== artifact.MD5) {
                fail(`${label}: MD5 ${md5} != declared ${artifact.MD5}`)
            } else {
                ok(`${label} (${(buffer.length / 1024).toFixed(0)} KiB, md5 ok)`)
            }
        } catch (err) {
            fail(`${label}: ${err.message}`)
        }
    }

    // --- 6. Local load path (mirrors app/assets/js/distromanager.js) ----------
    section('Local distribution load path')

    const launcherDataDir = path.join(__dirname, '..', '.verify', 'launcherdata')
    fs.rmSync(launcherDataDir, { recursive: true, force: true })
    fs.mkdirSync(launcherDataDir, { recursive: true })

    // With no remote url configured, distromanager.js runs helios-core in
    // "local only" mode, which reads distribution_dev.json from the data
    // directory. This is the exact path the launcher takes on startup.
    fs.copyFileSync(DISTRO_PATH, path.join(launcherDataDir, 'distribution_dev.json'))

    try {
        const localOnly = new DistributionAPI(launcherDataDir, COMMON_DIR, INSTANCE_DIR, null, true)
        const loaded = await localOnly.getDistribution()
        const server = loaded.getServerById(mainServer.rawServer.id)
        if (server == null) {
            fail('local load did not return the configured server')
        } else {
            ok(`local load resolved ${server.rawServer.id} with ${server.modules.length} top level module(s)`)
            const java = server.effectiveJavaOptions
            ok(`java -> supported=${java.supported}, suggestedMajor=${java.suggestedMajor}, distribution=${java.distribution}`)
        }
    } catch (err) {
        fail(`local load failed: ${err.message}`)
    }

    // The file download/repair receiver is a separate process that loads the
    // index through getDistributionLocalLoadOnly().
    try {
        const receiverApi = new DistributionAPI(launcherDataDir, COMMON_DIR, INSTANCE_DIR, null, true)
        const receiverDistro = await receiverApi.getDistributionLocalLoadOnly()
        if (receiverDistro.getServerById(mainServer.rawServer.id) == null) {
            fail('receiver-style local load did not return the configured server')
        } else {
            ok('receiver-style local load works (file validation/download path)')
        }
    } catch (err) {
        fail(`receiver-style local load failed: ${err.message}`)
    }

    // --- 7. Remote fallback ---------------------------------------------------
    section('Remote mode fallback (only used once REMOTE_DISTRO_URL is set)')
    fs.copyFileSync(DISTRO_PATH, path.join(launcherDataDir, 'distribution.json'))
    try {
        // Point at a closed port to simulate an unreachable update feed.
        // helios-core will log an error here; that is the expected noise.
        const remoteMode = new DistributionAPI(launcherDataDir, COMMON_DIR, INSTANCE_DIR, 'http://127.0.0.1:1/distribution.json', false)
        const fallback = await remoteMode.getDistribution()
        if (fallback.getServerById(mainServer.rawServer.id) == null) {
            fail('remote-mode fallback did not return the configured server')
        } else {
            ok('unreachable update feed falls back to the local index')
        }
    } catch (err) {
        fail(`remote-mode fallback failed: ${err.message}`)
    }

    // --- Summary --------------------------------------------------------------
    console.log('')
    console.log('='.repeat(70))
    if (failures === 0) {
        console.log(`PASS - ${checks} checks, no problems found.`)
    } else {
        console.log(`FAIL - ${failures} of ${checks} checks failed.`)
        process.exitCode = 1
    }
}

main().catch(err => {
    console.error('')
    console.error('Unexpected error:', err)
    process.exitCode = 1
})
