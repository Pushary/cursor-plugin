#!/usr/bin/env node
// Pushary gate — Cursor `beforeShellExecution` hook.
//
// Routes risky shell commands through your Pushary permission policy before they
// run. Which commands reach this gate is the `matcher` in ../hooks/hooks.json; what
// HAPPENS to a matched command is decided by your dashboard policy (the same policy
// the @pushary/agent-hooks CLI uses for Claude Code), so behavior is consistent
// across agents.
//
// It honors, per tool ("Bash"): auto-approve, the four approval modes
// (push_only / push_first / notify_only / terminal_only), the timeout action
// (approve / deny / escalate), a live mode override, and the kill switch — all
// scoped to the Cursor conversation. Policy is cached in the temp dir for 5 minutes
// with a stale-fallback, and requests retry.
//
// Self-contained: no dependencies, uses the global fetch (Node 18+).
//
// Contract (https://cursor.com/docs/hooks):
//   stdin  : { "command": string, "cwd": string, "conversation_id": string, ... }
//   stdout : { "permission": "allow" | "deny" | "ask", "user_message"?, "agent_message"? }
//
// Failure model: every handled path writes a decision and exits 0. Network/parse
// errors and no-policy fall back to "ask" (Cursor's own prompt) — it never silently
// allows a risky command. A 55s hard guard guarantees a decision before the hook's
// `failClosed` deadline; only a catastrophic crash (e.g. Node missing) leaves no
// output, in which case `failClosed: true` blocks the command rather than allowing
// it unapproved.

import { createHash } from 'node:crypto'
import { hostname, tmpdir } from 'node:os'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const BASE_URL = 'https://pushary.com'
const MCP_URL = `${BASE_URL}/api/mcp/mcp`
const POLICY_CACHE_TTL_MS = 5 * 60 * 1000
const MAX_BLOCK_MS = 45_000 // longest we can wait before Cursor's hook timeout
const WAIT_CHUNK_MS = 20_000 // per wait_for_answer long-poll
const POLL_GAP_MS = 1_500 // pause between polls after a transient error
const NET_TIMEOUT_MS = 27_000 // abort a single MCP request
const POLICY_TIMEOUT_MS = 10_000
const MODE_TIMEOUT_MS = 3_000
const HARD_GUARD_MS = 55_000 // force a graceful "ask" before failClosed (60s) fires

// ── Cursor decisions ──────────────────────────────────────────────────────────
const ALLOW = { permission: 'allow' }
const ask = (agentMessage) => (agentMessage ? { permission: 'ask', agent_message: agentMessage } : { permission: 'ask' })
const deny = (agentMessage) => ({ permission: 'deny', user_message: 'Command denied via Pushary.', agent_message: agentMessage })

let done = false
const respond = (decision) => {
  if (done) return
  done = true
  process.stdout.write(JSON.stringify(decision))
  process.exit(0)
}

// Backstop: if anything hangs, return "ask" rather than letting the hook time out
// (which, with failClosed, would block the command).
setTimeout(() => respond(ask()), HARD_GUARD_MS).unref()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi)

const withRetry = async (fn, attempts) => {
  let lastError
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (i < attempts - 1) await sleep(300 * (i + 1))
    }
  }
  throw lastError
}

const readStdin = async () => {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  return raw
}

const getMachineId = () => createHash('sha256').update(hostname()).digest('hex').slice(0, 8)

// ── MCP transport (JSON or SSE) ─────────────────────────────────────────────────
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

const callTool = async (apiKey, name, args) => {
  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
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

const getJson = async (path, apiKey, timeoutMs) => {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`GET ${path} ${response.status}`)
  return response.json()
}

// ── Policy (mirrors @pushary/agent-hooks policy.ts) ──────────────────────────────
const isPolicyConfig = (d) =>
  !!d && typeof d === 'object' && Array.isArray(d.policies) && typeof d.defaultTimeoutSeconds === 'number' && typeof d.defaultTimeoutAction === 'string'

const policyCacheFile = (apiKey) => join(tmpdir(), `pushary-policy-${createHash('sha256').update(apiKey).digest('hex').slice(0, 12)}.json`)

const getPolicy = async (apiKey) => {
  const path = policyCacheFile(apiKey)
  let stale = null
  if (existsSync(path)) {
    try {
      const cached = JSON.parse(readFileSync(path, 'utf-8'))
      if (isPolicyConfig(cached)) {
        if (!cached._cachedAt || Date.now() - cached._cachedAt < POLICY_CACHE_TTL_MS) return cached
        stale = cached
      }
    } catch {}
  }
  try {
    const fresh = await withRetry(async () => {
      const raw = await getJson('/api/mcp/policy', apiKey, POLICY_TIMEOUT_MS)
      if (!isPolicyConfig(raw)) throw new Error('invalid policy')
      return raw
    }, 2)
    try {
      writeFileSync(path, JSON.stringify({ ...fresh, _cachedAt: Date.now() }), 'utf-8')
    } catch {}
    return fresh
  } catch (error) {
    if (stale) return stale
    throw error
  }
}

const resolvePolicy = (config, toolName, modeOverride) => {
  const base =
    config.policies.find((p) => p.tool === toolName) ??
    config.policies.find((p) => p.tool === '*') ??
    {
      tool: toolName,
      timeoutSeconds: config.defaultTimeoutSeconds,
      timeoutAction: config.defaultTimeoutAction,
      mode: config.defaultMode ?? 'push_first',
      pushFirstSeconds: config.defaultPushFirstSeconds ?? 20,
    }
  const effective = modeOverride ?? config.modeOverride
  return effective ? { ...base, mode: effective } : base
}

const APPROVAL_MODES = ['push_only', 'terminal_only', 'push_first', 'notify_only']
const fetchModeState = async (apiKey, sessionId) => {
  try {
    const path = sessionId ? `/api/mcp/mode?session=${encodeURIComponent(sessionId)}` : '/api/mcp/mode'
    const data = await getJson(path, apiKey, MODE_TIMEOUT_MS)
    const mode = data?.override?.mode
    return { mode: APPROVAL_MODES.includes(mode) ? mode : null, kill: data?.kill === true }
  } catch {
    return { mode: null, kill: false }
  }
}

// ── ask / wait ───────────────────────────────────────────────────────────────
const askArgs = (command, project, ident) => ({
  question: `Allow this command?\n\n${command}`,
  type: 'confirm',
  context: `Cursor agent wants to run this in ${project}`,
  agentName: ident.agentName,
  sessionId: ident.sessionId,
  machineId: ident.machineId,
  toolName: 'Bash',
  wait: false,
})

const pollForAnswer = async (apiKey, correlationId, deadlineMs) => {
  while (Date.now() < deadlineMs) {
    const remaining = clamp(deadlineMs - Date.now(), 1_000, WAIT_CHUNK_MS)
    try {
      const answer = await callTool(apiKey, 'wait_for_answer', { correlationId, timeoutMs: remaining })
      if (answer?.answered) return answer
    } catch {
      if (Date.now() + POLL_GAP_MS >= deadlineMs) break
      await sleep(POLL_GAP_MS)
      continue
    }
    if (Date.now() + POLL_GAP_MS >= deadlineMs) break
    await sleep(POLL_GAP_MS)
  }
  return { answered: false }
}

const fromTimeoutAction = (action, deniedReason) =>
  action === 'approve' ? ALLOW : action === 'deny' ? deny(deniedReason) : ask()

const DENIED = 'The user denied this command via a Pushary push approval. Do not run it — propose an alternative or ask how to proceed.'

// push_only: wait up to the policy timeout, then apply the timeout action.
const handlePushOnly = async (apiKey, command, project, ident, timeoutSeconds, timeoutAction) => {
  let asked
  try {
    asked = await withRetry(() => callTool(apiKey, 'ask_user', askArgs(command, project, ident)), 3)
  } catch {
    return fromTimeoutAction(timeoutAction, 'Push notification failed; denied per your Pushary policy.')
  }
  if (!asked?.correlationId) return ask()

  const realMs = Math.max(timeoutSeconds, 1) * 1000
  const cap = Math.min(realMs, MAX_BLOCK_MS)
  const answer = await pollForAnswer(apiKey, asked.correlationId, Date.now() + cap)
  if (answer.answered) return answer.value === 'yes' ? ALLOW : deny(DENIED)

  // If Cursor's hook limit cut us off before the configured timeout, hand off to
  // Cursor's own prompt rather than misapplying the policy's timeout action.
  if (cap >= realMs) return fromTimeoutAction(timeoutAction, 'No response within the approval timeout; denied per your Pushary policy.')
  return ask()
}

// push_first: race the push for a short window, then fall back to Cursor's prompt.
const handlePushFirst = async (apiKey, command, project, ident, pushFirstSeconds) => {
  let asked
  try {
    asked = await withRetry(() => callTool(apiKey, 'ask_user', askArgs(command, project, ident)), 3)
  } catch {
    return ask()
  }
  if (!asked?.correlationId) return ask()

  const cap = Math.min(Math.max(pushFirstSeconds, 1) * 1000, MAX_BLOCK_MS)
  const answer = await pollForAnswer(apiKey, asked.correlationId, Date.now() + cap)
  if (answer.answered) return answer.value === 'yes' ? ALLOW : deny(DENIED)
  return ask('Sent to your phone via Pushary — you can also approve here.')
}

// notify_only: fire an awareness notification, let Cursor's prompt decide.
const handleNotifyOnly = async (apiKey, command, project, ident) => {
  try {
    await callTool(apiKey, 'send_notification', {
      title: 'Agent needs approval',
      body: command.slice(0, 180),
      agentName: ident.agentName,
      sessionId: ident.sessionId,
      machineId: ident.machineId,
    })
  } catch {}
  return ask()
}

const main = async () => {
  let input
  try {
    const raw = await readStdin()
    input = raw.trim() ? JSON.parse(raw) : {}
  } catch {
    return respond(ask())
  }

  const command = typeof input.command === 'string' ? input.command.trim() : ''
  if (!command) return respond(ask())

  const apiKey = process.env.PUSHARY_API_KEY
  if (!apiKey) {
    return respond(
      ask('Pushary is not configured: set the PUSHARY_API_KEY environment variable (get a key at https://pushary.com) to route this approval to your phone.')
    )
  }

  const project = basename(input.cwd || process.cwd()) || 'workspace'
  const sessionId = typeof input.conversation_id === 'string' ? input.conversation_id : undefined
  const ident = { agentName: `Cursor - ${project}`, sessionId, machineId: getMachineId() }

  try {
    const [policy, modeState] = await Promise.all([getPolicy(apiKey), fetchModeState(apiKey, sessionId)])

    if (modeState.kill) return respond(deny('Stopped by user — this agent was halted from Pushary. Do not run this command.'))

    const tool = resolvePolicy(policy, 'Bash', modeState.mode)
    if (tool.timeoutSeconds === 0 && tool.timeoutAction === 'approve') return respond(ALLOW)

    switch (tool.mode) {
      case 'terminal_only':
        return respond(ask())
      case 'notify_only':
        return respond(await handleNotifyOnly(apiKey, command, project, ident))
      case 'push_only':
        return respond(await handlePushOnly(apiKey, command, project, ident, tool.timeoutSeconds, tool.timeoutAction))
      case 'push_first':
      default:
        return respond(await handlePushFirst(apiKey, command, project, ident, tool.pushFirstSeconds))
    }
  } catch (error) {
    process.stderr.write(`[pushary-gate] ${error?.message ?? error}\n`)
    return respond(ask())
  }
}

main().catch((error) => {
  process.stderr.write(`[pushary-gate] fatal: ${error?.message ?? error}\n`)
  respond(ask())
})
