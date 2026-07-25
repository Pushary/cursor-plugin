// Parity tests for the vendored policy logic in pushary-gate.mjs.
//
// The gate cannot depend on @pushary/contracts — a Cursor plugin is cloned, not
// installed — so the matcher is vendored. These cases mirror policy.test.ts in
// the Pushary monorepo. If they drift, Cursor silently resolves a different
// policy from every other agent, which is the bug this file exists to prevent.
//
// Run: node --test scripts/pushary-gate.test.mjs

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { matchToolPattern, resolvePolicy, isDestructive, normalizeRepoRemote } from './pushary-gate.mjs'

const base = {
  defaultTimeoutSeconds: 60,
  defaultTimeoutAction: 'escalate',
  defaultMode: 'push_first',
  defaultPushFirstSeconds: 20,
}
const cfg = (...policies) => ({ ...base, policies })
const allow = { timeoutSeconds: 0, timeoutAction: 'approve', mode: 'terminal_only', pushFirstSeconds: 0 }
const denyRule = { timeoutSeconds: 0, timeoutAction: 'deny', mode: 'push_only', pushFirstSeconds: 0 }
const autoApproves = (p) => p.timeoutSeconds === 0 && p.timeoutAction === 'approve'

describe('matchToolPattern', () => {
  it('matches bare, exact and prefix forms', () => {
    assert.equal(matchToolPattern('Bash', 'Bash', 'npm test'), 'tool')
    assert.equal(matchToolPattern('Bash(git status)', 'Bash', 'git status'), 'exact')
    assert.equal(matchToolPattern('Bash(npm test:*)', 'Bash', 'npm test -- --watch'), 'prefix')
    assert.equal(matchToolPattern('Bash(npm test:*)', 'Bash', 'npm install'), 'none')
  })

  it('checks :* before globs so destructive prefixes keep their meaning', () => {
    assert.equal(matchToolPattern('Bash(rm -rf:*)', 'Bash', 'rm -rf /tmp/x'), 'prefix')
  })

  it('supports globs', () => {
    assert.equal(matchToolPattern('Bash(deploy *)', 'Bash', 'deploy staging'), 'prefix')
    assert.equal(matchToolPattern('Bash(deploy *)', 'Bash', 'deploy'), 'none')
  })

  it('does not backtrack on adversarial star patterns', () => {
    const started = Date.now()
    assert.equal(matchToolPattern(`Bash(${'*'.repeat(8)}x)`, 'Bash', 'a'.repeat(4000)), 'none')
    assert.ok(Date.now() - started < 1000, 'must not backtrack')
  })
})

describe('argument rules, which the gate previously ignored entirely', () => {
  it("honours a user's explicit deny under a broad allow", () => {
    const config = cfg({ tool: 'Bash', ...allow }, { tool: 'Bash(rm:*)', ...denyRule })
    const resolved = resolvePolicy(config, 'Bash', null, 'rm -rf /important', undefined)
    assert.equal(resolved.timeoutAction, 'deny')
    assert.equal(autoApproves(resolved), false)
  })

  it('honours the preset always-ask rule for force pushes', () => {
    const config = cfg({ tool: 'Bash', ...allow }, { tool: 'Bash(git push:*)', timeoutSeconds: 60, timeoutAction: 'wait', mode: 'push_first', pushFirstSeconds: 20 })
    assert.equal(resolvePolicy(config, 'Bash', null, 'git push --force origin main', undefined).timeoutAction, 'wait')
  })

  it('prefers an exact rule over a matching prefix rule', () => {
    const config = cfg({ tool: 'Bash(git:*)', ...denyRule }, { tool: 'Bash(git status)', ...allow })
    assert.equal(autoApproves(resolvePolicy(config, 'Bash', null, 'git status', undefined)), true)
  })
})

describe('destructive ceiling', () => {
  it('refuses to auto-approve a destructive command through a bare-tool allow', () => {
    const resolved = resolvePolicy(cfg({ tool: 'Bash', ...allow }), 'Bash', null, 'rm -rf /important', undefined)
    assert.equal(autoApproves(resolved), false)
    assert.equal(resolved.timeoutAction, 'wait')
  })

  it('refuses through a wildcard allow too', () => {
    assert.equal(autoApproves(resolvePolicy(cfg({ tool: '*', ...allow }), 'Bash', null, 'git push --force origin main', undefined)), false)
  })

  it('still lets an explicit rule the user wrote win', () => {
    const config = cfg({ tool: 'Bash', ...allow }, { tool: 'Bash(rm -rf:*)', ...allow })
    assert.equal(autoApproves(resolvePolicy(config, 'Bash', null, 'rm -rf /tmp/x', undefined)), true)
  })

  it('leaves ordinary commands alone', () => {
    assert.equal(autoApproves(resolvePolicy(cfg({ tool: 'Bash', ...allow }), 'Bash', null, 'npm test', undefined)), true)
  })

  it('flags the classifier set', () => {
    for (const c of ['rm -rf /', 'sudo reboot', 'git reset --hard', 'terraform destroy', 'npm publish', 'DROP TABLE users']) {
      assert.equal(isDestructive(c), true, c)
    }
    assert.equal(isDestructive('npm test'), false)
  })
})

describe('repo scoping', () => {
  const scoped = { tool: 'Bash', repoKey: 'github.com/acme/api', ...denyRule }

  it('applies a scoped rule only in its own repository', () => {
    assert.equal(resolvePolicy(cfg(scoped), 'Bash', null, 'npm test', 'github.com/acme/api').timeoutAction, 'deny')
    assert.notEqual(resolvePolicy(cfg(scoped), 'Bash', null, 'npm test', 'github.com/acme/web').timeoutAction, 'deny')
  })

  it('never applies a scoped rule when the repository is unknown', () => {
    assert.notEqual(resolvePolicy(cfg(scoped), 'Bash', null, 'npm test', undefined).timeoutAction, 'deny')
  })

  it('prefers the scoped rule at equal rank', () => {
    const config = cfg({ tool: 'Bash', ...allow }, scoped)
    assert.equal(resolvePolicy(config, 'Bash', null, 'npm test', 'github.com/acme/api').timeoutAction, 'deny')
  })
})

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
