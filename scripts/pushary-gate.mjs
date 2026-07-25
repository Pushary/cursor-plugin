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
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// Keyed by the capability as well as the key: the server returns a different rule
// set to a client that did not ask for repo-scoped rules, so one key for both
// would serve the wrong policy across an upgrade.
const policyCacheFile = (apiKey) =>
  join(tmpdir(), `pushary-policy-${createHash('sha256').update(`${apiKey}:cursor:repoAware`).digest('hex').slice(0, 12)}.json`)

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
      const raw = await getJson('/api/mcp/policy?repoAware=1', apiKey, POLICY_TIMEOUT_MS)
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

// ── Rule matching ────────────────────────────────────────────────────────────
// Ported from @pushary/contracts (agent-hooks 0.56.0). This file cannot take a
// dependency — a Cursor plugin is cloned, not installed — so the logic is
// vendored. Keep it in step with packages/contracts/src/index.ts; the cases in
// scripts/pushary-gate.test.mjs mirror the ones in policy.test.ts.
//
// Previously this matched on tool NAME alone, which meant every argument rule was
// invisible here: a user's own `Bash(rm:*)` deny did nothing and `rm -rf` was
// auto-approved by a broad `Bash` allow. Cursor was strictly less safe than
// Claude Code for the same policy.

const MATCH_RANKS = ['none', 'tool', 'prefix', 'exact']
const matchRankWeight = (rank) => MATCH_RANKS.indexOf(rank)

const GLOB_MAX_WILDCARDS = 8
const GLOB_MAX_ARG_LENGTH = 4096

// Offset propagation rather than a compiled regex: several `**` render as `.*`
// and backtrack catastrophically on a long non-matching argument, which would
// hang this gate and, with failClosed, block the command.
const globMatches = (glob, text) => {
  let stars = 0
  for (const ch of glob) if (ch === '*') stars += 1
  if (stars > GLOB_MAX_WILDCARDS) return false

  const tokens = []
  let literal = ''
  const flush = () => { if (literal) { tokens.push({ literal }); literal = '' } }
  for (let i = 0; i < glob.length; i += 1) {
    if (glob[i] !== '*') { literal += glob[i]; continue }
    flush()
    if (glob[i + 1] === '*') { tokens.push({ any: true }); i += 1 } else { tokens.push({ any: false }) }
  }
  flush()

  const n = text.length
  let reach = new Uint8Array(n + 1)
  reach[0] = 1
  for (const token of tokens) {
    const next = new Uint8Array(n + 1)
    if (token.literal !== undefined) {
      for (let p = 0; p <= n - token.literal.length; p += 1) {
        if (reach[p] && text.startsWith(token.literal, p)) next[p + token.literal.length] = 1
      }
    } else {
      let open = 0
      for (let p = 0; p <= n; p += 1) {
        if (!token.any && p > 0 && text.charCodeAt(p - 1) === 47) open = 0
        if (reach[p]) open = 1
        if (open) next[p] = 1
      }
    }
    reach = next
  }
  return reach[n] === 1
}

const matchToolPattern = (pattern, toolName, arg) => {
  const open = pattern.indexOf('(')
  if (open === -1 || !pattern.endsWith(')')) return pattern === toolName ? 'tool' : 'none'
  if (pattern.slice(0, open) !== toolName || arg === undefined) return 'none'
  const inner = pattern.slice(open + 1, -1)
  if (inner.endsWith(':*')) return arg.startsWith(inner.slice(0, -2)) ? 'prefix' : 'none'
  if (inner.includes('*')) {
    if (arg.length > GLOB_MAX_ARG_LENGTH) return 'none'
    return globMatches(inner, arg) ? 'prefix' : 'none'
  }
  return arg === inner ? 'exact' : 'none'
}

// A rule with no repoKey applies everywhere; a scoped one only in its own repo,
// and never when the repo could not be established.
const repoMatches = (ruleRepoKey, currentRepoKey) => !ruleRepoKey || ruleRepoKey === currentRepoKey

// Rank first, then a repo-scoped rule over a workspace-wide one, then the longer
// pattern — the same precedence the hook applies.
const findBestMatch = (policies, toolName, arg, repoKey) => {
  let best
  let bestWeight = 0
  let bestScoped = -1
  let bestLength = -1
  for (const candidate of policies) {
    if (!repoMatches(candidate.repoKey, repoKey)) continue
    const rank = matchToolPattern(candidate.tool, toolName, arg)
    if (rank === 'none') continue
    const weight = matchRankWeight(rank)
    const scoped = candidate.repoKey ? 1 : 0
    const length = rank === 'prefix' ? candidate.tool.length : -1
    if (
      weight > bestWeight ||
      (weight === bestWeight && scoped > bestScoped) ||
      (weight === bestWeight && scoped === bestScoped && length > bestLength)
    ) {
      best = { policy: candidate, rank }
      bestWeight = weight
      bestScoped = scoped
      bestLength = length
    }
  }
  return best
}

// The destructive ceiling. A call the classifier flags must never auto-approve
// through a general bare-tool or wildcard rule, so the "destructive always asks"
// guarantee holds for wrapped or unlisted commands too. An explicit rule the user
// wrote still wins. Mirrors APPROVAL_FATIGUE_FLAG_PATTERNS in contracts.
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+-[a-z]*r/i,
  /\brmdir\b/i,
  /git\s+push[^\n]*(--force|--force-with-lease|\s-f\b)/i,
  /git\s+reset\s+--hard/i,
  /git\s+clean\s+-[a-z]*f/i,
  /\bdrop\s+(table|database|schema)\b/i,
  /\bdelete\s+from\b/i,
  /\btruncate\b/i,
  /\b(deploy|publish|release)\b/i,
  /\bnpm\s+publish\b/i,
  /\bsudo\b/i,
  /chmod\s+-?R?\s*777/i,
  /\bkubectl\s+delete\b/i,
  /\bterraform\s+(apply|destroy)\b/i,
  /\bdocker\s+system\s+prune\b/i,
]

const isDestructive = (command) => DESTRUCTIVE_PATTERNS.some((re) => re.test(command))

// The safe-read-only floor is deliberately NOT ported. It only ever loosens a
// decision, and hooks.json already routes just the risky commands here, so
// omitting it can cost an extra prompt but can never approve something unsafe.

const resolvePolicy = (config, toolName, modeOverride, command, repoKey) => {
  const match = findBestMatch(config.policies, toolName, command, repoKey)
  let base =
    match?.policy ??
    config.policies.find((p) => p.tool === '*') ??
    {
      tool: toolName,
      timeoutSeconds: config.defaultTimeoutSeconds,
      timeoutAction: config.defaultTimeoutAction,
      mode: config.defaultMode ?? 'push_first',
      pushFirstSeconds: config.defaultPushFirstSeconds ?? 20,
    }

  const governedBySpecificRule = match?.rank === 'exact' || match?.rank === 'prefix'
  const wouldAutoApprove = base.timeoutSeconds === 0 && base.timeoutAction === 'approve'
  if (!governedBySpecificRule && wouldAutoApprove && typeof command === 'string' && isDestructive(command)) {
    base = {
      tool: base.tool,
      timeoutSeconds: config.defaultTimeoutSeconds,
      timeoutAction: 'wait',
      mode: 'push_first',
      pushFirstSeconds: config.defaultPushFirstSeconds ?? 20,
    }
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
// toolTarget and actionBody are what let the server classify risk, drop the
// one-tap Approve on a dangerous call, and record a decision at the same grain as
// every other agent. Without them a destructive Cursor command arrived on the
// lock screen ungated.
const commandHead = (command) => command.trim().split(/\s+/).slice(0, 2).join(' ').slice(0, 120)

const askArgs = (command, project, ident) => ({
  question: `Allow this command?\n\n${command}`,
  type: 'confirm',
  context: `Cursor agent wants to run this in ${project}`,
  agentName: ident.agentName,
  sessionId: ident.sessionId,
  machineId: ident.machineId,
  toolName: 'Bash',
  toolTarget: commandHead(command),
  actionBody: command.slice(0, 4000),
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
    const [policy, modeState] = await Promise.all([getPolicy(apiKey), fetchModeState(apiKey, sessionId)])

    if (modeState.kill) return respond(deny('Stopped by user — this agent was halted from Pushary. Do not run this command.'))

    const tool = resolvePolicy(policy, 'Bash', modeState.mode, command, deriveRepoKey(input.cwd))
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

// Exported for scripts/pushary-gate.test.mjs. main() only runs when the gate is
// executed directly, so importing this file for a test does not read stdin.
export { matchToolPattern, resolvePolicy, isDestructive, normalizeRepoRemote, deriveRepoKey }

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (!isDirectRun) {
  // imported for tests
} else main().catch((error) => {
  process.stderr.write(`[pushary-gate] fatal: ${error?.message ?? error}\n`)
  respond(ask())
})
