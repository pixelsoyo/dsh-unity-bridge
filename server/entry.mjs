#!/usr/bin/env node
/**
 * stdio launcher for DSH -> Unity.
 *
 * DSH starts this file as an MCP server (stdio transport). We do not implement
 * MCP ourselves: we find the user's Unity project, work out which mcp-unity
 * server copy belongs to the package installed in that project (so the bridge
 * protocol always matches the editor — Unity 2022.3 LTS and newer, Unity 6 included), point
 * the server at the right settings file and bridge token, and then import that
 * server so it speaks MCP on our stdout/stderr.
 *
 * stdout is reserved for the MCP protocol: every diagnostic goes to stderr,
 * which DSH records as `[host.stderr]` lines in its desktop log.
 */

import { basename } from 'node:path'
import { watch } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  classifyExplicitProject,
  collectProjectCandidates,
  compareVersions,
  describeProject,
  formatHost,
  lastUsedMs,
  packageVersion,
} from './discovery.mjs'
import { chooseByProbe } from './probe.mjs'

const PREFIX = '[unity-mcp]'

function log(...parts) {
  console.error(PREFIX, ...parts)
}

function envFlag(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase())
}

function fatal(headline, hints = []) {
  log(`ERROR: ${headline}`)
  for (const hint of hints) log(`  - ${hint}`)
  process.exit(1)
}

function describeCandidate(candidate) {
  return `${candidate.root} (${candidate.source})`
}

/**
 * Tell the user when Unity rewrites the settings or the token while this
 * process is already running: the port and the token are read once, at startup
 * (the mcp-unity server pins them too), so the fix is always "reload the plugin".
 * `persistent: false` keeps the watchers from holding the event loop open.
 */
function watchBridgeConfig(files) {
  for (const file of files) {
    if (!file) continue
    let lastSpoke = 0
    try {
      const watcher = watch(file, { persistent: false }, () => {
        const now = Date.now()
        if (now - lastSpoke < 2000) return
        lastSpoke = now
        log(`${basename(file)} changed on disk; reload this plugin so the bridge uses the new value.`)
      })
      watcher.on('error', () => {})
    } catch {
      /* watching is a nicety, never a startup requirement */
    }
  }
}

async function main() {
  // A pinned project skips the scan, so a typo in MCP_UNITY_PROJECT has to be
  // reported as such: falling through to "no Unity project was found" told the
  // user to pin the very variable they had already pinned.
  const pinned = (process.env.MCP_UNITY_PROJECT ?? '').trim()
  if (pinned) {
    const explicit = classifyExplicitProject(pinned)
    if (explicit.problem === 'missing') {
      fatal(`MCP_UNITY_PROJECT points at ${pinned}, which is not an existing folder.`, [
        'Fix the path in the `env` block of this plugin entry (cordis.patch.yml), or set it to',
        '  an empty string to let the plugin detect the project automatically.',
        'A Unity project root is the folder that holds `Assets` and `ProjectSettings`.',
      ])
    }
    if (explicit.problem === 'not-unity') {
      fatal(`MCP_UNITY_PROJECT points at ${pinned}, which is not a Unity project.`, [
        'Point it at the folder that contains `Assets` and `ProjectSettings` (a subfolder such as',
        '  `Assets` is fine too), then reload the plugin.',
      ])
    }
  }

  const candidates = collectProjectCandidates({ log })

  if (candidates.length === 0) {
    fatal(
      'no Unity project was found.',
      [
        'Open your Unity project (2022.3 LTS or newer; Unity 6 and later included) and make sure',
        '  `com.gamelovers.mcp-unity` is installed (Window > Package Manager > + > Add package from git URL),',
        '  then open Tools > MCP Unity > Server Window and press Start Server.',
        'Or pin the project explicitly with `MCP_UNITY_PROJECT: D:\\path\\to\\UnityProject`',
        '  in the `env` block of this plugin entry, and reload the plugin.',
      ],
    )
  }

  const described = candidates.map((candidate) => ({
    ...describeProject(candidate.root, candidate.source),
    lastUsed: lastUsedMs(candidate.root),
  }))
  const withServer = described.filter((candidate) => candidate.serverEntry)

  if (withServer.length === 0) {
    fatal(
      'found Unity projects but none of them has the mcp-unity server installed.',
      [
        ...candidates.slice(0, 5).map((candidate) => `Project: ${describeCandidate(candidate)}`),
        'Install or update `com.gamelovers.mcp-unity` in the project you want to drive, then',
        '  reload the plugin. The server lives in',
        '  Library/PackageCache/com.gamelovers.mcp-unity@*/Server~',
        '  (or Packages/com.gamelovers.mcp-unity/Server~ for an embedded checkout).',
      ],
    )
  }

  const ready = withServer
    .filter((candidate) => candidate.token && candidate.settings)
    .sort((a, b) => b.lastUsed - a.lastUsed)
  const probeEnabled = envFlag('MCP_UNITY_PROBE', true)

  let chosen = null
  let answeredBy = null
  if (probeEnabled && ready.length > 0) {
    if (ready.length > 1) {
      log(`${ready.length} projects are configured for the bridge; asking each editor...`)
    }
    const { candidate, host, attempted } = await chooseByProbe(ready)
    for (const entry of attempted) {
      log(`  ${entry.root} : port ${entry.port} -> ${entry.answered ? 'answered' : 'no answer'}`)
    }
    chosen = candidate
    answeredBy = host
  }

  if (!chosen) chosen = ready[0] ?? withServer[0]

  if (!chosen?.serverEntry) {
    fatal(`no mcp-unity server was found for ${chosen?.root ?? 'the selected Unity project'}.`, [
      `Project: ${chosen?.root ?? '(none)'}`,
      'Reinstall `com.gamelovers.mcp-unity` in that project (Window > Package Manager),',
      '  reopen it so Unity resolves `Library/PackageCache/com.gamelovers.mcp-unity@*/Server~`,',
      '  then reload this plugin.',
    ])
  }

  const version = packageVersion(chosen.serverDir)
  log(`mcp-unity    : ${version ?? 'unknown version'}`)

  if (version && compareVersions(version, '1.5.0') < 0) {
    fatal(
      `the installed mcp-unity package is ${version}, but the bridge token handshake needs 1.5.0 or newer.`,
      [
        `Project: ${chosen.root}`,
        'Update it in Window > Package Manager (the git URL in Packages/manifest.json),',
        '  reopen the project so Unity resolves the new commit, then reload this plugin.',
        'mcp-unity 1.5.0 added the Basic-auth token that the editor now requires; older',
        '  versions answer 401 or hang until the request timeout.',
      ],
    )
  }

  if (!chosen.token) {
    fatal(
      `the bridge token is missing for ${chosen.root}.`,
      [
        `Expected: ${chosen.tokenFile ?? 'Library/McpUnity/bridge-token'}`,
        'Open the project in Unity with the mcp-unity package enabled: the editor writes the',
        '  256-bit token on first start. Then reload the plugin (or restart DSH).',
        'If your project keeps its token elsewhere, set `MCP_UNITY_AUTH_TOKEN_PATH` in this',
        '  plugin entry to the token file.',
      ],
    )
  }

  if (!chosen.settings) {
    fatal(
      `the mcp-unity settings file is missing or unreadable for ${chosen.root}.`,
      [
        `Expected: ${chosen.settingsFile ?? 'ProjectSettings/McpUnitySettings.json'}`,
        'mcp-unity 1.5+ writes ProjectSettings/McpUnitySettings.json when the package loads.',
        'Update the package (Window > Package Manager), reopen the project, then reload this plugin.',
      ],
    )
  }

  const { port } = chosen.endpoint
  const envPort = (process.env.UNITY_PORT ?? '').trim()
  const portSource = envPort && String(port) === envPort ? 'UNITY_PORT' : 'McpUnitySettings.json'

  // Pin the port the probe verified, and the address it answered on. When the
  // probe is disabled the host comes from McpUnitySettings.json; either way it
  // has to be formatted for the server, which builds its URL by string
  // concatenation (`ws://${host}:${port}`), so an IPv6 literal needs brackets.
  process.env.UNITY_PORT = String(port)
  const pinnedHost = formatHost(answeredBy ?? chosen.endpoint.host)
  if (pinnedHost !== 'localhost') process.env.UNITY_HOST = pinnedHost
  process.env.MCP_UNITY_SETTINGS_PATH = chosen.settingsFile
  process.env.MCP_UNITY_AUTH_TOKEN_PATH = chosen.tokenFile

  log(`Unity project : ${chosen.root}`)
  log(`Package server: ${chosen.serverEntry}`)
  log(
    `Bridge        : ws://${process.env.UNITY_HOST ?? 'localhost'}:${port}/McpUnity (port from ${portSource})`,
  )

  try {
    process.chdir(chosen.root)
  } catch {
    /* not fatal: absolute paths are already in the environment */
  }

  watchBridgeConfig([chosen.settingsFile, chosen.tokenFile])

  if (probeEnabled) {
    log(
      answeredBy
        ? 'Unity editor is running and accepted the bridge token.'
        : 'Unity editor is not answering yet; the server reconnects on the first tool call.',
    )
    if (envPort && answeredBy === null) {
      log(
        `note: nothing answered on the port you forced (UNITY_PORT=${envPort}). Unity listens on`,
      )
      log(
        `  the port in ${chosen.settingsFile} (Tools > MCP Unity > Server Window); set the same`,
      )
      log('  value there, or drop UNITY_PORT from this plugin entry.')
    }
  }

  try {
    await import(pathToFileURL(chosen.serverEntry).href)
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      const missing = error.message.split('\n')[0]
      fatal(`the mcp-unity server could not start (${missing}).`, [
        `Server directory: ${chosen.serverDir}`,
        'If a dependency is missing, install it once: Tools > MCP Unity > Server Window >',
        `  Start Server (or \`npm install\` inside ${chosen.serverDir}), then reload this plugin.`,
        'If the missing module is this bundle\'s own `server/entry.mjs`, the Host stopped',
        '  spawning MCP servers from the profile directory: replace the relative `args` entry in',
        '  cordis.patch.yml with the absolute path of server/entry.mjs inside the installed',
        '  package.',
      ])
    }
    throw error
  }
}

main().catch((error) => {
  log('unexpected failure while starting the Unity bridge:')
  log(error?.stack ?? String(error))
  process.exit(1)
})
