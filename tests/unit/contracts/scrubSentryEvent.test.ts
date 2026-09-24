import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    beforeSendSentryEvent,
    scrubSentryEvent,
} from '@contracts/diagnostics/scrubSentryEvent';

// Shaped like what @sentry/electron 7 builds in main for a logger.error with an
// ENOENT cause, before beforeSend runs.
const mainEvent = {
    event_id: '0123456789abcdef0123456789abcdef',
    timestamp: 1_790_000_000.5,
    level: 'error',
    platform: 'node',
    release: 'evb-viewer-desktop@0.1.459',
    environment: 'production',
    server_name: 'Janes-MacBook-Pro',
    tags: {
        diagnostic_code: 'MAIN_SAVE_FAILED',
        'event.process': 'browser',
    },
    fingerprint: [
        '{{ default }}',
        'MAIN_SAVE_FAILED',
    ],
    user: {
        ip_address: '{{auto}}',
        username: 'jane',
    },
    extra: {path: '/Users/jane/Documents/Contract with Acme.pdf'},
    breadcrumbs: [{
        category: 'console',
        message: 'Opened /Users/jane/Documents/Contract with Acme.pdf',
    }],
    request: {url: 'evb-viewer://app/electron?open=%2FUsers%2Fjane%2Fsecret.pdf'},
    contexts: {
        os: {
            name: 'macOS',
            version: '15.4',
            kernel_version: 'Darwin Kernel Version 24.4.0',
        },
        runtime: {
            name: 'Electron',
            version: '44.3.0',
        },
        app: {
            app_version: '0.1.459',
            app_name: 'EVB Viewer',
            app_memory: 12345,
        },
        device: {
            model: 'MacBookPro18,3',
            memory_size: 34359738368,
            cpu_description: 'Apple M1 Pro',
        },
        culture: {
            locale: 'en-US',
            timezone: 'Europe/Berlin',
        },
    },
    exception: {values: [{
        type: 'Error',
        value: 'ENOENT: no such file or directory, open \'/Users/jane/Documents/Contract with Acme.pdf\'',
        mechanism: {
            type: 'generic',
            handled: true,
            data: {path: '/Users/jane/Documents'},
        },
        stacktrace: {frames: [
            {
                filename: '/Applications/EVB Viewer.app/Contents/Resources/app.asar/dist-electron/main-chunk-save.js',
                abs_path: '/Applications/EVB Viewer.app/Contents/Resources/app.asar/dist-electron/main-chunk-save.js',
                function: 'persistDocument',
                lineno: 1,
                colno: 48210,
                in_app: true,
                vars: {documentText: 'Confidential terms of the agreement'},
                pre_context: ['const text = document.text;'],
                context_line: 'await writeFile(path, text);',
            },
            {
                filename: 'node:internal/fs/promises',
                function: 'open',
                lineno: 639,
                in_app: false,
            },
        ]},
    }]},
    debug_meta: {images: [{
        type: 'sourcemap',
        debug_id: '6f3c2c1a-8b0e-4f2d-9b7e-0a1b2c3d4e5f',
        code_file: '/Applications/EVB Viewer.app/Contents/Resources/app.asar/dist-electron/main-chunk-save.js',
    }]},
    modules: {electron: '44.3.0'},
};

// A renderer error forwarded to main through the SDK's IPC bridge.
const rendererEvent = {
    event_id: 'fedcba9876543210fedcba9876543210',
    level: 'error',
    platform: 'javascript',
    tags: {diagnostic_code: 'RENDERER_PDF_SEARCH_OPERATION_FAILED'},
    message: {formatted: 'Search failed for "quarterly revenue" in C:\\Users\\Jane\\Desktop\\Report 2026.pdf'},
    contexts: {browser: {
        name: 'Chrome',
        version: '140.0.7339.41',
    }},
    exception: {values: [{
        type: 'TypeError',
        value: 'Cannot read properties of undefined (reading \'Report 2026.pdf\')',
        stacktrace: {frames: [{
            filename: 'evb-viewer://app/_nuxt/usePdfSearch.BwB4a1.js',
            function: 'performSearch',
            lineno: 3,
            colno: 1022,
        }]},
    }]},
};

describe('scrubSentryEvent', () => {
    it('keeps only the allowlisted fields of a main-process event', () => {
        const scrubbed = scrubSentryEvent(mainEvent) as Record<string, unknown>;

        expect(Object.keys(scrubbed).sort()).toEqual([
            'contexts',
            'debug_meta',
            'environment',
            'event_id',
            'exception',
            'fingerprint',
            'level',
            'platform',
            'release',
            'tags',
            'timestamp',
        ]);
        expect(scrubbed.contexts).toEqual({
            app: {app_version: '0.1.459'},
            os: {
                name: 'macOS',
                version: '15.4',
            },
            runtime: {
                name: 'Electron',
                version: '44.3.0',
            },
        });
        expect(scrubbed.tags).toEqual({
            diagnostic_code: 'MAIN_SAVE_FAILED',
            'event.process': 'browser',
        });
    });

    it('rewrites app frames to app-relative paths and drops local variables and source context', () => {
        const scrubbed = scrubSentryEvent(mainEvent);
        const [
            appFrame,
            nodeFrame,
        ] = scrubbed.exception.values[0]!.stacktrace.frames;

        expect(appFrame).toEqual({
            filename: 'app:///app.asar/dist-electron/main-chunk-save.js',
            abs_path: 'app:///app.asar/dist-electron/main-chunk-save.js',
            function: 'persistDocument',
            lineno: 1,
            colno: 48210,
            in_app: true,
        });
        expect(nodeFrame?.filename).toBe('node:internal/fs/promises');
        expect(scrubbed.debug_meta.images[0]?.code_file).toBe('app:///app.asar/dist-electron/main-chunk-save.js');
        expect(scrubbed.exception.values[0]?.mechanism).toEqual({
            type: 'generic',
            handled: true,
        });
    });

    it('never lets a local path, file name, user name or document text through', () => {
        for (const event of [
            mainEvent,
            rendererEvent,
        ]) {
            const serialized = JSON.stringify(scrubSentryEvent(event));
            for (const secret of [
                'jane',
                'Jane',
                'Contract with Acme',
                'Report 2026',
                'quarterly revenue',
                'Confidential',
                'MacBook',
                'Documents',
                'secret.pdf',
            ]) {
                expect(serialized).not.toContain(secret);
            }
        }
    });

    it('keeps the diagnostic shape of scrubbed messages', () => {
        const main = scrubSentryEvent(mainEvent);
        const renderer = scrubSentryEvent(rendererEvent) as Record<string, unknown>;

        expect(main.exception.values[0]?.value).toBe('ENOENT: no such file or directory, open <redacted>');
        expect(renderer.message).toBe('Search failed for <redacted> in <path> <file>');
        expect(rendererEvent.exception.values[0]!.stacktrace.frames[0]!.filename).toContain('evb-viewer://');
        expect(scrubSentryEvent(rendererEvent).exception.values[0]?.stacktrace.frames[0]?.filename)
            .toBe('app:///_nuxt/usePdfSearch.BwB4a1.js');
    });

    it('drops attachments such as minidumps before the envelope is built', () => {
        const hint = {attachments: [{
            filename: 'minidump.dmp',
            data: new Uint8Array([
                1,
                2,
                3,
            ]),
        }]};

        beforeSendSentryEvent({
            event_id: mainEvent.event_id,
            level: 'fatal',
        }, hint);

        expect(hint.attachments).toEqual([]);
    });
});
