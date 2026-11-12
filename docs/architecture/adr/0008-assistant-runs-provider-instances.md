# ADR 0008: the assistant runs configured provider instances

- Status: accepted (2026-11-12). Supersedes the credential, runtime and status
  parts of [ADR 0004](0004-assistant-is-optional-with-provider-adapters.md);
  its opt-in, lazy loading, persistence and MCP decisions stand.
- Evidence: the owner's report of 2026-11-12 (installed 0.1.508 showed
  "Checking EVB Assistant" until it failed without an error text) and the
  reproduction below.

## Context

EVB ran Codex with a private `CODEX_HOME` under its user data, holding a
second ChatGPT login that only EVB refreshed. That login went stale. Codex
refreshes an expired login before it answers `initialize`; with OpenAI
unreachable the refresh never returned, so every start and every model-list
probe waited 30 seconds and failed. An empty home answered in about 100 ms and
the owner's own `~/.codex` in about 70 ms. Panel opening awaited both
providers' discovery, a single runtime state chose the whole panel view, and
the error text was suppressed once a toast had reported it, so a Claude user
saw a Codex failure without its cause.

The owner runs two Codex and two Claude setups through T3 Code: the default
homes, and proxy routes with their own home, launch arguments and environment.
EVB had one hard-wired Codex and one Claude and could not use either proxy.

## Decision

The assistant runs **provider instances**, as T3 Code does. An instance names
a driver (Codex or Claude), an executable, a home (`CODEX_HOME`, a Codex
shadow home, or `CLAUDE_CONFIG_DIR`), launch arguments and environment rows.
Without configuration EVB uses two instances, Codex in `~/.codex` and Claude in
`~/.claude`. Settings can add, edit, disable and import instances from T3
Code. Instances live in `<userData>/assistant/providers.json`, owned by the
main process; secret values are encrypted with Electron `safeStorage`, never
reach the renderer, and are not stored when encryption is unavailable.

**Credentials stay where the provider keeps them.** EVB never copies or links
a login. Codex writes `auth.json` by writing a temporary file and renaming it,
so a copied or linked file would fork the refresh-token chain and sign out the
user's own CLI. A Codex shadow home keeps its own login and shares the rest,
as in T3 Code; EVB creates one only when it does not exist.

**Tool isolation is per process.** Codex merges `-c` overrides into the
instance's configuration, so EVB disables each MCP server and plugin of that
configuration by name, turns off shell, apps, memories, hooks and multi-agent
features, sets a read-only sandbox, and adds only its embedded MCP server.
After start, any other server that still exposes tools stops the instance with
a named error. Claude keeps `settingSources: []`, no built-in tools and
`strictMcpConfig`.

**Status is per instance and never gates the panel.** Each enabled instance
has one status: checking, ready, warning, error, missing or disabled, with an
authentication state and the instance's own message. Reads return cached
status at once; a probe runs one instance's check in the background and
publishes its result alone. Codex has 10 seconds from spawn to `initialize`
and 15 seconds for a whole status check; Claude has 25 seconds. On expiry EVB
stops the process it started and reports what did not answer. Nothing retries
by itself; Refresh or a send starts the next attempt.

**One chat runtime per instance.** A Codex instance runs one app-server for
all its chats; Claude runs one SDK query per chat. A chat belongs to one
instance, keyed `<instanceId>:<scope>`; the default instance ids `codex` and
`claude` keep earlier keys valid. A saved provider thread is resumed when the
instance can find it; one it cannot, such as a thread from the retired private
Codex home, starts a new provider context and keeps the visible transcript.

**The chat is an ordered timeline.** User, assistant, reasoning, tool and
system items are owned and persisted by the main process (schema 1, with new
optional fields) and streamed to the renderer as upserts and text deltas. The
panel follows T3 Code's chat layout.

## Consequences

- A stalled provider cannot hold the panel: another instance stays usable and
  the stalled one shows why.
- Proxy routes configured for T3 Code work in EVB after one import.
- The private `<userData>/assistant/codex-home` is no longer used. It is left
  in place; nothing deletes a login.
- EVB depends on Codex's `config/read`, `mcpServerStatus/list` and `-c`
  semantics; the fail-closed check turns a change there into an explicit error
  rather than extra tools.
