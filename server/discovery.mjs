/**
 * Locating things around Unity: which project, which mcp-unity package, which
 * server entry file, which bridge token.
 *
 * Everything here is written against the layout used by com.gamelovers.mcp-unity
 * 1.5.0+ (Unity 2022.3 LTS and newer, Unity 6 included) with best-effort fallbacks for older
 * package layouts. Nothing is hard-coded to one machine.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const MCP_UNITY_PACKAGE = 'com.gamelovers.mcp-unity'
export const SETTINGS_RELATIVE = join('ProjectSettings', 'McpUnitySettings.json')
export const TOKEN_RELATIVE = join('Library', 'McpUnity', 'bridge-token')
export const DEFAULT_PORT = 8090
export const DEFAULT_HOST = 'localhost'
export const TOKEN_PATTERN = /^[0-9a-f]{64}$/i

const MAX_SCAN_DEPTH = 3
const MAX_SCAN_ENTRIES = 4000

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function unquote(value) {
  let text = value.trim().replace(/\r$/, '')
  const first = text[0]
  if ((first === '"' || first === "'") && text.length > 1 && text.at(-1) === first) {
    text = text.slice(1, -1)
  }
  return text.trim()
}

export function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function readTextFile(file) {
  try {
    return stripBom(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Pull `-projectPath <dir>` out of a Unity `Editor.log`.
 *
 * Unity writes the opened project as an argument of the editor process, either
 * as `-projectPath C:\dir\project` on one line or with the value on the next
 * line. The last session started wins, so we scan from the end.
 */
export function parseEditorLogProjectPath(logText) {
  if (!logText) return null
  const marker = 'COMMAND LINE ARGUMENTS:'
  let index = logText.lastIndexOf(marker)
  while (index !== -1) {
    const block = logText.slice(index + marker.length).split(/\r?\n/)
    const found = projectPathInArguments(block)
    if (found) return found
    // `lastIndexOf` clamps a negative position to 0, so guard the boundary or a
    // marker at offset 0 would loop forever.
    if (index === 0) break
    index = logText.lastIndexOf(marker, index - 1)
  }
  return null
}

function projectPathInArguments(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line) continue
    const match = /^-projectpath(?:\s*=\s*|\s+|$)(.*)$/i.exec(line)
    if (!match) continue
    let value = match[1].trim()
    if (!value) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j].trim()
        if (!next) continue
        if (next.startsWith('-')) break
        value = next
        break
      }
    }
    const path = unquote(value)
    if (path) return path
  }
  return null
}

/** Editor-log locations Unity keeps per platform, newest first. */
export function editorLogPaths(platform = process.platform, env = process.env, home = homedir()) {
  const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
  if (platform === 'win32') {
    return [
      join(localAppData, 'Unity', 'Editor', 'Editor.log'),
      join(localAppData, 'Unity', 'Editor', 'Editor-prev.log'),
    ]
  }
  if (platform === 'darwin') {
    return [
      join(home, 'Library', 'Logs', 'Unity', 'Editor.log'),
      join(home, 'Library', 'Logs', 'Unity', 'Editor-prev.log'),
    ]
  }
  return [
    join(env.XDG_CONFIG_HOME || join(home, '.config'), 'unity3d', 'Editor.log'),
    join(env.XDG_CONFIG_HOME || join(home, '.config'), 'unity3d', 'Editor-prev.log'),
  ]
}

/** Read the most recent Unity editor log that mentions a project path. */
export function projectPathFromEditorLogs(paths = editorLogPaths()) {
  for (const file of paths) {
    if (!existsSync(file)) continue
    const text = readTextFile(file)
    const found = parseEditorLogProjectPath(text)
    if (found) return { projectPath: found, logFile: file }
  }
  return null
}

export function readSettings(projectRoot) {
  const file = join(projectRoot, SETTINGS_RELATIVE)
  const text = existsSync(file) ? readTextFile(file) : null
  if (text === null) return { file, settings: null }
  try {
    return { file, settings: JSON.parse(text) }
  } catch {
    return { file, settings: null }
  }
}

export function readToken(projectRoot) {
  const file = join(projectRoot, TOKEN_RELATIVE)
  const text = existsSync(file) ? readTextFile(file) : null
  if (text === null) return { file, token: null }
  const token = text.trim()
  return { file, token: TOKEN_PATTERN.test(token) ? token : null }
}

/** Port / host the Unity package is configured to listen on. */
export function bridgeEndpoint(settings, env = process.env) {
  const port = numberOr(env.UNITY_PORT, numberOr(settings?.Port, DEFAULT_PORT))
  const host = trimmed(env.UNITY_HOST) || trimmed(settings?.Host) || DEFAULT_HOST
  return { host, port }
}

function numberOr(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Host text as the mcp-unity server needs it.
 *
 * The server builds its WebSocket URL by string concatenation
 * (`ws://${host}:${port}/McpUnity`), so an IPv6 literal has to keep its
 * brackets. Accepts a host that already has them, and falls back to
 * `localhost` when nothing usable is configured.
 */
export function formatHost(host) {
  const text = trimmed(host)
  if (!text) return DEFAULT_HOST
  const bare = text.replace(/^\[/, '').replace(/\]$/, '')
  return bare.includes(':') ? `[${bare}]` : bare
}

/**
 * Classify a pinned `MCP_UNITY_PROJECT` value before the scan is skipped for it.
 *
 * `problem` is `'missing'` when the path is not a directory, `'not-unity'` when
 * it is a directory without the `Assets` + `ProjectSettings` pair, and `null`
 * for a usable project. `projectRootOf` accepts a subfolder, so pinning
 * `.../MyProject/Assets` keeps working.
 */
export function classifyExplicitProject(path) {
  const root = projectRootOf(path)
  if (root) return { root, problem: null }
  const target = resolve(trimmed(path) || '.')
  return { root: null, problem: isDirectory(target) ? 'not-unity' : 'missing' }
}

function versionSortKey(name, dir) {
  try {
    return statSync(dir).mtimeMs
  } catch {
    return 0
  }
}

/** The mcp-unity entry of `Packages/packages-lock.json`, when present. */
function lockEntry(projectRoot) {
  const file = join(projectRoot, 'Packages', 'packages-lock.json')
  try {
    const data = JSON.parse(stripBom(readFileSync(file, 'utf8')))
    const entry = data?.dependencies?.[MCP_UNITY_PACKAGE]
    return entry && typeof entry === 'object' ? entry : null
  } catch {
    return null
  }
}

/**
 * Cache directory names pinned by `Packages/packages-lock.json`, best first.
 *
 * Unity keeps every package version it ever resolved in `Library/PackageCache`,
 * so after `Packages/manifest.json` points at a newer commit the stale copies
 * are still there. The lock file is the authority: git packages are cached as
 * `<name>@<short hash>`, registry packages as `<name>@<version>`.
 */
export function lockedCacheNames(projectRoot) {
  const entry = lockEntry(projectRoot)
  if (!entry) return [MCP_UNITY_PACKAGE]

  const names = []
  const source = typeof entry.source === 'string' ? entry.source : ''
  const hash = typeof entry.hash === 'string' ? entry.hash.trim() : ''
  const version = typeof entry.version === 'string' ? entry.version.trim() : ''

  if (source === 'git' && /^[0-9a-f]{7,40}$/i.test(hash)) {
    // Unity truncates the resolved revision to ten characters in the directory name.
    for (const length of [10, 12, 7]) names.push(`${MCP_UNITY_PACKAGE}@${hash.slice(0, length)}`)
  }
  if (version && !/^(https?:|git\+|git:|file:|ssh:)/i.test(version) && /\d/.test(version)) {
    names.push(`${MCP_UNITY_PACKAGE}@${version}`)
  }
  names.push(MCP_UNITY_PACKAGE)
  return names
}

/** Version of the mcp-unity package that owns `dir`, or null. */
export function packageVersion(dir) {
  const candidates = [dir, dirname(dir), dirname(dirname(dir))]
  for (const base of candidates) {
    try {
      const manifest = JSON.parse(stripBom(readFileSync(join(base, 'package.json'), 'utf8')))
      if (manifest?.name === MCP_UNITY_PACKAGE && typeof manifest.version === 'string') {
        return manifest.version
      }
      if (!manifest?.name && typeof manifest.version === 'string') return manifest.version
    } catch {
      /* keep walking up */
    }
  }
  return null
}

/** Numeric comparison of dotted versions; non-numeric input counts as 0. */
export function compareVersions(left, right) {
  const parse = (value) =>
    String(value ?? '')
      .split(/[.+-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0)
  }
  return 0
}

/**
 * Directories that may hold the mcp-unity server, best candidate first:
 * the package cache copy the lock file pins, then any other cached copy, then an
 * embedded `Packages/` copy. `Server~` is the folder that ships `package.json` +
 * `build/` for 1.5.0+; older layouts keep the server at the package root.
 */
export function serverDirectories(projectRoot) {
  const found = []
  const push = (dir) => {
    if (dir && existsSync(dir) && !found.includes(dir)) found.push(dir)
  }

  const packageCache = join(projectRoot, 'Library', 'PackageCache')
  let names = []
  try {
    names = readdirSync(packageCache).filter(
      (name) => name === MCP_UNITY_PACKAGE || name.startsWith(`${MCP_UNITY_PACKAGE}@`),
    )
  } catch {
    names = []
  }

  const locked = lockedCacheNames(projectRoot).filter((name) => names.includes(name))
  const rest = names
    .filter((name) => !locked.includes(name))
    .sort((a, b) => versionSortKey(b, join(packageCache, b)) - versionSortKey(a, join(packageCache, a)))

  for (const name of [...locked, ...rest]) {
    const base = join(packageCache, name)
    push(join(base, 'Server~'))
    push(join(base, 'Server'))
    push(base)
  }

  const embedded = join(projectRoot, 'Packages', MCP_UNITY_PACKAGE)
  push(join(embedded, 'Server~'))
  push(join(embedded, 'Server'))
  push(embedded)

  return found
}

/** The JS entry file of a server directory, or null. */
export function findServerEntry(serverDir) {
  const manifestPath = join(serverDir, 'package.json')
  let bin = null
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readTextFile(manifestPath) || '{}')
      if (typeof manifest.bin === 'string') bin = manifest.bin
      else if (manifest.bin && typeof manifest.bin === 'object') {
        bin = Object.values(manifest.bin).find((value) => typeof value === 'string') ?? null
      }
    } catch {
      bin = null
    }
  }

  const candidates = []
  if (bin) candidates.push(join(serverDir, bin))
  candidates.push(
    join(serverDir, 'build', 'index.js'),
    join(serverDir, 'build', 'server.js'),
    join(serverDir, 'build', 'index.mjs'),
    join(serverDir, 'dist', 'index.js'),
    join(serverDir, 'dist', 'server.js'),
    join(serverDir, 'index.js'),
    join(serverDir, 'index.mjs'),
    join(serverDir, 'src', 'index.js'),
  )
  for (const file of candidates) {
    try {
      if (statSync(file).isFile()) return file
    } catch {
      /* keep looking */
    }
  }
  return null
}

export function looksLikeUnityProject(dir) {
  return isDirectory(join(dir, 'ProjectSettings')) && isDirectory(join(dir, 'Assets'))
}

/** `path` itself, its parent, or its grandparent may be the project root. */
export function projectRootOf(path) {
  let current = resolve(path)
  for (let depth = 0; depth < 3; depth += 1) {
    if (looksLikeUnityProject(current)) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

function defaultSearchRoots() {
  const roots = []
  if (process.platform === 'win32') {
    const drives = ['C:', 'D:', 'E:', 'F:']
    const user = process.env.USERPROFILE || homedir()
    for (const drive of drives) {
      roots.push(join(drive, 'Unity'))
      roots.push(join(drive, 'UnityProject'))
      roots.push(join(drive, 'UnityProjects'))
      roots.push(join(drive, 'Projects'))
    }
    roots.push(join(user, 'Unity'))
    roots.push(join(user, 'Documents', 'Unity'))
    roots.push(join(user, 'Documents', 'UnityProjects'))
  } else {
    const home = homedir()
    roots.push(join(home, 'Unity'))
    roots.push(join(home, 'UnityProjects'))
    roots.push(join(home, 'Documents', 'Unity'))
    roots.push(join(home, 'Projects'))
  }
  return roots
}

function scanForProjects(root, depth, budget, out) {
  if (depth > MAX_SCAN_DEPTH || budget.remaining <= 0) return
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (budget.remaining <= 0) return
    if (!entry.isDirectory()) continue
    const name = entry.name
    if (name.startsWith('.') || name === 'node_modules' || name === 'Library' || name === 'Temp') {
      continue
    }
    budget.remaining -= 1
    const dir = join(root, name)
    if (isDirectory(join(dir, 'ProjectSettings')) && isDirectory(join(dir, 'Assets'))) {
      out.push(dir)
      continue
    }
    scanForProjects(dir, depth + 1, budget, out)
  }
}

/**
 * Every plausible Unity project, ordered by how strongly it is signalled:
 * explicit env override, then the settings file location, then the project the
 * editor opened last, then a bounded directory scan.
 *
 * The editor log is only a hint: it names the project the *last* editor session
 * opened, which is often not the one with the mcp-unity package installed. So
 * we keep scanning whenever the hints cannot produce a usable bridge.
 */
export function collectProjectCandidates(options = {}) {
  const env = options.env ?? process.env
  const log = options.log ?? (() => {})
  const candidates = []
  const seen = new Set()

  const add = (dir, source) => {
    if (!dir) return
    const root = projectRootOf(dir)
    if (!root) return
    const key = process.platform === 'win32' ? root.toLowerCase() : root
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ root, source })
  }

  const explicit = trimmed(env.MCP_UNITY_PROJECT)
  if (explicit) {
    add(resolve(explicit), 'MCP_UNITY_PROJECT')
    return candidates
  }

  const settingsPath = trimmed(env.MCP_UNITY_SETTINGS_PATH)
  if (settingsPath) add(dirname(dirname(resolve(settingsPath))), 'MCP_UNITY_SETTINGS_PATH')

  let editorLogHint = null
  const fromLog = projectPathFromEditorLogs(
    options.editorLogPaths ?? editorLogPaths(process.platform, env, options.home ?? homedir()),
  )
  if (fromLog) {
    editorLogHint = fromLog
    add(fromLog.projectPath, `Unity editor log (${fromLog.logFile})`)
  }

  const usable = () => candidates.filter((candidate) => hasServer(candidate.root))
  const ready = () =>
    candidates.filter((candidate) => {
      const { settings } = readSettings(candidate.root)
      return settings && readToken(candidate.root).token
    })

  const scanForced = ['1', 'true', 'yes', 'on'].includes(trimmed(env.MCP_UNITY_SCAN).toLowerCase())
  if (scanForced || usable().length === 0 || ready().length === 0) {
    const searchRoots = []
    const configured = trimmed(env.MCP_UNITY_SEARCH_ROOTS)
    if (configured) {
      for (const part of configured.split(/[;,]/)) {
        const dir = trimmed(part)
        if (dir) searchRoots.push(resolve(dir))
      }
    } else {
      if (editorLogHint) searchRoots.push(dirname(resolve(editorLogHint.projectPath)))
      for (const dir of defaultSearchRoots()) if (isDirectory(dir)) searchRoots.push(dir)
    }

    const budget = { remaining: MAX_SCAN_ENTRIES }
    const scanned = []
    for (const root of searchRoots) {
      if (!isDirectory(root)) continue
      if (looksLikeUnityProject(root)) scanned.push(root)
      else scanForProjects(root, 1, budget, scanned)
    }
    for (const dir of scanned) add(dir, 'filesystem scan')
    if (scanned.length > 0) log(`scanned the filesystem and found ${scanned.length} Unity project(s)`)
  }

  return candidates
}

/** True when the mcp-unity server is installed inside this project. */
export function hasServer(projectRoot) {
  return serverDirectories(projectRoot).some((dir) => findServerEntry(dir) !== null)
}

/** Best guess at when the editor last used this project (0 when unknown). */
export function lastUsedMs(projectRoot) {
  const stamps = []
  const push = (file) => {
    try {
      stamps.push(statSync(file).mtimeMs)
    } catch {
      /* ignore */
    }
  }
  push(join(projectRoot, TOKEN_RELATIVE))
  push(join(projectRoot, SETTINGS_RELATIVE))
  push(join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt'))
  return stamps.length > 0 ? Math.max(...stamps) : 0
}

/** Everything the launcher needs to know about one candidate project. */
export function describeProject(root, source) {
  const servers = serverDirectories(root)
  let serverDir = null
  let serverEntry = null
  for (const dir of servers) {
    const entry = findServerEntry(dir)
    if (entry) {
      serverDir = dir
      serverEntry = entry
      break
    }
  }
  const { file: settingsFile, settings } = readSettings(root)
  const { file: tokenFile, token } = readToken(root)
  return {
    root,
    source,
    servers,
    serverDir,
    serverEntry,
    settingsFile: existsSync(settingsFile) ? settingsFile : null,
    settings,
    tokenFile: existsSync(tokenFile) ? tokenFile : null,
    token,
    endpoint: bridgeEndpoint(settings),
  }
}
