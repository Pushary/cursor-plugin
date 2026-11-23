<p align="center">
  <img src="assets/logo.png" alt="Pushary" width="72" height="72" />
</p>

<h1 align="center">Pushary for Cursor</h1>

<p align="center">A control panel for your AI agent in Cursor. Get a push when work finishes, answer the agent from your phone, and approve risky commands before they run.</p>

---

## What it is

Pushary connects Cursor to your phone. When the agent finishes a task, needs a decision, or is about to run something risky, it reaches you with a push notification. You answer from the lock screen and the agent keeps going. It works even when you have stepped away from your computer.

## What it does

There are three things.

1. Notify. The agent sends a push when a long task finishes, or when a build, test, or deploy fails. The push can include what changed, the error, and suggested next steps.

2. Ask. The agent asks you questions through push: yes or no, multiple choice, or free text. It waits for your answer. The bundled instructions guide the agent to use Pushary for questions. Native editor question dialogs are not automatically intercepted.

3. Gate. Shell commands, file writes/edits/deletes, and third-party MCP calls reach your Pushary policy before execution. The policy can approve, deny, or wait for your answer. Cancelled or unverifiable decisions stop the action. Cursor’s generic file-tool hook does not enforce `ask`, so an unresolved file action is denied. File actions explicitly marked `not_gated` by the server proceed; shell/MCP hooks can hand off to Cursor’s prompt.

## What you get after you sign in

1. Sign in and pick a plan. New customers start with a 3-day trial.
2. Run `npx -y pushary@latest setup` once. It installs this plugin, links your key and registers the approval gate in Cursor.
3. When the Cursor agent needs a yes or an answer, the question arrives on your phone (the Pushary app for iOS and Android), on your Mac, or in the dashboard.
4. You answer with one tap, or type a short reply, and the agent keeps going. The dashboard keeps a record of what each agent asked and what you answered.

Read the [Cursor guide](https://pushary.com/docs/agents/guides/cursor?utm_source=github&utm_medium=oss-adapter&utm_campaign=cursor-plugin&utm_content=readme) for each step, or see [Cursor notifications on your phone](https://pushary.com/cursor-notifications?utm_source=github&utm_medium=oss-adapter&utm_campaign=cursor-plugin&utm_content=readme).

## Plans

Each plan starts with a 3-day trial for new customers. During the trial, Agent, Agent Pro and Team include 5 call minutes.

| Plan | Price | What you get |
| --- | --- | --- |
| [Agent](https://pushary.com/pricing?utm_source=github&utm_medium=oss-adapter&utm_campaign=cursor-plugin&utm_content=readme) | $9.99 a month | One person and every AI agent they run. Approve, deny or answer from your phone or Mac. 10 call minutes a month. |
| [Agent Pro](https://pushary.com/pricing?utm_source=github&utm_medium=oss-adapter&utm_campaign=cursor-plugin&utm_content=readme) | $19.99 a month | Everything in Agent, plus unlimited notifications, budgets and priority support. 20 call minutes a month. |
| [Team](https://pushary.com/teams?utm_source=github&utm_medium=oss-adapter&utm_campaign=cursor-plugin&utm_content=readme) | $59 a month for 5 people, $12 for each extra person | Each person gets their own agent’s questions. On supported hooks, route a step such as a production deploy to the teammate who approves it. See who answered in the shared record. Includes export and 60 shared call minutes a month. |

Cursor approvals reach you by push. Answer the request on your phone and the waiting session gets your decision. Voice calls are available for other supported agents. [Phone calls](https://pushary.com/calls?utm_source=github&utm_medium=oss-adapter&utm_campaign=cursor-plugin&utm_content=readme). [How calls work](https://pushary.com/docs/agents/phone-calls?utm_source=github&utm_medium=oss-adapter&utm_campaign=cursor-plugin&utm_content=readme)

## Install

You need two things: the plugin, and an API key.

### Option 1: CLI (recommended)

This also sets up Claude Code, Codex, and Hermes if you use them.

```bash
npx -y pushary@latest setup
```

### Option 2: Manual MCP

Add this to `.cursor/mcp.json` in your project, or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "pushary": {
      "type": "http",
      "url": "https://pushary.com/api/mcp/mcp",
      "headers": { "Authorization": "Bearer ${env:PUSHARY_API_KEY}" }
    }
  }
}
```

The plugin and CLI installer use the same decision service. Manual MCP-only configuration provides questions and notifications, but does not install approval or activity hooks.

## Set your API key

The plugin reads your key from the `PUSHARY_API_KEY` environment variable. Create a key in the dashboard under [Agent settings](https://pushary.com/dashboard/agent/settings), then add it to your shell profile:

```bash
echo 'export PUSHARY_API_KEY="pk_xxx.xxx"' >> ~/.zshrc
source ~/.zshrc
```

Install the Pushary app on your phone (or turn on browser notifications) so the agent can reach you.

## Troubleshooting

macOS GUI apps do not read `.zshrc`. If Settings > MCP shows pushary in red after you set the env var, launch Cursor from a terminal where `PUSHARY_API_KEY` is exported, or set the variable system-wide so GUI apps see it.

## What is in the plugin

| Part | File | What it does |
|------|------|--------------|
| MCP server | `mcp.json` | Connects Cursor to the Pushary tools: `send_notification`, `ask_user`, `wait_for_answer`, `cancel_question`, `list_sessions` |
| Rule | `rules/pushary.mdc` | Always on guidance so the agent uses Pushary on its own |
| Skill | `skills/pushary/SKILL.md` | Full tool reference: parameters, examples, return values |
| Hook | `hooks/hooks.json` and `scripts/pushary-gate.mjs` | Evaluates tool approvals and reports session/tool activity |
| Commands | `commands/` | `/pushary-test` and `/notify-when-done` |

## How the gate decides

The hooks register the supported execution boundaries; your dashboard policy decides which actions need approval. No shell-command regex hides a tool from policy evaluation. Lifecycle hooks report session starts, turn completion, tool results, compaction, and subagent activity.

Timeout approvals apply only after the configured wait actually elapsed. Short editor hook budgets can end a wait earlier; cancellation is attempted before handoff. An uncertain cancellation denies the action. Local plugin installation does not install hooks into remote or cloud agent environments.

## For teams

On [Pushary for Teams](https://pushary.com/teams?utm_source=github&utm_medium=oss-adapter&utm_campaign=cursor-plugin&utm_content=readme-teams), each person installs the plugin and connects their own Cursor. Their agent's questions go to them. An owner or admin can send a chosen step to someone else with a routing rule in **Policies**, under **Approval routing**, such as `Bash(git push:*)` in the `infra` repository, routed to the Admins role. Cursor's shell commands match `Bash(...)` rules, so the same rule also covers teammates on Claude Code, Codex or Gemini CLI. Whoever answers in the phone app, Mac app or dashboard is recorded by name.

- Cursor gives a hook about 60 seconds, so a lead has to answer within that. If nobody does, the step goes back to Cursor, and a yes given there isn't recorded.
- The phone can only deny risky steps such as a force push or `rm -r`. Approve those in the dashboard.

Team is $59 a month for 5 people, plus $12 for each extra person.

## Commands

- `/pushary-test` sends a test push so you can confirm delivery.
- `/notify-when-done` tells the agent to push a summary when the current task finishes.

## Development

`skills/pushary/SKILL.md` mirrors the Pushary skill that ships with the Pushary CLI (`pushary` on npm). Keep the two the same.

Test the plugin locally before publishing:

```bash
ln -s "$(pwd)" ~/.cursor/plugins/local/pushary
```

Then reload Cursor with Developer: Reload Window.

## Related repositories

- [Pushary for VS Code](https://github.com/Pushary/vscode-plugin): the same gate for the VS Code agent.
- [Pushary skill](https://github.com/Pushary/pushary-skill): the skill and setup for Claude Code, Codex, Gemini CLI and more.
- [Pushary for Mac](https://github.com/Pushary/pushary-mac): answer from the notch on your Mac.

## Security

Your key is read at runtime from `PUSHARY_API_KEY`. The gate script has no dependencies. It sends approval and activity data to pushary.com by default; `PUSHARY_BASE_URL` can change that endpoint. Read `scripts/pushary-gate.mjs` to see exactly what it sends. See `SECURITY.md` for details.

## License

MIT. See `LICENSE`.
