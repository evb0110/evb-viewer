# Logging

Every log line in EVB is one record with the same fields, wherever it was
produced:

```ts
interface ILogRecord {
    ts: string;          // ISO timestamp
    level: 'debug' | 'info' | 'warn' | 'error';
    proc: 'main' | 'worker' | 'renderer' | 'launcher' | 'electron';
    scope: string;       // logger source or BrowserLogger section
    msg: string;         // short, stable sentence
    data?: object;       // structured details
    errorId?: string;    // diagnostic event id on captured failures
    code?: string;       // diagnostic code on captured failures
    pid?: number;
    thread?: number;     // worker thread id
    window?: number;     // renderer webContents id
}
```

The contract is `packages/contracts/logRecord.ts`. It owns the level order,
the bounded data normalization and the one human line format:

```
21:36:05.616 ERROR renderer#1/workspace Workspace save failed operationId=save-2 reason=persist-rejected errorId=…
```

## Writing logs

- Main process and workers: `createLogger(source)` from
  `electron/utils/createLogger.ts`. Call `debug`, `info` or `warn` as
  `(msg, data?)`, and `error` as `(msg, failure, data?)`.
- Renderer: `BrowserLogger.<level>(section, message, data?)` from
  `app/utils/browserLogger.ts`.

Keep `msg` constant and put variables in `data`. Do not interpolate
`JSON.stringify` output into a message: the sinks format data, redact it and
keep nested objects structured. Errors can go straight into `data`; they are
normalized to `name`, `message`, `code`, `stack` and `cause`.

Choose the level by what a developer should do with the line:

| Level | Meaning |
| --- | --- |
| `error` | A user-visible operation failed. Main and renderer errors carry a diagnostic receipt. |
| `warn` | Something a developer should look at: a degraded path, a slow operation, a rejected request. |
| `info` | A milestone worth seeing in the dev terminal. Keep it rare. |
| `debug` | Detail for reconstructing a timeline after the fact. Lifecycle chatter belongs here or nowhere. |

A slow operation is a `warn`, not a `debug` with a duration. For example, a
native process that is still running after 5 s logs a warning.

## Where records go

| Sink | Contents | Level |
| --- | --- | --- |
| `<log dir>/app.ndjson` | One NDJSON timeline for main, workers and renderer records forwarded over IPC | `ELECTRON_FILE_LOG_LEVEL`; `debug` in development, `info` packaged |
| `pnpm dev` terminal | Main and worker records, the renderer console, classified Electron stderr, launcher milestones | `EVB_LOG_LEVEL`, default `info` |
| `.devkit/sessions/<name>/session.log` | Transcript of the terminal plus the build steps, one prefix per line | same as the terminal |
| `.devkit/scratch/dev-server-logs/<name>/<run>/` | Raw per-source stdout and stderr, including unfiltered Electron output | all |
| Renderer DevTools console | BrowserLogger output and main-process warnings and errors | renderer level |

In a dev session the log directory is `.devkit/sessions/<name>/electron-logs/`.
Otherwise the app writes to Electron's `app.getPath('logs')`: `~/Library/Logs/EVB Viewer/`
on macOS and `<userData>/logs/` on Windows and Linux. `EVB_FILE_LOG_DIR` overrides it,
and worker threads and utility processes inherit the directory the main process chose.
`app.ndjson` rotates at 16 MiB and keeps three backups. Each process start
writes a `Log session started` record, so runs remain separable.

How records reach the terminal:

- Main and worker records: the launcher sets `EVB_LOG_STDOUT=ndjson`, the
  logger mirrors records to stdout, and the launcher formats them.
- Renderer records: the launcher reads the console over CDP. BrowserLogger
  lines keep their section and data. Renderer records are also forwarded to
  `app.ndjson` over IPC, but they are not mirrored to stdout, so they never
  print twice.
- Electron stderr: `scripts/electron-run/terminalLog.ts` classifies it.
  - Chromium's console echo is dropped as a duplicate.
  - `Error occurred in handler for '<channel>'` becomes a debug
    `electron/ipc` record. The validated IPC registrar already logs every
    rejected invoke as a `main/ipc` record with the channel and error, at
    debug for cancellations and warn otherwise, so it also lands in
    `app.ndjson`.
  - Chromium warnings and errors become `electron/chromium` warnings. GPU and
    network-service crashes surface this way.
  - Known macOS and Chromium noise becomes debug.
  - Anything unrecognized prints as `electron/stderr` info.

## Reading logs

```sh
pnpm electron:run logs                        # terminal transcript for the default session
pnpm electron:run logs --app --level=warn     # structured app log, warnings and errors
pnpm electron:run logs --app --scope=workspace --since=15m
pnpm electron:run logs --app --grep=persist-rejected --follow
pnpm electron:run logs --json --level=error   # raw NDJSON for scripts and jq
```

Pass `--session=<name>` to read another session's logs.

## Levels and switches

| Setting | Effect |
| --- | --- |
| `EVB_LOG_LEVEL=debug` | Show debug records in the `pnpm dev` terminal |
| `ELECTRON_FILE_LOG_LEVEL` | Minimum level written to `app.ndjson` |
| `ELECTRON_RENDER_LOG_LEVEL` | Minimum main-process level echoed into the renderer console (default `warn`) |
| `localStorage['evb-viewer:log-level']` or `window.__logLevel` | Renderer level; default `info` in development and `warn` packaged |
| `EVB_GATE_QUIET=0` | Show the gate's session inventory and timing report during `pnpm dev` |
