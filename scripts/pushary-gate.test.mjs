// What is left to test in the gate itself.
//
// This file used to cover the vendored policy engine: pattern matching, argument
// rules, the destructive ceiling and repo scoping. None of that lives here any
// more. The gate asks POST /api/agent/gate, which runs the same `resolveGate` as
// every other client, and those behaviours are tested once against the engine in
// packages/contracts/src/gate.test.ts rather than once per copy.
//
// What remains is the one thing a server cannot answer: which repository this
// checkout is in. Deriving it means walking parent directories for a `.git` and
// reading its config, so the gate still does it and sends the result.
//
// Run: node --test scripts/pushary-gate.test.mjs

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describeRequest, normalizeRepoRemote } from './pushary-gate.mjs'

describe('repo identity', () => {
  it('collapses the forms of one remote', () => {
    for (const r of ['https://github.com/acme/api.git', 'git@github.com:acme/api.git', 'ssh://git@github.com:22/acme/api.git']) {
      assert.equal(normalizeRepoRemote(r), 'github.com/acme/api', r)
    }
  })

  it('never lets a credential survive', () => {
    const key = normalizeRepoRemote('https://user:ghp_SECRET@github.com/acme/api.git')
    assert.equal(key, 'github.com/acme/api')
    assert.ok(!key.includes('ghp_') && !key.includes('@'))
  })

  it('returns undefined without a stable identity', () => {
    for (const r of ['', '../rel', 'file:///Users/dev/repo']) assert.equal(normalizeRepoRemote(r), undefined, r)
  })
})

// The gate answers two Cursor events now, and they arrive on the same stdin with
// different fields. What each one turns into is the only thing standing between
// an MCP call and being gated as if it were a shell command.
describe('what the gate was asked about', () => {
  it('names an MCP call the way every other agent names one', () => {
    const request = describeRequest({
      hook_event_name: 'beforeMCPExecution',
      tool_name: 'create_issue',
      mcp_server_name: 'github',
      tool_input: '{"title":"x"}',
    })

    // `mcp__<server>__<tool>` is what `validateToolPattern` accepts and what
    // Claude Code sends, so one policy rule covers the tool on both agents. A
    // Cursor-only spelling would silently miss every rule a user already wrote.
    assert.equal(request.toolName, 'mcp__github__create_issue')
    assert.deepEqual(request.toolInputs, [{ tool: 'mcp__github__create_issue', params: '{"title":"x"}' }])
    assert.match(request.display, /create_issue/)
  })

  it('still reads a shell command, including from a payload with no event name', () => {
    const named = describeRequest({ hook_event_name: 'beforeShellExecution', command: '  rm -rf /tmp/x  ' })
    assert.equal(named.toolName, 'Bash')
    assert.equal(named.toolTarget, 'rm -rf')

    // An older Cursor that omits `hook_event_name` must keep working exactly as
    // it did when shell was the only registered event.
    assert.equal(describeRequest({ command: 'git push' }).toolName, 'Bash')
  })

  /**
   * `beforeMCPExecution` is registered with NO matcher, so every MCP call in the
   * editor reaches this gate, ours included. Gating our own tools deadlocks: the
   * approval for `ask_user` cannot reach the phone until the `ask_user` call it
   * is gating goes through. With `failClosed: true` on that entry it is worse
   * than a hang, because a timeout turns into a denial of the user's own
   * question.
   *
   * The Claude hook carries this guard three times over and calls it a
   * precaution, because its matcher does not route these there. Here it is the
   * only thing standing between the two.
   */
  it('never gates Pushary\'s own MCP tools', () => {
    for (const tool of ['ask_user', 'wait_for_answer', 'send_notification', 'propose_scope']) {
      assert.equal(
        describeRequest({
          hook_event_name: 'beforeMCPExecution',
          tool_name: tool,
          mcp_server_name: 'pushary',
          tool_input: '{}',
        }),
        null,
        `mcp__pushary__${tool} must reach Cursor's own prompt, not ours`,
      )
    }

    // A neighbour whose name merely starts the same way is still gated. The
    // guard is on the `mcp__pushary__` prefix, not on "contains pushary".
    assert.equal(
      describeRequest({
        hook_event_name: 'beforeMCPExecution',
        tool_name: 'run',
        mcp_server_name: 'pushary-clone',
        tool_input: '{}',
      }).toolName,
      'mcp__pushary-clone__run',
    )
  })

  it('declines an event it does not gate rather than calling it Bash', () => {
    // beforeReadFile is registered by nobody here on purpose: its response
    // schema has no `ask`, so the no-opinion path this gate takes on every error
    // has nothing to return. If one ever arrives, it must not be mistaken for a
    // shell command carrying no command.
    assert.equal(describeRequest({ hook_event_name: 'beforeReadFile', file_path: '/etc/passwd' }), null)
    assert.equal(describeRequest({ hook_event_name: 'beforeMCPExecution' }), null)
    assert.equal(describeRequest({}), null)
  })
})
