#!/usr/bin/env node
// Pushary gate — Cursor `beforeShellExecution` and `beforeMCPExecution` hooks.
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
//   stdin  : { "hook_event_name": string, "cwd": string, "conversation_id": string, ... }
//            beforeShellExecution adds { "command": string }
//            beforeMCPExecution   adds { "tool_name", "tool_input", "mcp_server_name" }
//   stdout : { "permission": "allow" | "deny" | "ask", "user_message"?, "agent_message"? }
//
// Failure model: every handled path writes a decision and exits 0. Network/parse
// errors and no-policy fall back to "ask" (Cursor's own prompt) — it never silently
// allows a risky command. A 55s hard guard guarantees a decision before the hook's
// `failClosed` deadline; only a catastrophic crash (e.g. Node missing) leaves no
// output, in which case `failClosed: true` blocks the command rather than allowing
// it unapproved.

import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE_URL = 'https://pushary.com'
const MCP_URL = `${BASE_URL}/api/mcp/mcp`
const MAX_BLOCK_MS = 45_000 // longest we can wait before Cursor's hook timeout
const WAIT_CHUNK_MS = 20_000 // per wait_for_answer long-poll
const POLL_GAP_MS = 1_500 // pause between polls after a transient error
const NET_TIMEOUT_MS = 27_000 // abort a single MCP request
const WITHDRAW_TIMEOUT_MS = 4_000
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

// ── Repository identity (ported from packages/agent-hooks/src/repo.ts) ───────
// A rule can be scoped to one repository, so the gate has to know which one it
// is in or those rules are withheld. Read as files: a `git` subprocess here would
// cost more than the rest of the decision and fail where git is absent.
const REPO_KEY_MAX_LENGTH = 200
const MAX_PARENT_WALK = 64

const normalizeRepoRemote = (remoteUrl) => {
  const raw = (remoteUrl || '').trim()
  if (!raw) return undefined
  let hostAndPath
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9._-]+):(.+)$/.exec(raw)
  if (scp) {
    hostAndPath = `${scp[1]}/${scp[2]}`
  } else {
    const url = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(.+)$/.exec(raw)
    if (!url || /^file:/i.test(raw)) return undefined
    hostAndPath = url[1]
  }
  const slash = hostAndPath.indexOf('/')
  if (slash <= 0) return undefined
  const at = hostAndPath.slice(0, slash).lastIndexOf('@')
  // Credentials must never survive: a remote can carry a token and this value is
  // sent to the server and persisted.
  const host = (at === -1 ? hostAndPath.slice(0, slash) : hostAndPath.slice(at + 1, slash)).replace(/:\d+$/, '')
  const path = hostAndPath.slice(slash + 1).split('/').filter(Boolean).join('/')
  if (!host || !path) return undefined
  return `${host}/${path}`.replace(/\.git$/i, '').toLowerCase().slice(0, REPO_KEY_MAX_LENGTH)
}

const findGitDir = (startDir) => {
  let current = startDir
  for (let depth = 0; depth < MAX_PARENT_WALK; depth += 1) {
    const candidate = join(current, '.git')
    try {
      if (existsSync(candidate)) {
        const pointer = readFileSync(candidate, 'utf-8').trim()
        // A directory read throws EISDIR, which is the ordinary-clone case.
        if (pointer.startsWith('gitdir:')) {
          const target = pointer.slice('gitdir:'.length).trim()
          return target.startsWith('/') ? target : join(current, target)
        }
      }
    } catch (error) {
      if (error?.code === 'EISDIR') return candidate
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

const deriveRepoKey = (cwd) => {
  const override = process.env.PUSHARY_REPO_KEY
  if (typeof override === 'string') {
    const trimmed = override.trim()
    if (trimmed.toLowerCase() === 'off') return undefined
    if (trimmed) return trimmed.toLowerCase()
  }
  const dir = cwd || process.cwd()
  try {
    const gitDir = findGitDir(dir)
    if (gitDir) {
      // A worktree's config lives in the main git directory.
      const wt = gitDir.replace(/\\/g, '/').indexOf('/worktrees/')
      const configPath = wt === -1 ? join(gitDir, 'config') : join(gitDir.slice(0, wt), 'config')
      if (existsSync(configPath)) {
        let inOrigin = false
        for (const rawLine of readFileSync(configPath, 'utf-8').split('\n')) {
          const line = rawLine.trim()
          if (line.startsWith('[')) { inOrigin = /^\[remote "origin"\]/.test(line); continue }
          if (!inOrigin) continue
          const url = /^url\s*=\s*(.+)$/.exec(line)
          if (url) {
            const normalized = normalizeRepoRemote(url[1].trim())
            if (normalized) return normalized
          }
        }
      }
      const root = gitDir.endsWith('.git') ? dirname(gitDir) : dir
      return `local/${basename(root).toLowerCase()}`.slice(0, REPO_KEY_MAX_LENGTH)
    }
    return `local/${basename(dir).toLowerCase()}`.slice(0, REPO_KEY_MAX_LENGTH)
  } catch {
    return undefined
  }
}

// Env first. CLI installs inject the key into the sibling mcp.json, so fall back to
// that. This lets the gate work even when Cursor's GUI does not pass the shell env.
const resolveApiKey = () => {
  const fromEnv = process.env.PUSHARY_API_KEY
  if (fromEnv) return fromEnv
  try {
    const mcpPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp.json')
    const auth = JSON.parse(readFileSync(mcpPath, 'utf-8'))?.mcpServers?.pushary?.headers?.Authorization ?? ''
    const key = auth.replace(/^Bearer\s+/i, '').trim()
    if (/^pk_[a-z0-9]+\.[a-z0-9]+$/i.test(key)) return key
  } catch {}
  return undefined
}

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

const callTool = async (apiKey, name, args, timeoutMs = NET_TIMEOUT_MS) => {
  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Pushary MCP ${response.status}`)
  const rpc = parseMcpBody(text, response.headers.get('content-type'))
  if (rpc.error) throw new Error(rpc.error.message || 'Pushary MCP error')
  const payload = rpc.result?.content?.[0]?.text
  if (!payload) throw new Error('empty Pushary response')
  return JSON.parse(payload)
}

// ── The verdict ─────────────────────────────────────────────────────────────
// Asked for, not worked out here.
//
// This file used to carry its own copy of the authorization boundary: pattern
// matching, glob compilation, a destructive-command list and policy resolution,
// roughly two hundred and fifty lines of it. A copy of a rule is a rule that
// drifts, and this one had already drifted twice. It matched on tool name alone
// once, so a user's own `Bash(rm:*)` deny did nothing while a broad `Bash` allow
// approved `rm -rf`. And it never gained `isSafeReadOnlyCommand`, so `git status`
// reached the phone here and nowhere else.
//
// The server now answers with the same `resolveGate` the CLI runs, over the same
// state, so there is one boundary and this asks it. What stays local is only
// what a server cannot know: the repository this checkout is in, which needs a
// parent walk and a git config read on this machine.

const GATE_TIMEOUT_MS = 5000

/**
 * The verdict for one request, or null if we could not get one.
 *
 * Null is not a denial and not an approval: every failure here hands the call
 * back to Cursor's own prompt, exactly as if this gate were not installed.
 */
const decide = async (apiKey, request, cwd, sessionId) => {
  try {
    const response = await fetch(`${BASE_URL}/api/agent/gate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        v: 1,
        source: 'cursor',
        toolName: request.toolName,
        toolInputs: request.toolInputs,
        cwd,
        repoKey: deriveRepoKey(cwd),
        sessionId,
      }),
      signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const verdict = await response.json()
    return verdict && typeof verdict.kind === 'string' ? verdict : null
  } catch {
    return null
  }
}

// ── network diagnosis ────────────────────────────────────────────────────────
//
// This gate is a dependency-free .mjs, so unlike the CLI it cannot install
// undici's EnvHttpProxyAgent and its fetch ignores HTTP_PROXY entirely. Node
// gained a native equivalent in 24 (NODE_USE_ENV_PROXY), but that is read at
// startup, so a script cannot switch it on for itself.
//
// The gate already fails safe: any error here hands the decision to the editor's
// own prompt. The cost is therefore not a blocked command, it is SILENCE. On a
// corporate network every approval quietly stops reaching the phone and the only
// trace is one stderr line nobody reads. So when a proxy is configured and the
// network call fails, say which of those two it is.
export const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']

export const proxyConfigured = (env = process.env) =>
  PROXY_VARS.some(name => (env[name] ?? '').trim() !== '')

export const describeNetworkFailure = (error, env = process.env) => {
  const detail = error?.message ?? String(error)
  if (!proxyConfigured(env)) return detail
  const enabled = (env.NODE_USE_ENV_PROXY ?? '').trim() !== ''
  if (enabled) return detail
  return `${detail} (a proxy is set in HTTP_PROXY/HTTPS_PROXY and this hook cannot use it; on Node 24+ set NODE_USE_ENV_PROXY=1 in the editor's environment)`
}

// Secret redaction, two tiers, mirroring SECRET_REDACTION_RULES in @pushary/contracts.
// The precise rules only match real credential shapes, so they are safe on a line a
// human reads: a git SHA, a path and prose all survive. The high-entropy catch-all
// over-redacts by design and is therefore only ever applied to a full body dump.
//
// This gate previously did no redaction at all, so the raw command went out in the
// question, the notification body and the action body alike. A key on the command
// line reached the lock screen verbatim.
const ACTION_BODY_MAX = 4000
const ACTION_BODY_TRUNCATION_MARKER = '\n… [truncated]'
const REDACTION_RULES = [
  [/-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z0-9 ]*PRIVATE KEY-----/g, '[redacted key]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted]'],
  [/\b[spr]k_(?:live|test)_[A-Za-z0-9]{8,}\b/g, '[redacted]'],
  [/\bwhsec_[A-Za-z0-9]{16,}\b/g, '[redacted]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, '[redacted]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, '[redacted]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted]'],
  [/\bAIza[A-Za-z0-9_-]{35}\b/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, '[redacted]'],
  [/\bxai-[A-Za-z0-9]{16,}\b/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'bearer [redacted]'],
  [/\bauthorization:\s*\S+/gi, 'authorization: [redacted]'],
  [/((?:secret|token|password|passwd|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)\s*[=:]\s*)(\"[^\"]*\"|'[^']*'|\S+)/gi, '$1[redacted]'],
]
const HIGH_ENTROPY_RULE = [/[A-Za-z0-9+/]{40,}={0,2}/g, '[redacted]']
export const redactSecrets = (text) => REDACTION_RULES.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text)
const redactSecretsDeep = (text) => redactSecrets(text).replace(HIGH_ENTROPY_RULE[0], HIGH_ENTROPY_RULE[1])
const capActionBody = (text) =>
  text.length <= ACTION_BODY_MAX ? text : `${text.slice(0, ACTION_BODY_MAX - ACTION_BODY_TRUNCATION_MARKER.length)}${ACTION_BODY_TRUNCATION_MARKER}`
const deriveActionBody = (command) => capActionBody(redactSecretsDeep(command))

// ── ask / wait ───────────────────────────────────────────────────────────────
// toolTarget and actionBody are what let the server classify risk, drop the
// one-tap Approve on a dangerous call, and record a decision at the same grain as
// every other agent. Without them a destructive Cursor command arrived on the
// lock screen ungated.
const commandHead = (command) => command.trim().split(/\s+/).slice(0, 2).join(' ').slice(0, 120)

const askArgs = (request, project, ident) => ({
  question: `${request.prompt}\n\n${redactSecrets(request.display)}`,
  type: 'confirm',
  context: `Cursor agent wants to ${request.verb} in ${project}`,
  agentName: ident.agentName,
  sessionId: ident.sessionId,
  machineId: ident.machineId,
  toolName: request.toolName,
  toolTarget: request.toolTarget,
  actionBody: deriveActionBody(request.display),
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

const fromAnswer = (answer, deniedReason) => {
  if (answer.value === 'defer') return ask()
  return answer.value === 'yes' ? ALLOW : deny(deniedReason)
}

const withdraw = async (apiKey, correlationId) => {
  const unanswered = { answered: false }
  let cancelled
  try {
    cancelled = await callTool(apiKey, 'cancel_question', { correlationId }, WITHDRAW_TIMEOUT_MS)
  } catch {
    return unanswered
  }
  if (cancelled?.cancelled !== false || cancelled?.status === 'unavailable') return unanswered
  try {
    const answer = await callTool(apiKey, 'wait_for_answer', { correlationId, timeoutMs: 1_000 }, WITHDRAW_TIMEOUT_MS)
    return answer?.answered ? answer : unanswered
  } catch {
    return unanswered
  }
}

const handedOff = (asked) => asked.suppressed || asked.status === 'terminal'

const handoffMessage = (asked) =>
  asked.suppressed ? 'You are at the keyboard, approve here.' : 'Delivery mode is Terminal, approve here.'

const denialFor = (noun) =>
  `The user denied this ${noun} via a Pushary push approval. Do not run it — propose an alternative or ask how to proceed.`

/**
 * What this hook is being asked about, in the one shape the rest of the gate
 * reads.
 *
 * Cursor sends a different payload per event and the gate used to know only one
 * of them: it read `input.command`, called everything "Bash", and any event that
 * was not a shell execution fell out at the empty-command guard as `ask`. That
 * was correct while `beforeShellExecution` was the only thing registered.
 *
 * Returns null when there is nothing to gate, which the caller answers with
 * Cursor's own prompt.
 */
const describeRequest = (input) => {
  const event = typeof input.hook_event_name === 'string' ? input.hook_event_name : ''

  if (event === 'beforeMCPExecution') {
    const tool = typeof input.tool_name === 'string' ? input.tool_name.trim() : ''
    if (!tool) return null
    const server = typeof input.mcp_server_name === 'string' ? input.mcp_server_name.trim() : ''
    // `mcp__<server>__<tool>`, the same spelling Claude Code uses and the one
    // `validateToolPattern` accepts, so a policy someone wrote once matches the
    // same tool whichever agent called it. That portability is the only reason
    // the policy engine is server-side.
    const toolName = server ? `mcp__${server}__${tool}` : `mcp__${tool}`

    // Never gate Pushary's own MCP tools. Asking Pushary to approve Pushary's
    // ask_user call deadlocks: the approval cannot be delivered until the call
    // it is gating goes through. The Claude hook carries the same guard, where
    // it is a precaution because the matcher does not route these there. Here it
    // is load-bearing: `beforeMCPExecution` is registered with NO matcher, so
    // every MCP call reaches this gate, ours included.
    if (toolName.startsWith('mcp__pushary__')) return null

    const params = typeof input.tool_input === 'string'
      ? input.tool_input
      : input.tool_input === undefined ? '' : JSON.stringify(input.tool_input)
    return {
      toolName,
      toolInputs: [{ tool: toolName, params }],
      display: params ? `${toolName}\n${params}` : toolName,
      toolTarget: toolName.slice(0, 120),
      prompt: 'Allow this tool call?',
      verb: 'call this tool',
      denied: denialFor('tool call'),
    }
  }

  // Shell is also the fallback for a payload with no event name: a `command` is
  // what `beforeShellExecution` has always been recognised by, and an older
  // Cursor that omits `hook_event_name` must keep working exactly as before.
  const command = typeof input.command === 'string' ? input.command.trim() : ''
  if (!command || (event && event !== 'beforeShellExecution')) return null
  return {
    toolName: 'Bash',
    toolInputs: [{ command }],
    display: command,
    toolTarget: commandHead(command),
    prompt: 'Allow this command?',
    verb: 'run this',
    denied: denialFor('command'),
  }
}

// push_only: wait up to the policy timeout, then apply the timeout action.
const handlePushOnly = async (apiKey, request, project, ident, timeoutSeconds, timeoutAction) => {
  let asked
  try {
    asked = await withRetry(() => callTool(apiKey, 'ask_user', askArgs(request, project, ident)), 3)
  } catch {
    return fromTimeoutAction(timeoutAction, 'Push notification failed; denied per your Pushary policy.')
  }
  if (!asked?.correlationId) return ask()

  if (handedOff(asked)) {
    const late = await withdraw(apiKey, asked.correlationId)
    if (late.answered) return fromAnswer(late, request.denied)
    return ask(handoffMessage(asked))
  }
  if (asked.noDevices) {
    const late = await withdraw(apiKey, asked.correlationId)
    if (late.answered) return fromAnswer(late, request.denied)
    return fromTimeoutAction(timeoutAction, 'No device connected to approve on; denied per your Pushary policy.')
  }

  const realMs = timeoutAction === 'wait' ? MAX_BLOCK_MS : Math.max(timeoutSeconds, 1) * 1000
  const cap = Math.min(realMs, MAX_BLOCK_MS)
  const answer = await pollForAnswer(apiKey, asked.correlationId, Date.now() + cap)
  if (answer.answered) return fromAnswer(answer, request.denied)

  const late = await withdraw(apiKey, asked.correlationId)
  if (late.answered) return fromAnswer(late, request.denied)

  // If Cursor's hook limit cut us off before the configured timeout, hand off to
  // Cursor's own prompt rather than misapplying the policy's timeout action.
  if (cap >= realMs) return fromTimeoutAction(timeoutAction, 'No response within the approval timeout; denied per your Pushary policy.')
  return ask()
}

// push_first: race the push for a short window, then fall back to Cursor's prompt.
const handlePushFirst = async (apiKey, request, project, ident, pushFirstSeconds) => {
  let asked
  try {
    asked = await withRetry(() => callTool(apiKey, 'ask_user', askArgs(request, project, ident)), 3)
  } catch {
    return ask()
  }
  if (!asked?.correlationId) return ask()

  if (handedOff(asked)) {
    const late = await withdraw(apiKey, asked.correlationId)
    if (late.answered) return fromAnswer(late, request.denied)
    return ask(handoffMessage(asked))
  }
  if (asked.noDevices) {
    const late = await withdraw(apiKey, asked.correlationId)
    if (late.answered) return fromAnswer(late, request.denied)
    return ask('No device connected, approve here.')
  }

  const cap = Math.min(Math.max(pushFirstSeconds, 1) * 1000, MAX_BLOCK_MS)
  const answer = await pollForAnswer(apiKey, asked.correlationId, Date.now() + cap)
  if (answer.answered) return fromAnswer(answer, request.denied)

  const late = await withdraw(apiKey, asked.correlationId)
  if (late.answered) return fromAnswer(late, request.denied)
  return ask('No answer from your phone in time, so the request was withdrawn there. Approve here.')
}

// notify_only: fire an awareness notification, let Cursor's prompt decide.
const handleNotifyOnly = async (apiKey, request, project, ident) => {
  try {
    await callTool(apiKey, 'send_notification', {
      title: 'Agent needs approval',
      body: redactSecrets(request.display).slice(0, 180),
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

  const request = describeRequest(input)
  if (!request) return respond(ask())

  const apiKey = resolveApiKey()
  if (!apiKey) {
    return respond(
      ask('Pushary is not configured: set the PUSHARY_API_KEY environment variable (get a key at https://pushary.com) to route this approval to your phone.')
    )
  }

  const project = basename(input.cwd || process.cwd()) || 'workspace'
  const sessionId = typeof input.conversation_id === 'string' ? input.conversation_id : undefined
  const ident = { agentName: `Cursor - ${project}`, sessionId, machineId: getMachineId() }

  try {
    const verdict = await decide(apiKey, request, input.cwd, sessionId)

    // No verdict, or one that says nothing: Cursor's own prompt decides, exactly
    // as if this gate were not installed. Never a forced denial on an outage.
    if (!verdict || verdict.kind === 'no_opinion') return respond(ask())
    if (verdict.kind === 'kill') return respond(deny(verdict.reason))
    if (verdict.kind === 'allow') return respond(ALLOW)
    if (verdict.kind === 'deny') return respond(deny(verdict.reason))
    if (verdict.kind !== 'ask') return respond(ask())

    const tool = verdict.policy

    switch (tool.mode) {
      case 'terminal_only':
        return respond(ask())
      case 'notify_only':
        return respond(await handleNotifyOnly(apiKey, request, project, ident))
      case 'push_only':
        return respond(await handlePushOnly(apiKey, request, project, ident, tool.timeoutSeconds, tool.timeoutAction))
      case 'push_first':
      default:
        return respond(await handlePushFirst(apiKey, request, project, ident, tool.pushFirstSeconds))
    }
  } catch (error) {
    process.stderr.write(`[pushary-gate] ${error?.message ?? error}\n`)
    return respond(ask())
  }
}

// Exported for scripts/pushary-gate.test.mjs. main() only runs when the gate is
// executed directly, so importing this file for a test does not read stdin.
export { normalizeRepoRemote, deriveRepoKey, describeRequest, handlePushOnly, handlePushFirst, withdraw }

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (!isDirectRun) {
  // imported for tests
} else main().catch((error) => {
  process.stderr.write(`[pushary-gate] fatal: ${error?.message ?? error}\n`)
  respond(ask())
})
