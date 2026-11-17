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
Without configuration EVB uses the default homes `~/.codex` and `~/.claude`
and discovers independent PATH executables named exactly `codex`, `claude`,
`codex-<name>` or `claude-<name>`. Each executable must identify the provider
within a three-second version check; its bounded metadata probe must report
models before any are selectable. Wrappers retain their executable identity and
inherited environment. The native default Claude home leaves its config environment
unset, preserving the existing macOS Keychain identity. Discovered setups with equal
executable/home/arguments tuples are deduplicated; different homes stay separate.
Explicit EVB records are kept as entered with stable IDs and shadow equal discovered
setups. Settings can add, edit and disable instances. A setup known only to
another application's settings requires an explicit Settings entry; EVB reads
no T3 installation data and has no T3 importer. Instances live in `<userData>/assistant/providers.json`, owned by the
main process; secret values are encrypted with Electron `safeStorage`, never
reach the renderer, and are not stored when encryption is unavailable.

Version checks close stdin and terminate their process tree before returning.
Unidentified or timed-out PATH helpers are silently ignored. EVB's retired
managed `codex/bin` folder is excluded from automatic discovery; existing files
there are left in place.

Named Windows Claude script wrappers (`.cmd`, `.bat`, `.ps1`) are excluded from
automatic discovery because the SDK cannot preserve their executable identity.
Explicit entries fail readably and direct users to the native executable;
the standard Claude shim can resolve its installed native or JavaScript entry.

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
status after local setup discovery completes. Provider metadata checks run in the
background, each publishing its result alone. Codex has 10 seconds from spawn to `initialize`
and 15 seconds for a whole status check; Claude has 15 seconds. On expiry EVB
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
panel follows T3 Code's chat layout. Claude prose arrives as completed SDK
snapshots, each keyed by its native message UUID, preserving progress and final
answer items in arrival order. Thinking still uses live deltas. Tool calls keep
their native tool-use IDs and settle individually on user or assistant
tool-result blocks; `is_error` marks failure. Summaries and the turn result do
not overwrite settled outcomes. Turn finalization closes only items still active.

## Consequences

- A stalled provider cannot hold the panel: another instance stays usable and
  the stalled one shows why.
- Independent proxy launchers work without another sign-in; setups registered
  only in another application can be added in Settings.
- The private `<userData>/assistant/codex-home` is no longer used. It is left
  in place; nothing deletes a login.
- EVB depends on Codex's `config/read`, `mcpServerStatus/list` and `-c`
  semantics; the fail-closed check turns a change there into an explicit error
  rather than extra tools.

## Installed runtimes and reported catalogs

EVB bundles or downloads neither CLI. Codex uses its installed executable's
official app-server protocol through EVB's existing transport. Claude uses the
official Claude Agent SDK 0.3.321 with `pathToClaudeCodeExecutable` set to the
installed executable; SDK platform binary packages are excluded. Previous EVB
managed binaries and logins remain untouched, but are no longer selected.

The exact setup's reported catalog is authoritative: Codex pages `model/list`
after `account/read`; Claude calls `initializationResult()` with a never-yielding
prompt and no inference. Static metadata cannot add a selectable model or
remove an older family. A stale stored selection falls back to a reported
default or the first reported row. Model effort and speed compile only from
reported capabilities, following T3's model option compilation.

Structured failures follow T3's provider failure semantics, adapted to EVB's
existing error envelope. The boundary unwraps nested provider JSON, retains
classification, native code and retryability, and bounds readable text after
removing credentials, URLs and hosts. No automatic retry is added. Permanent
model failures need Refresh or another selection; transient failures carry the
retryable flag for the panel's Retry action.

Adapted T3 Code sources are pinned to
`0b6f482dc5d5ee64d7e90d1bac342756db9bfe68` under MIT; the bundled notices list
the modules. EVB retains its MCP bridge, document scope, persistence, opt-in and
ordered event owner.

When EVB is opened from the Dock or Finder, the main process reads the user’s
interactive login-shell environment once, with a five-second limit. Discovery
uses that PATH, and provider launches and metadata probes inherit the same
environment before applying setup overrides. A terminal launch keeps its inherited
environment. If the shell read fails, EVB uses the inherited environment. Shell
environment changes take effect after restarting EVB. Values stay in main-process
memory and are never sent to the renderer or stored.
