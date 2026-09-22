import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    filterDevLogText,
    formatAppLogText,
    parseDevLogsArgs,
} from '@scripts/devLogs';
import {
    classifyElectronStderrBlock,
    consoleMessageToLogRecord,
    createElectronOutputRecordStream,
    createNuxtOutputRecordStream,
    formatTerminalLogRecord,
} from '@scripts/electron-run/terminalLog';
import type { ILogRecord } from '@contracts/logRecord';

describe('devLogs', () => {
    it('parses session, follow, tail, and relative since options', () => {
        expect(parseDevLogsArgs([
            '--session=pdf-test',
            '--follow',
            '--tail=40',
            '--since=15m',
        ], Date.parse('2026-08-10T18:00:00.000Z'))).toEqual({
            follow: true,
            sessionName: 'pdf-test',
            sinceMs: Date.parse('2026-08-10T17:45:00.000Z'),
            tailLines: 40,
            app: false,
            json: false,
            level: 'debug',
            scope: null,
            grep: null,
        });
    });

    it('filters and formats app-log records by level, origin, and text', () => {
        const text = [
            JSON.stringify({
                ts: '2026-08-10T17:50:00.000Z',
                level: 'debug',
                proc: 'main',
                scope: 'native-process-telemetry',
                msg: 'Native process settled',
                data: {durationMs: 16},
            }),
            JSON.stringify({
                ts: '2026-08-10T17:50:01.000Z',
                level: 'warn',
                proc: 'main',
                scope: 'native-process-telemetry',
                msg: 'Native process still running',
                data: {
                    command: 'qpdf(strict-structure-check)',
                    elapsedMs: 5000,
                },
            }),
            '{"partial":',
            JSON.stringify({
                ts: '2026-08-10T17:50:02.000Z',
                level: 'error',
                proc: 'renderer',
                window: 1,
                scope: 'workspace',
                msg: 'Workspace save failed',
                data: {reason: 'persist-rejected'},
                errorId: 'abc',
            }),
        ].join('\n');

        const options = parseDevLogsArgs([
            '--level=warn',
            '--scope=renderer',
        ]);
        expect(formatAppLogText(text, options).split('\n')).toEqual([expect.stringMatching(/ ERROR renderer#1\/workspace Workspace save failed reason=persist-rejected errorId=abc$/u)]);
        expect(formatAppLogText(text, parseDevLogsArgs(['--grep=strict-structure'])).split('\n')).toEqual([expect.stringMatching(/ WARN {2}main\/native-process-telemetry Native process still running command=qpdf\(strict-structure-check\) elapsedMs=5000$/u)]);
    });

    it('filters timestamped records before applying the tail limit', () => {
        const text = [
            '[2026-08-10T17:40:00.000Z nuxt stdout] old',
            '[2026-08-10T17:50:00.000Z electron stderr] first',
            'continued detail',
            '[2026-08-10T17:51:00.000Z renderer stderr] second',
        ].join('\n');

        expect(filterDevLogText(text, {
            sinceMs: Date.parse('2026-08-10T17:45:00.000Z'),
            tailLines: 3,
        })).toBe([
            '[2026-08-10T17:50:00.000Z electron stderr] first',
            'continued detail',
            '[2026-08-10T17:51:00.000Z renderer stderr] second',
        ].join('\n'));
    });
});

function summarize(record: ILogRecord | null) {
    return record && {
        level: record.level,
        origin: `${record.proc}/${record.scope}`,
        msg: record.msg,
        data: record.data,
    };
}

describe('terminal log', () => {
    it('formats a BrowserLogger console call once, with structured data instead of [object Object]', () => {
        const record = consoleMessageToLogRecord('warning', [
            '[2026-09-22T21:36:05.607Z] [workspace] Workspace save did not commit',
            {
                planKind: 'serialized',
                reason: 'persist-rejected',
                busy: {isSaving: false},
            },
        ], '[2026-09-22T21:36:05.607Z] [workspace] Workspace save did not commit [object Object]');

        expect(record).toMatchObject({
            ts: '2026-09-22T21:36:05.607Z',
            level: 'warn',
            proc: 'renderer',
            scope: 'workspace',
            msg: 'Workspace save did not commit',
        });
        const line = formatTerminalLogRecord(record);
        expect(line).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} WARN {2}renderer\/workspace Workspace save did not commit planKind=serialized reason=persist-rejected busy=\{"isSaving":false\}$/u);
        expect(line).not.toContain('[object Object]');
    });

    it('keeps the errorId BrowserLogger merges into a serialized error', () => {
        const record = consoleMessageToLogRecord('error', [
            '[2026-09-22T22:52:06.483Z] [page-ops] rotatePages failed',
            {
                name: 'Error',
                message: 'Large OCR page remaps require sparse range operations',
                stack: 'Error: …',
                errorId: 'abc123',
            },
        ], '');
        expect(record.data).toMatchObject({
            errorId: 'abc123',
            message: 'Large OCR page remaps require sparse range operations',
        });
    });

    it('demotes Vite chatter and keeps plain console text readable', () => {
        expect(summarize(consoleMessageToLogRecord('debug', ['[vite] connected.'], '[vite] connected.'))).toMatchObject({
            level: 'debug',
            origin: 'renderer/vite',
            msg: 'connected.',
        });
        expect(summarize(consoleMessageToLogRecord('log', [
            'plain',
            3,
            true,
        ], 'plain 3 true'))).toMatchObject({
            level: 'info',
            origin: 'renderer/console',
            msg: 'plain',
            data: {args: [
                3,
                true,
            ]},
        });
    });

    it('classifies Electron stderr shapes seen in real dev sessions', () => {
        expect(summarize(classifyElectronStderrBlock({lines: [
            'Error occurred in handler for \'pdf:nativePagePreview\': Error: Native PDF preview canceled',
            '    at abortPreviewController (file:///repo/dist-electron/main.js:4:97072)',
            '    at Session.<anonymous> (node:electron/js2c/browser_init:2:123833)',
        ]}))).toEqual({
            level: 'debug',
            origin: 'main/ipc',
            msg: 'IPC handler rejected',
            data: {
                channel: 'pdf:nativePagePreview',
                error: 'Error: Native PDF preview canceled',
                at: 'abortPreviewController (file:///repo/dist-electron/main.js:4:97072)',
            },
        });
        expect(classifyElectronStderrBlock({lines: ['Error occurred in handler for \'recentFiles:get\': Error: IPC sender is not trusted']})?.level).toBe('warn');
        expect(summarize(classifyElectronStderrBlock({lines: ['[1265:0923/012643.135645:ERROR:content/browser/gpu/gpu_process_host.cc:1000] GPU process exited unexpectedly: exit_code=15']}))).toMatchObject({
            level: 'warn',
            origin: 'electron/chromium',
            msg: 'GPU process exited unexpectedly: exit_code=15',
        });
        expect(classifyElectronStderrBlock({lines: ['[1265:0923/012643.135645:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:401] SharedImageManager::ProduceMemory: Trying to Produce a Memory representation from a non-existent mailbox.']})?.level).toBe('debug');
        expect(classifyElectronStderrBlock({lines: ['2026-09-23 01:31:55.948 Electron[1265:62357140] Warning: Window move completed without beginning']})?.level).toBe('debug');
        expect(summarize(classifyElectronStderrBlock({lines: ['Syntax Error: Couldn\'t read xref table']}))).toMatchObject({
            level: 'info',
            origin: 'electron/stderr',
        });
    });

    it('drops Chromium console echoes, including multi-line ones, and decodes NDJSON stdout', () => {
        const records: ILogRecord[] = [];
        const stream = createElectronOutputRecordStream(record => records.push(record));
        stream.write('stderr', [
            '[1265:0923/012652.085787:INFO:CONSOLE:12] "[perf] pdf:scroll-visibility [object Object]", source: http://127.0.0.1:3235/_nuxt/utils/devPerf.ts (12)',
            '[1265:0923/012643.1:WARNING:CONSOLE:1] "Electron Security Warning (Insecure Content-Security-Policy)',
            '  this app to unnecessary security risks.',
            'once the app is packaged.", source: node:electron/js2c/sandbox_bundle (2)',
            'Error occurred in handler for \'file:stat\': Error: Invalid file path',
            '',
        ].join('\n'));
        stream.write('stdout', `${JSON.stringify({
            ts: '2026-09-22T21:36:05.453Z',
            level: 'warn',
            proc: 'main',
            scope: 'workingCopyMutationQueue',
            msg: 'Working-copy mutation settled',
            data: {durationMs: 28736.2},
        })}\nplain stdout\n`);
        stream.end();

        expect(records.map(summarize)).toEqual([
            expect.objectContaining({
                level: 'warn',
                origin: 'main/workingCopyMutationQueue',
                msg: 'Working-copy mutation settled',
            }),
            expect.objectContaining({
                level: 'info',
                origin: 'electron/stdout',
                msg: 'plain stdout',
            }),
            expect.objectContaining({
                level: 'warn',
                origin: 'main/ipc',
                data: expect.objectContaining({channel: 'file:stat'}),
            }),
        ]);
    });

    it('surfaces Nuxt warnings and errors and keeps build chatter and forwarded console lines at debug', () => {
        const records: ILogRecord[] = [];
        const stream = createNuxtOutputRecordStream(record => records.push(record));
        stream.write('stdout', [
            '✔ Vite client built in 28ms',
            ' WARN  [VUE_ROUTER_W1] No match found for location with path "/annotation-comment.svg"',
            '├▶ fix: Add a route matching this path or check for typos in the location.',
            '╰▶ see: https://router.vuejs.org/guide/essentials/dynamic-matching.html',
            ' WARN  [console.warn] [2026-09-22T21:36:05.607Z] [renderer-guard] Ignored benign window error {}',
            '[nitro]  ERROR  Error: Could not load /repo/node_modules/nitropack/runtime.mjs',
            'ℹ page reload utils/docxStreaming.ts',
            '',
        ].join('\n'));
        stream.end();

        expect(records.map(record => [
            record.level,
            record.msg,
        ])).toEqual([
            [
                'debug',
                '✔ Vite client built in 28ms',
            ],
            [
                'warn',
                '[VUE_ROUTER_W1] No match found for location with path "/annotation-comment.svg"',
            ],
            [
                'debug',
                'WARN  [console.warn] [2026-09-22T21:36:05.607Z] [renderer-guard] Ignored benign window error {}',
            ],
            [
                'error',
                'nitro: Error: Could not load /repo/node_modules/nitropack/runtime.mjs',
            ],
            [
                'info',
                'page reload utils/docxStreaming.ts',
            ],
        ]);
        expect(records[1]?.data).toEqual({detail: expect.stringContaining('fix: Add a route matching this path')});
    });
});
