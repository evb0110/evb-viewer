# The assistant

EVB Viewer can host an AI assistant that operates the open document for you. It
is optional, it is off when you install the app, and the offline features never
use it.

## What it never does

- It is off by default. The setting is `assistantPanelEnabled` and it ships
  disabled. While it is disabled, the app refuses to start an assistant runtime
  at all.
- The app ships no API key and runs no service of its own. You sign in with your
  own Codex or Claude account, and usage is billed to that account.
- Scan cleanup, OCR, search, export, and annotation never call it. You can use
  the whole document workflow with the assistant switched off for good.
- Your documents are never uploaded in bulk. The assistant asks for the pages it
  needs through the same tools listed in
  [connecting an MCP client](mcp-clients.md), one bounded request at a time.

## Turning it on

1. Open Settings and enable the assistant panel.
2. Make sure a provider is signed in. EVB uses the command-line tools you
   already have, with their own logins:
   - **Codex** uses your `~/.codex` login. If no `codex` is on your `PATH`, the
     app can download a pinned release and verify it against a checked-in
     checksum. You can also sign in with ChatGPT from the panel.
   - **Claude** uses Claude Code and your `~/.claude` login. Install Claude Code
     and sign in there first. A Claude subscription and an Anthropic API key
     both work.
3. Open the panel from the toolbar, and open a document.

Usage is billed to whichever account the provider is signed in with.

Disabling the setting hides the panel and shuts down the embedded runtime.

## Provider instances

Settings lists the provider instances the assistant can use. Out of the box
there are two, Codex and Claude, each using your normal login. Add more when
you run a provider more than one way, for example a second Codex account or a
proxy:

- **Executable**: the `codex` or `claude` to run. Empty means the one EVB finds.
- **Home**: the directory that holds that instance's login and settings
  (`CODEX_HOME` or `CLAUDE_CONFIG_DIR`). Codex can also use a **shadow home**,
  which shares sessions and settings with the home but keeps its own login.
- **Launch arguments** and **environment** variables, such as a proxy's
  `model_provider` override or `ANTHROPIC_BASE_URL`. Mark a value secret and
  EVB encrypts it with your system's credential store and never shows it again.

**Import from T3 Code** copies the Codex and Claude instances you set up in T3
Code, including proxies. EVB never copies a login: each instance signs in
where its provider keeps the login, so your other tools stay signed in.

Whatever the instance's own configuration adds, such as MCP servers, plugins
or shell access, the assistant gets only EVB's document tools.

## Choosing a provider and a model

The picker in the composer lists every enabled instance with its models.

- **Instance and model.** Switch at any time. Each document keeps a separate
  chat per instance. A cheaper model is usually enough for navigation, search,
  and bookmark work; save the stronger one for reading many pages and
  rebuilding structure.
- **Reasoning effort** and **speed**, where the model supports them. Higher
  effort costs more and takes longer. Raise it for a task that has to read and
  compare a lot of pages, and leave it low for everything else.

## Using it

Chats are tied to the file. Each document keeps its own conversation, switching
tabs switches the chat with it, and **New chat** starts a fresh one for the
document you are on. With no document open there is nothing to talk about, and
the panel says so.

The empty panel offers three presets, which are the tasks the assistant is
best at: add bookmarks, number pages, and check OCR readiness. They are a good
way to see how it works before you write your own request.

While a turn is running you are not locked out. Type and send, and the message
is queued as a steer: the current turn stops and your correction goes in
without losing the conversation. **Stop** interrupts outright. Each turn reports
the tools it called and the input and output tokens it used, so the cost is
visible as you go rather than at the end of the month.

You can paste or attach images to a message, which is the fastest way to ask
about a page that is rendering oddly. Image attachments need a turn that is not
already running.

## When a provider does not answer

The conversation and the composer stay on screen, and the panel says what is
wrong with the selected instance, in that provider's own words:

- **Not installed**: the executable was not found. For Codex the panel can
  install a pinned, verified release; otherwise set the executable in Settings.
- **Sign in**: the instance has no login. Codex signs in with ChatGPT in your
  browser; for Claude, sign in with Claude Code.
- **Did not answer**: a provider that does not start within 10 seconds, or
  does not finish its status check within 15, is reported as not answering. A
  provider that refreshes an expired login cannot do so without network
  access, so check the connection, or switch to another instance meanwhile.
- **Desktop app required**: the browser build has no assistant. It uses local
  tools that a web page cannot run.

After changing anything outside the app, an install, a sign-in, or an
environment variable, use **Refresh**. The app does not watch your shell.

If a reply fails, the message appears where the reply would be, with Retry
when trying again can help.

## What to ask it

The assistant is most useful on scanned books, where the structure has to be
rebuilt by reading the pages.

- Rebuild the outline from the book's printed table of contents.
- Apply page labels so the viewer's page numbers match the printed ones.
- Find every mention of a name across a long scanned volume.
- Report which pages have a thin or missing OCR text layer.
- Summarize a chapter, or pull the figure captions out of one.

It can also do the ordinary things: navigate, search, read a page, add a note,
and add bookmarks.

## Where it runs

The embedded assistant runs the selected instance's provider as a child
process limited to EVB's document tools, and talks to the document over a
private loopback server on a random port behind a bearer token. Each request is bound to one
window, one tab, one document, and one revision, so an assistant in one window
cannot read or change a document in another. The design decisions are recorded in
[ADR 0004](../architecture/adr/0004-assistant-is-optional-with-provider-adapters.md)
and [ADR 0008](../architecture/adr/0008-assistant-runs-provider-instances.md).
