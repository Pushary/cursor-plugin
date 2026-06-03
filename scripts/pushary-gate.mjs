#!/usr/bin/env node
// Pushary gate — Cursor `beforeShellExecution` hook.
//
// Routes risky shell commands to a Pushary push approval before they run, so you
// can allow or deny from your phone's lock screen. Which commands reach this gate
// is controlled by the `matcher` in ../hooks/hooks.json.
//
// Self-contained: no dependencies, uses the global fetch (Node 18+).
//
// Contract (https://cursor.com/docs/hooks):
//   stdin  : { "command": string, "cwd": string, "sandbox": boolean, ... }
//   stdout : { "permission": "allow" | "deny" | "ask", "user_message"?, "agent_message"? }
//
// Failure model: every handled path writes a decision and exits 0. On a missing
// key, network error, or timeout it returns "ask" so Cursor shows its own
// in-editor approval — it never silently allows a risky command. A hard guard
// guarantees a decision before the hook's `failClosed` deadline; the only way the
// gate fails to respond is a catastrophic crash (e.g. Node missing), in which case
// `failClosed: true` blocks the command rather than letting it through unapproved.

import { basename } from 'node:path'

const MCP_URL = 'https://pushary.com/api/mcp/mcp'
const ANSWER_DEADLINE_MS = 45_000 // total budget to get a phone answer
const WAIT_CHUNK_MS = 20_000 // per wait_for_answer long-poll
const POLL_GAP_MS = 1_500 // pause between polls after a transient error
const NET_TIMEOUT_MS = 27_000 // abort a single request (> WAIT_CHUNK_MS + latency)
const HARD_GUARD_MS = 55_000 // force a graceful "ask" before failClosed (60s) fires

let answered = false
const respond = (decision) => {
  if (answered) return
  answered = true
  process.stdout.write(JSON.stringify(decision))
  process.exit(0)
}

// Backstop: if anything hangs, return "ask" rather than letting the hook time out
// (which, with failClosed, would block the command).
setTimeout(() => respond({ permission: 'ask' }), HARD_GUARD_MS).unref()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const readStdin = async () => {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  return raw
}

// Parse an MCP HTTP response that may be plain JSON or an SSE (text/event-stream)
// stream. For SSE we keep the last well-formed `data:` frame.
const parseMcpBody = (body, contentType) => {
  if (contentType && contentType.includes('text/event-stream')) {
    let last = null
    for (const frame of body.split(/\r?\n\r?\n/)) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim()
      if (!data) continue
      try {
        last = JSON.parse(data)
      } catch {}
    }
    if (!last) throw new Error('empty SSE response')
    return last
  }
  return JSON.parse(body)
}

// Call one MCP tool and return its parsed result payload.
const callTool = async (apiKey, name, args) => {
  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(NET_TIMEOUT_MS),
  })

  const text = await response.text()
  if (!response.ok) throw new Error(`Pushary MCP ${response.status}`)

  const rpc = parseMcpBody(text, response.headers.get('content-type'))
  if (rpc.error) throw new Error(rpc.error.message || 'Pushary MCP error')

  const payload = rpc.result?.content?.[0]?.text
  if (!payload) throw new Error('empty Pushary response')
  return JSON.parse(payload)
}

// Register the question, then poll for the answer to the deadline. Polling (rather
// than one long blocking call) survives a transient network error mid-wait.
const askAndWait = async (apiKey, command, project) => {
  const asked = await callTool(apiKey, 'ask_user', {
    question: `Allow this command?\n\n${command}`,
    type: 'confirm',
    context: `Cursor agent wants to run this in ${project}`,
    agentName: `Cursor - ${project}`,
    wait: false,
  })

  const correlationId = asked?.correlationId
  if (!correlationId) throw new Error('no correlationId from ask_user')

  const deadline = Date.now() + ANSWER_DEADLINE_MS
  while (Date.now() < deadline) {
    const remaining = Math.min(Math.max(deadline - Date.now(), 1_000), WAIT_CHUNK_MS)
    try {
      const answer = await callTool(apiKey, 'wait_for_answer', { correlationId, timeoutMs: remaining })
      if (answer?.answered) return answer
    } catch {
      if (Date.now() + POLL_GAP_MS >= deadline) break
      await sleep(POLL_GAP_MS)
      continue
    }
    if (Date.now() + POLL_GAP_MS >= deadline) break
    await sleep(POLL_GAP_MS)
  }
  return { answered: false }
}

const main = async () => {
  let input
  try {
    const raw = await readStdin()
    input = raw.trim() ? JSON.parse(raw) : {}
  } catch {
    return respond({ permission: 'ask' })
  }

  const command = typeof input.command === 'string' ? input.command.trim() : ''
  if (!command) return respond({ permission: 'ask' })

  const apiKey = process.env.PUSHARY_API_KEY
  if (!apiKey) {
    return respond({
      permission: 'ask',
      agent_message:
        'Pushary is not configured: set the PUSHARY_API_KEY environment variable (get a key at https://pushary.com) to route this approval to your phone.',
    })
  }

  const project = basename(input.cwd || process.cwd()) || 'workspace'

  let answer
  try {
    answer = await askAndWait(apiKey, command, project)
  } catch (error) {
    process.stderr.write(`[pushary-gate] ${error?.message ?? error}\n`)
    return respond({ permission: 'ask' })
  }

  if (answer?.answered) {
    if (answer.value === 'yes') return respond({ permission: 'allow' })
    return respond({
      permission: 'deny',
      user_message: 'Command denied via Pushary.',
      agent_message:
        'The user denied this command via a Pushary push approval. Do not run it — propose an alternative or ask how to proceed.',
    })
  }

  // No phone response within the budget — defer to Cursor's own approval prompt.
  return respond({ permission: 'ask' })
}

main().catch((error) => {
  process.stderr.write(`[pushary-gate] fatal: ${error?.message ?? error}\n`)
  respond({ permission: 'ask' })
})
