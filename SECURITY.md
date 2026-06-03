# Security

## Reporting a vulnerability

Email **security@pushary.com** with details and reproduction steps. Please do not open a public
issue for security reports. We aim to acknowledge within 72 hours.

## What this plugin sends

The plugin connects Cursor to the Pushary MCP server at `https://pushary.com/api/mcp/mcp` using
the API key you provide via the `PUSHARY_API_KEY` environment variable. No key is committed to
this repository.

The permission gate (`scripts/pushary-gate.mjs`) runs only on shell commands matching the regex
in `hooks/hooks.json`. For a matched command it sends, over HTTPS to Pushary:

- the command text,
- the basename of the working directory (e.g. `my-repo`, not the full path),
- an agent label (`Cursor - <project>`).

It contacts no host other than `pushary.com`, has no third-party dependencies, and stores
nothing on disk. The full source is in this repository — read it before installing.

## Fail-closed by design

The gate is configured `failClosed: true`. If the gate cannot produce a decision (crash,
timeout, invalid output), Cursor **blocks** the matched command rather than letting it run
unapproved. When Pushary is reachable but you don't answer in time, it falls back to Cursor's
own in-editor approval prompt.
