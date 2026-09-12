# Connecting an MCP client

While EVB Viewer is running, it can expose the open document to outside agents
over the Model Context Protocol. Claude Code, Cursor, and other MCP clients can
then read pages, search, and drive the viewer.

This is off by default, and it is separate from the
[in-app assistant](assistant.md). Turning one on does not turn on the other.

## Enabling it

Open Settings and turn on external MCP. The app starts a local server and, if
the Codex CLI is installed, registers itself in your global Codex configuration.
Turning the switch off removes that entry and stops the server.

## Connecting

The server binds to loopback only.

| Build | Server name | Default port |
| --- | --- | --- |
| Packaged app | `evb_viewer` | `38671` |
| Development | `evb_viewer_dev` | `38672` |

Override the port with `EVB_MCP_PORT`. Requests are JSON-RPC over `POST` to the
same address, and `GET /health` returns the server identity along with the
tools, resources, and prompts it offers.

Point any MCP client at `http://127.0.0.1:38671`. For clients that speak stdio
rather than HTTP, `scripts/evb-mcp-proxy.mjs` forwards to the same endpoint.

## What the tools cover

Around 28 tools, in five groups.

- **Workspace**: list open documents, snapshot panes and tabs, activate a tab,
  go to a page.
- **Reading**: read pages, read page text, inspect text coverage, check
  document readiness and preparation hints, read the table of contents.
- **Search**: search one document, search the open document, find in the
  current PDF.
- **Document structure**: annotations, notes, bookmarks, page labels, rebuild
  verified bookmarks, number pages from printed page numbers.
- **Capabilities**: list and describe the semantic actions the viewer exposes,
  run one, and poll a long-running job.

The capability registry is deliberately indirect: `evb_list_capabilities` and
`evb_describe_capability` keep the top-level tool list small while still
exposing annotation, note, bookmark, page-label, OCR, UI, file, export, page,
history, search, and navigation actions.

The architecture, including how requests are scoped, is in
[docs/architecture/mcp.md](../architecture/mcp.md).
