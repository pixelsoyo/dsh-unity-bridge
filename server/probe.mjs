/**
 * Ask a running Unity editor whether it accepts our bridge token.
 *
 * The mcp-unity bridge is a WebSocket endpoint at ws://host:port/McpUnity that
 * demands HTTP Basic auth with the fixed user name `mcp-unity` and the token
 * from Library/McpUnity/bridge-token. A raw HTTP Upgrade request tells us
 * three things at once: the port is listening, the path exists, and the token
 * belongs to that project. We never send an `Origin` header — the Unity side
 * rejects handshakes that carry one (dsh is a native client, so it must not).
 */

import { randomBytes } from 'node:crypto'
import http from 'node:http'

export const BRIDGE_PATH = '/McpUnity'
export const BRIDGE_USER = 'mcp-unity'

/** How many candidates are asked at the same time; each probe is one TCP dial. */
const DEFAULT_CONCURRENCY = 8

function probeOnce({ host, port, token, timeoutMs, path }) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      resolve(ok)
    }

    const request = http.request({
      host,
      port,
      path,
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        Authorization: `Basic ${Buffer.from(`${BRIDGE_USER}:${token}`).toString('base64')}`,
      },
    })

    request.on('upgrade', (response, socket) => {
      socket?.destroy()
      finish(response.statusCode === 101)
    })
    request.on('response', (response) => {
      response.resume()
      finish(false)
    })
    request.on('error', () => finish(false))
    request.on('timeout', () => {
      finish(false)
      request.destroy()
    })
    request.end()
  })
}

/**
 * Resolve to `{ reachable, host }`.
 *
 * `localhost` is tried over IPv4 and IPv6 at the same time because Node's
 * resolver may pick either family while Unity binds just one of them (a Windows
 * editor that listens on ::1 only is a real case, and its `ws://localhost`
 * resolution is then a coin flip). The address that answered is reported back
 * so the launcher can pin the server to it. Probing both in parallel keeps the
 * cost at one timeout instead of two.
 */
export async function probeBridge({
  host = 'localhost',
  port,
  token,
  timeoutMs = 1500,
  path = BRIDGE_PATH,
} = {}) {
  if (!token || !port) return { reachable: false, host: null }
  const hosts = host === 'localhost' ? ['127.0.0.1', '::1'] : [host]
  const answers = await Promise.all(
    hosts.map(async (candidate) => ({
      host: candidate,
      reachable: await probeOnce({ host: candidate, port, token, timeoutMs, path }),
    })),
  )
  for (const answer of answers) {
    if (answer.reachable) return { reachable: true, host: answer.host }
  }
  return { reachable: false, host: null }
}

/**
 * Ask every ready candidate and keep the first one, in candidate order, that
 * answers with its own token.
 *
 * Candidates used to be probed one after another, four at most. A fifth
 * configured project was never asked, so when the editor that was actually
 * running sat further down the list the launcher pinned the wrong project and
 * every tool call then failed the token handshake. Probing all of them
 * concurrently costs about one timeout in total instead of one per candidate.
 *
 * The probe is injectable so the selection order can be tested without a
 * running editor.
 */
export async function chooseByProbe(
  candidates,
  { timeoutMs = 1500, concurrency = DEFAULT_CONCURRENCY, probe = probeBridge } = {},
) {
  if (candidates.length === 0) return { candidate: null, host: null, attempted: [] }

  const answers = new Array(candidates.length).fill(null)
  let next = 0

  const worker = async () => {
    while (next < candidates.length) {
      const index = next
      next += 1
      const candidate = candidates[index]
      try {
        answers[index] = await probe({
          host: candidate.endpoint.host,
          port: candidate.endpoint.port,
          token: candidate.token,
          timeoutMs,
        })
      } catch {
        answers[index] = { reachable: false, host: null }
      }
    }
  }

  const workers = Math.max(1, Math.min(concurrency, candidates.length))
  await Promise.all(Array.from({ length: workers }, worker))

  const attempted = candidates.map((candidate, index) => ({
    root: candidate.root,
    port: candidate.endpoint.port,
    answered: answers[index]?.reachable === true,
  }))

  const winner = answers.findIndex((answer) => answer?.reachable === true)
  if (winner === -1) return { candidate: null, host: null, attempted }
  return { candidate: candidates[winner], host: answers[winner].host, attempted }
}
