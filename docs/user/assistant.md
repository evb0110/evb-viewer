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
2. Pick a provider, and sign in. Neither provider uses a desktop app; both run a
   command-line tool.
   - **Codex** signs in through your system browser with a ChatGPT account. You
     do not have to install anything: if no `codex` is on your `PATH`, the app
     downloads a pinned release and verifies it against a checked-in checksum.
   - **Claude** runs through the Claude Code CLI, so install Claude Code first
     and sign in there. The app finds it on your `PATH`, or at
     `CLAUDE_CODE_PATH` if you set one. A Claude subscription and an Anthropic
     API key both work.
3. Open the panel from the toolbar, and open a document.

Usage is billed to whichever account you signed in with.

Disabling the setting hides the panel and shuts down the embedded runtime.

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

The embedded assistant runs its provider in a sandboxed child process with an
isolated home directory, and talks to the document over a private loopback
server on a random port behind a bearer token. Each request is bound to one
window, one tab, one document, and one revision, so an assistant in one window
cannot read or change a document in another. The design decision and its state
owners are recorded in
[ADR 0004](../architecture/adr/0004-assistant-is-optional-with-provider-adapters.md).
