# ADR 0004: the assistant is optional and loads one provider at a time

- Status: accepted (2026-09-06)
- Evidence: [issue #328](https://github.com/evb0110/evb-viewer/issues/328),
  source and measurement at commit `35b9779d0ef97cff342b0d8c414d771c8561a9e0`

## Context

EVB Viewer supports an in-app assistant through two existing providers, the
Codex CLI and the Claude Agent SDK. The current lazy facade defers loading the
assistant runtime, but its first state query loads `codexAssistant.ts`, which
imports both provider implementations and initializes shared runtime state.
That makes an availability check heavier than it should be and blurs which
code owns chat history, provider status, saved selection, credentials, and MCP
access.

The assistant is optional viewer functionality. Ordinary startup, viewing,
editing, and saving must work without loading a provider or starting an
assistant runtime. The existing `assistantPanelEnabled` setting already
expresses this choice and defaults to `false`.

## Decision

Keep both supported providers. Shared code owns chat lifecycle, tool
registration, cancellation, turn fencing, and persistence. A thin adapter per
provider owns vendor streaming and protocol translation. Provider differences
that users can observe remain supported.

Load the assistant runtime only for an operation that needs it. Load only the
selected provider. Status and availability queries inspect installation,
account, and capability state without starting a provider runtime. An explicit
disabled setting refuses assistant initialization and tool execution. Issue
[#327](https://github.com/evb0110/evb-viewer/issues/327) completes this split
without replacing the existing lazy facade.

Retain the Claude Agent SDK and the pinned Codex CLI acquisition path. The
Codex artifact manifest, publisher URL, redirects, archive size, and SHA-256
checks remain part of that path. Lazy loading reduces startup work. It does not
claim to reduce installer size.

### State owners

There is no single owner for every kind of assistant state. Each durable or
runtime concern keeps one owner:

| State | Owner | Required compatibility |
|---|---|---|
| Durable chat transcript, scope, selected provider and model, turn boundary, and provider thread id | `AssistantChatPersistence`, used through `createAssistantChatSessionStore` | Preserve schema version 1 records, session keys, archives, snapshot blobs, and recovery behavior. Both providers use this store. |
| Live session messages, active turn, scope binding, and in-flight provider handle | `createAssistantChatSessionStore` in the main process | The renderer receives a projection and never becomes the chat source of truth. |
| Provider installation, authentication, account, models, and runtime status | `assistantProviderState.ts` and the provider lifecycle in the main process | Keep Codex and Claude status separate. Availability reads do not create a runtime. |
| Preferred provider and per-provider model in the renderer | `assistantSelectionPreference.ts` | Preserve the existing local-storage format and legacy model migration. A started session records its effective selection in the durable chat store. |
| Assistant availability | The normal settings store and `assistantPanelEnabled` contract | Preserve the `false` default. Disabling the setting shuts down the embedded runtime and prevents new assistant work. |
| Provider credentials | The existing Codex home and Claude Agent SDK credential mechanisms | Do not copy credentials into chat persistence or renderer state. |
| External local MCP bearer token | `localMcpTokenStore.ts` | Preserve owner-only storage checks, atomic rotation, and stable identity checks. |
| Embedded MCP token and active document binding | `mcpServer.ts` and `assistantMcpSessionScope.ts` | Keep the token process-local and bind every internal request to the active window, tab, document identity, and revision. |

The renderer may cache selections and display state, but those values are
projections. A renderer reload reconstructs sessions and provider status from
the main process and durable owners above. Issue
[#329](https://github.com/evb0110/evb-viewer/issues/329) consolidates the shared
chat lifecycle while preserving saved conversations, credentials, settings,
and both provider capabilities. It adds a versioned migration only if its
implementation demonstrates a schema change.

### MCP boundary

Keep the existing local MCP implementation and its access controls. The
embedded assistant uses a random loopback port, a process-local bearer token,
and an active assistant-session binding. The separately enabled external MCP
server keeps its stable loopback host and name, configurable default port,
stored bearer token, and current HTTP and compatibility proxy transports.
Existing Codex CLI, Claude Code, and Cursor callers continue to work.

The embedded MCP boundary is an internal integration point for the supported
assistant. The separately enabled external loopback server and its current
HTTP and compatibility proxy transports remain supported for existing callers.
Neither endpoint becomes a non-loopback network service or plugin framework,
and this decision adds no new third-party API compatibility promise. New
assistant code reuses the existing MCP tools and workspace bridge rather than
adding another command path.

### Production code budget

At the decision base, the assistant-owned production scope contains 108 tracked
TypeScript and Vue files and 28,777 code lines. The count excludes tests,
generated and vendored code, blanks, comments, documentation, localization
catalogs, and shared host components whose main responsibility is outside the
assistant. It includes these paths:

- `electron/features/agent/**`
- `app/modules/agent-panel/**`
- `app/modules/workspace-shell/agent/**`
- `packages/contracts/agent*.ts`
- `app/components/settings/SettingsAgentPanel.vue`
- `app/composables/useAssistantPanel.ts`
- `app/modules/workspace-shell/composables/useAssistantPanelResize.ts`
- `app/platform/browser-api/browserAgentCapability.ts`

The maintained file manifest is
`docs/internal/assistant-production-files.txt`. Any commit that moves an
assistant production file updates its entry in the same change. New assistant
production files must be added. Removing an entry requires deleting its code,
not relocating it to an unlisted path.

Run the baseline from the repository root at the recorded commit:

```sh
pnpm dlx cloc@2.6.0-cloc \
  --list-file=docs/internal/assistant-production-files.txt \
  --include-lang=TypeScript,'Vuejs Component' --json
```

The command reports 30,931 physical lines, with 2,041 blank lines, 113 comment
lines, and 28,777 code lines. That 28,777-line result is the hard no-growth
budget for #329. Its after-count uses the updated manifest and must not count a
move as a deletion. A 15 percent reduction is the planning target. It never
permits removal of supported behavior, coverage, data compatibility, or
provider differences.

## Consequences

- #327 separates non-initializing status reads from provider startup and makes
  provider imports selective.
- #329 shares backend-independent lifecycle code and reports the complete
  before and after scope. Vendor protocol code stays in its adapter.
- `assistantPanelEnabled`, saved conversations, provider selection, account
  state, credentials, local MCP behavior, and tool access rules remain
  compatible.
- Installer size may stay unchanged even when startup loads less code.

## Revisit when

Revisit this decision only if a supported provider cannot use the shared
session and MCP contracts without losing an observable capability, or if a
documented security requirement forbids the current loopback MCP design.
