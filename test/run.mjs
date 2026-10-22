/**
 * Self-contained test runner (no `node --test`, which spawns a child process
 * per file and is blocked in some sandboxed environments).
 *
 *   node test/run.mjs
 *
 * Every check prints to stderr immediately, so a hang is visible where it
 * happens.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  TOKEN_PATTERN,
  bridgeEndpoint,
  classifyExplicitProject,
  compareVersions,
  findServerEntry,
  formatHost,
  lockedCacheNames,
  looksLikeUnityProject,
  packageVersion,
  parseEditorLogProjectPath,
  projectRootOf,
  readSettings,
  readToken,
  serverDirectories,
} from '../server/discovery.mjs'
import { chooseByProbe } from '../server/probe.mjs'

const TOKEN = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef'
const results = { passed: 0, failed: 0 }

function check(name, fn) {
  try {
    fn()
    results.passed += 1
    process.stderr.write(`  ok   ${name}\n`)
  } catch (error) {
    results.failed += 1
    process.stderr.write(`  FAIL ${name}\n         ${error.message.split('\n')[0]}\n`)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    results.passed += 1
    process.stderr.write(`  ok   ${name}\n`)
  } catch (error) {
    results.failed += 1
    process.stderr.write(`  FAIL ${name}\n         ${error.message.split('\n')[0]}\n`)
  }
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-unity-bridge-'))
  return {
    root,
    write(relativePath, text) {
      const file = join(root, relativePath)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, text)
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

process.stderr.write('\ndiscovery.mjs\n')

check('token pattern accepts 64 hex characters only', () => {
  assert.ok(TOKEN_PATTERN.test(TOKEN))
  assert.ok(TOKEN_PATTERN.test('A'.repeat(64)))
  assert.ok(!TOKEN_PATTERN.test('a'.repeat(63)))
  assert.ok(!TOKEN_PATTERN.test('z'.repeat(64)))
  assert.ok(!TOKEN_PATTERN.test(`${'a'.repeat(63)} `))
})

check('editor log: value on the same line', () => {
  const log = [
    'COMMAND LINE ARGUMENTS:',
    'C:\\Program Files\\Unity\\Editor\\Unity.exe',
    '-projectpath D:\\Unity\\Projects\\Alpha',
    '-otherFlag',
  ].join('\n')
  assert.equal(parseEditorLogProjectPath(log), 'D:\\Unity\\Projects\\Alpha')
})

check('editor log: value on the following line and quoted', () => {
  const log = [
    'COMMAND LINE ARGUMENTS:',
    'C:/Unity/Editor/Unity.exe',
    '-projectPath',
    '"D:/Unity/UnityProject/RobotArm_DigitalTwin"',
    '-batchmode',
  ].join('\r\n')
  assert.equal(parseEditorLogProjectPath(log), 'D:/Unity/UnityProject/RobotArm_DigitalTwin')
})

check('editor log: -projectPath=value form', () => {
  const log = ['COMMAND LINE ARGUMENTS:', 'Unity.exe', '-projectPath=D:/Work/Beta'].join('\n')
  assert.equal(parseEditorLogProjectPath(log), 'D:/Work/Beta')
})

check('editor log: the most recent session wins', () => {
  const log = [
    'COMMAND LINE ARGUMENTS:',
    'Unity.exe',
    '-projectpath D:/Old/First',
    '',
    'Some other log output',
    'COMMAND LINE ARGUMENTS:',
    'Unity.exe',
    '-projectpath',
    'D:/New/Second',
  ].join('\n')
  assert.equal(parseEditorLogProjectPath(log), 'D:/New/Second')
})

check('editor log: no project path is null', () => {
  assert.equal(parseEditorLogProjectPath(''), null)
  assert.equal(parseEditorLogProjectPath('COMMAND LINE ARGUMENTS:\nUnity.exe\n-nographics'), null)
  assert.equal(parseEditorLogProjectPath(undefined), null)
})

check('bridge endpoint: environment wins over settings', () => {
  assert.deepEqual(bridgeEndpoint({ Port: 8090 }), { host: 'localhost', port: 8090 })
  assert.deepEqual(bridgeEndpoint({ Port: 8090 }, { UNITY_PORT: '9100' }), {
    host: 'localhost',
    port: 9100,
  })
  assert.deepEqual(bridgeEndpoint(null, { UNITY_HOST: ' 10.0.0.5 ' }), {
    host: '10.0.0.5',
    port: 8090,
  })
  assert.deepEqual(bridgeEndpoint({ Port: 'not-a-port' }), { host: 'localhost', port: 8090 })
})

check('the bridge host is formatted for the server URL builder', () => {
  // The server concatenates `ws://${host}:${port}`, so IPv6 must arrive bracketed.
  assert.equal(formatHost('::1'), '[::1]')
  assert.equal(formatHost('[::1]'), '[::1]')
  assert.equal(formatHost('fe80::1'), '[fe80::1]')
  assert.equal(formatHost(' 127.0.0.1 '), '127.0.0.1')
  assert.equal(formatHost('localhost'), 'localhost')
  assert.equal(formatHost(''), 'localhost')
  assert.equal(formatHost(undefined), 'localhost')
})

check('a pinned project path is classified before the scan is skipped', () => {
  const box = sandbox()
  try {
    assert.deepEqual(classifyExplicitProject(join(box.root, 'nope')), {
      root: null,
      problem: 'missing',
    })

    mkdirSync(join(box.root, 'plain'), { recursive: true })
    assert.deepEqual(classifyExplicitProject(join(box.root, 'plain')), {
      root: null,
      problem: 'not-unity',
    })

    box.write('Game/Assets/.keep', '')
    box.write('Game/ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3.62f3c1')
    const game = join(box.root, 'Game')
    assert.deepEqual(classifyExplicitProject(game), { root: game, problem: null })
    // Pinning a subfolder keeps working: the root is found by walking up.
    assert.deepEqual(classifyExplicitProject(join(game, 'Assets')), { root: game, problem: null })
  } finally {
    box.cleanup()
  }
})

check('settings and token are read from the project layout', () => {
  const box = sandbox()
  try {
    box.write('ProjectSettings/McpUnitySettings.json', '\ufeff{"Port":8111}')
    box.write('Library/McpUnity/bridge-token', `${TOKEN}\r\n`)

    assert.deepEqual(readSettings(box.root).settings, { Port: 8111 })
    assert.equal(readToken(box.root).token, TOKEN)

    box.write('Library/McpUnity/bridge-token', 'too-short')
    assert.equal(readToken(box.root).token, null)
  } finally {
    box.cleanup()
  }
})

check('server entry resolution prefers package.json bin, then known build paths', () => {
  const box = sandbox()
  try {
    const serverDir = join(box.root, 'Library/PackageCache/com.gamelovers.mcp-unity@abc/Server~')
    box.write(
      'Library/PackageCache/com.gamelovers.mcp-unity@abc/Server~/package.json',
      JSON.stringify({ name: 'mcp-unity-server', bin: { 'mcp-unity-server': './build/index.js' } }),
    )
    assert.equal(findServerEntry(serverDir), null)

    box.write('Library/PackageCache/com.gamelovers.mcp-unity@abc/Server~/build/index.js', '')
    assert.equal(findServerEntry(serverDir), join(serverDir, 'build', 'index.js'))

    const legacy = join(box.root, 'Packages/com.gamelovers.mcp-unity')
    box.write('Packages/com.gamelovers.mcp-unity/index.js', '')
    assert.equal(findServerEntry(legacy), join(legacy, 'index.js'))

    assert.equal(findServerEntry(join(box.root, 'nope')), null)
  } finally {
    box.cleanup()
  }
})

check('server directories are ordered: package cache Server~ first, embedded last', () => {
  const box = sandbox()
  try {
    box.write('Library/PackageCache/com.gamelovers.mcp-unity@a1/Server~/package.json', '{}')
    box.write('Library/PackageCache/com.gamelovers.mcp-unity@a2/Server~/package.json', '{}')
    box.write('Packages/com.gamelovers.mcp-unity/Server~/package.json', '{}')

    const dirs = serverDirectories(box.root)
    assert.ok(dirs.length >= 3, `expected at least three directories, got ${dirs.length}`)
    assert.ok(
      dirs[0].startsWith(join(box.root, 'Library', 'PackageCache')),
      `first entry should come from the package cache, got ${dirs[0]}`,
    )
    assert.ok(dirs[0].endsWith('Server~'), `first entry should be a Server~ folder, got ${dirs[0]}`)

    // `Server~` must always be tried before its package root fallback.
    for (const dir of dirs) {
      if (!dir.endsWith('Server~')) continue
      assert.ok(
        dirs.indexOf(dir) < dirs.indexOf(dir.replace(/[\\/]Server~$/, '')),
        `${dir} should precede its package root`,
      )
    }

    const embedded = dirs.filter((dir) => dir.startsWith(join(box.root, 'Packages')))
    assert.ok(embedded.length > 0, 'embedded package copy should be a candidate')
    assert.ok(
      dirs.indexOf(embedded[0]) > dirs.indexOf(dirs.find((dir) => dir.includes('PackageCache'))),
      'embedded package copy should come after the package cache',
    )
  } finally {
    box.cleanup()
  }
})

check('unity projects are recognised by ProjectSettings and Assets folders', () => {
  const box = sandbox()
  try {
    box.write('Game/ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3.62f3c1')
    box.write('Game/Assets/.keep', '')

    assert.ok(looksLikeUnityProject(join(box.root, 'Game')))
    assert.equal(projectRootOf(join(box.root, 'Game', 'Assets')), join(box.root, 'Game'))
    assert.equal(projectRootOf(box.root), null)
  } finally {
    box.cleanup()
  }
})

check('the lock file decides which cached package version wins', () => {
  const box = sandbox()
  try {
    box.write(
      'Packages/packages-lock.json',
      JSON.stringify({
        dependencies: {
          'com.gamelovers.mcp-unity': {
            version: 'https://github.com/CoderGamester/mcp-unity.git',
            source: 'git',
            hash: 'd572dc88f1b982a0fdfc09cd14cfdfd760b658e8',
          },
        },
      }),
    )
    // A newer-looking stale copy sits next to the pinned one.
    box.write('Library/PackageCache/com.gamelovers.mcp-unity@d572dc88f1/Server~/package.json', '{}')
    box.write('Library/PackageCache/com.gamelovers.mcp-unity@ffffffffff/Server~/package.json', '{}')

    assert.deepEqual(lockedCacheNames(box.root)[0], 'com.gamelovers.mcp-unity@d572dc88f1')

    const dirs = serverDirectories(box.root)
    assert.ok(
      dirs[0].includes('d572dc88f1'),
      `the pinned revision should win over the stale cache copy, got ${dirs[0]}`,
    )
    assert.ok(
      dirs.some((dir) => dir.includes('ffffffffff')),
      'the stale copy should stay as a fallback',
    )
  } finally {
    box.cleanup()
  }
})

check('a registry package resolves through its version suffix', () => {
  const box = sandbox()
  try {
    box.write(
      'Packages/packages-lock.json',
      JSON.stringify({
        dependencies: {
          'com.gamelovers.mcp-unity': { version: '1.5.0', source: 'registry', depth: 0 },
        },
      }),
    )
    assert.equal(lockedCacheNames(box.root)[0], 'com.gamelovers.mcp-unity@1.5.0')
  } finally {
    box.cleanup()
  }
})

check('the package version is read from the package or its server folder', () => {
  const box = sandbox()
  try {
    box.write(
      'Library/PackageCache/com.gamelovers.mcp-unity@abc/package.json',
      JSON.stringify({ name: 'com.gamelovers.mcp-unity', version: '1.5.0' }),
    )
    box.write(
      'Library/PackageCache/com.gamelovers.mcp-unity@abc/Server~/package.json',
      JSON.stringify({ name: 'mcp-unity-server', version: '1.5.0' }),
    )
    const serverDir = join(box.root, 'Library/PackageCache/com.gamelovers.mcp-unity@abc/Server~')
    assert.equal(packageVersion(serverDir), '1.5.0')
    assert.equal(packageVersion(join(box.root, 'nowhere')), null)

    assert.ok(compareVersions('1.5.0', '1.5.0') === 0)
    assert.ok(compareVersions('1.4.2', '1.5.0') < 0)
    assert.ok(compareVersions('2022.3.62', '2022.3.9') > 0)
  } finally {
    box.cleanup()
  }
})

process.stderr.write('\nprobe.mjs\n')

const CANDIDATES = Array.from({ length: 6 }, (_, index) => ({
  root: `Project${index}`,
  endpoint: { host: 'localhost', port: 9100 + index },
  token: 'x'.repeat(64),
}))

await checkAsync('every ready candidate is probed, not just the first four', async () => {
  const asked = []
  const probe = async ({ port, host }) => {
    asked.push(`${host}:${port}`)
    return { reachable: port === 9105, host: '127.0.0.1' }
  }
  const result = await chooseByProbe(CANDIDATES, { probe, concurrency: 2 })
  assert.equal(asked.length, CANDIDATES.length)
  assert.equal(result.candidate.root, 'Project5')
  assert.equal(result.host, '127.0.0.1')
  assert.deepEqual(
    result.attempted.map((entry) => entry.root),
    CANDIDATES.map((candidate) => candidate.root),
  )
  assert.equal(result.attempted.filter((entry) => entry.answered).length, 1)
})

await checkAsync('candidate order decides between several answers', async () => {
  const result = await chooseByProbe(CANDIDATES, {
    probe: async ({ host }) => ({ reachable: true, host }),
  })
  assert.equal(result.candidate.root, 'Project0')
  assert.equal(result.host, 'localhost')
})

await checkAsync('nobody answering keeps no candidate', async () => {
  const result = await chooseByProbe(CANDIDATES, {
    probe: async () => ({ reachable: false, host: null }),
  })
  assert.equal(result.candidate, null)
  assert.equal(result.host, null)
  assert.equal(result.attempted.length, CANDIDATES.length)
  assert.ok(result.attempted.every((entry) => entry.answered === false))
  assert.deepEqual(await chooseByProbe([]), { candidate: null, host: null, attempted: [] })
})

await checkAsync('a failing probe does not stop the others', async () => {
  const result = await chooseByProbe(CANDIDATES, {
    probe: async ({ port }) => {
      if (port === 9100) throw new Error('boom')
      return { reachable: port === 9101, host: '::1' }
    },
  })
  assert.equal(result.candidate.root, 'Project1')
})

process.stderr.write(`\n${results.passed} passed, ${results.failed} failed\n`)
process.exit(results.failed === 0 ? 0 : 1)
