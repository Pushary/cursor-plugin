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
import { normalizeRepoRemote } from './pushary-gate.mjs'

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
