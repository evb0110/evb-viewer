import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { TRegisteredHandler } from '@tests/unit/electron/helpers/ipcRegistryHarness';

const rendererLogRegistryImportTimeoutMs = 10_000;
type TMockSettings = Record<string, unknown>;
type TMockSettingsUpdater = (
    settings: TMockSettings,
) => Partial<TMockSettings> | undefined | Promise<Partial<TMockSettings> | undefined>;

const mocks = vi.hoisted(() => {
    const agentService = {shutdownAssistant: vi.fn(async () => undefined)};
    return {
        handlers: new Map<string, TRegisteredHandler>(),
        logger: {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        },
        registeredWindowsById: new Map<number, unknown>(),
        browserWindowFromWebContents: vi.fn(),
        getWindowByIdFromRegistry: vi.fn(),
        createAgentService: vi.fn(() => agentService),
    };
});

vi.mock('electron', () => ({
    BrowserWindow: {fromWebContents: mocks.browserWindowFromWebContents},
    ipcMain: {
        on: (channel: string, handler: TRegisteredHandler) => {
            mocks.handlers.set(channel, handler);
        },
        handle: vi.fn(),
    },
    shell: {openExternal: vi.fn()},
    webContents: {fromId: vi.fn(() => null)},
}));

vi.mock('@contracts/externalUrl', () => ({sanitizeAllowedExternalUrl: (value: unknown) => value}));
vi.mock('@electron/features/agent/createAgentService', () => ({createAgentService: mocks.createAgentService}));
vi.mock('@electron/features/documents/registerDocumentsIpcAdapter', () => ({registerDocumentsIpcAdapter: vi.fn()}));
vi.mock('@electron/features/image-export/public', () => ({imageExportMainBindings: new Proxy({}, {get: () => vi.fn()})}));
vi.mock('@electron/features/ocr/mainBindings', () => ({ocrMainBindings: new Proxy({}, {get: () => vi.fn()})}));
vi.mock('@electron/features/page-ops/public', () => ({pageOpsMainBindings: new Proxy({}, {get: () => vi.fn()})}));
vi.mock('@electron/features/search/public', () => ({prepareSearchMainBindings: () => new Proxy({}, {get: () => vi.fn()})}));
vi.mock('@electron/menu', () => ({updateRecentFilesMenu: vi.fn()}));
vi.mock('@electron/settings', () => ({
    loadSettings: vi.fn(async () => ({})),
    updateSettings: vi.fn(async (updater: TMockSettingsUpdater) => {
        const settings: TMockSettings = {};
        const patch = await updater(settings);
        return patch && typeof patch === 'object'
            ? {
                ...settings,
                ...patch,
            }
            : settings;
    }),
}));
vi.mock('@electron/windowTabTransfer', () => ({
    acknowledgeWindowTabTransfer: vi.fn(),
    requestWindowTabTransfer: vi.fn(),
}));
vi.mock('@electron/window/registry', () => ({
    getAllRegisteredAppWindows: vi.fn(() => Array.from(mocks.registeredWindowsById.values())),
    getWindowByIdFromRegistry: mocks.getWindowByIdFromRegistry,
}));
vi.mock('@electron/updates', () => ({
    deferDownloadedUpdate: vi.fn(),
    downloadAvailableUpdate: vi.fn(),
    getUpdateStatus: vi.fn(() => ({phase: 'idle'})),
    installDownloadedUpdate: vi.fn(),
    skipUpdateVersion: vi.fn(),
    triggerManualUpdateCheck: vi.fn(),
}));
vi.mock('@electron/te', () => ({
    setElectronLocale: vi.fn(async () => {}),
    te: (key: string) => key,
}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));
vi.mock('@electron/config', () => ({config: {renderer: {trustedUrl: 'https://trusted.example/electron'}}}));

function createSender(id: number) {
    const once = vi.fn();
    const removeListener = vi.fn();
    const sender = {
        id,
        once,
        removeListener,
        isDestroyed: () => false,
        getURL: () => 'https://trusted.example/electron',
        mainFrame: null,
    };
    mocks.registeredWindowsById.set(id, {
        id,
        webContents: sender,
        isDestroyed: () => false,
    });
    return sender;
}

describe('renderer log registry', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.handlers.clear();
        mocks.registeredWindowsById.clear();
        mocks.browserWindowFromWebContents.mockImplementation((sender: {id?: number}) => (
            typeof sender.id === 'number'
                ? mocks.registeredWindowsById.get(sender.id) ?? null
                : null
        ));
        mocks.getWindowByIdFromRegistry.mockImplementation((windowId: number) => (
            mocks.registeredWindowsById.get(windowId) ?? null
        ));
    });

    it('clears sender rate-limit state when the sender is destroyed', async () => {
        vi.useFakeTimers();
        try {
            const { registerIpcHandlers } = await import('@electron/platform-ipc/registerIpcHandlers');
            registerIpcHandlers();

            const handler = mocks.handlers.get('renderer:log');
            expect(handler).toBeTypeOf('function');

            const firstSender = createSender(7);
            for (let index = 0; index < 121; index += 1) {
                handler?.({
                    sender: firstSender,
                    senderFrame: null,
                }, {
                    level: 'info',
                    section: 'search',
                    message: `message-${index}`,
                    timestamp: '2026-03-21T00:00:00.000Z',
                });
            }

            expect(mocks.logger.info).toHaveBeenCalledTimes(120);
            expect(firstSender.once).toHaveBeenCalledTimes(2);

            const destroyedHandler = firstSender.once.mock.calls
                .find(call => call[0] === 'destroyed')?.[1] as (() => void) | undefined;
            destroyedHandler?.();

            const secondSender = createSender(7);
            handler?.({
                sender: secondSender,
                senderFrame: null,
            }, {
                level: 'info',
                section: 'search',
                message: 'after-destroy',
                timestamp: '2026-03-21T00:00:00.000Z',
            });

            expect(secondSender.once).toHaveBeenCalledTimes(2);
            expect(mocks.logger.info).toHaveBeenCalledTimes(121);
        } finally {
            vi.useRealTimers();
        }
    }, rendererLogRegistryImportTimeoutMs);

    it('removes the counterpart cleanup listener when a sender lifecycle event fires', async () => {
        const { registerIpcHandlers } = await import('@electron/platform-ipc/registerIpcHandlers');
        registerIpcHandlers();

        const handler = mocks.handlers.get('renderer:log');
        expect(handler).toBeTypeOf('function');

        const sender = createSender(9);
        handler?.({
            sender,
            senderFrame: null,
        }, {
            level: 'info',
            section: 'search',
            message: 'before-destroy',
            timestamp: '2026-03-21T00:00:00.000Z',
        });

        const destroyedHandler = sender.once.mock.calls
            .find(call => call[0] === 'destroyed')?.[1] as (() => void) | undefined;
        const renderGoneHandler = sender.once.mock.calls
            .find(call => call[0] === 'render-process-gone')?.[1] as (() => void) | undefined;

        destroyedHandler?.();

        expect(sender.removeListener).toHaveBeenCalledWith('destroyed', destroyedHandler);
        expect(sender.removeListener).toHaveBeenCalledWith('render-process-gone', renderGoneHandler);
    });

    it('summarizes nested payloads without walking deeply nested objects', async () => {
        const { registerIpcHandlers } = await import('@electron/platform-ipc/registerIpcHandlers');
        registerIpcHandlers();

        const handler = mocks.handlers.get('renderer:log');
        expect(handler).toBeTypeOf('function');

        const sender = createSender(8);
        handler?.({
            sender,
            senderFrame: null,
        }, {
            level: 'info',
            section: 'search',
            message: 'payload',
            timestamp: '2026-03-21T00:00:00.000Z',
            data: {
                nested: { value: 1 },
                items: ['child'],
            },
        });

        const loggedMessage = mocks.logger.info.mock.calls.at(-1)?.[0] as string | undefined;
        expect(loggedMessage).toContain('"nested":"[Object]"');
        expect(loggedMessage).toContain('"items":"[Array(1)]"');
    });

    it('reuses a renderer-owned failure receipt without creating a main occurrence', async () => {
        const { registerIpcHandlers } = await import('@electron/platform-ipc/registerIpcHandlers');
        registerIpcHandlers();

        const handler = mocks.handlers.get('renderer:log');
        const sender = createSender(10);
        const failureRef = {
            eventId: '0123456789abcdef0123456789abcdef',
            code: 'RENDERER_ERROR_GUARD_FAILED',
            occurredAt: 1,
            severity: 'error',
        };
        handler?.({
            sender,
            senderFrame: null,
        }, {
            level: 'error',
            section: 'renderer-guard',
            message: 'Renderer failure',
            timestamp: '2026-03-21T00:00:00.000Z',
            failureRef,
        });

        expect(mocks.logger.error).toHaveBeenCalledWith(
            expect.stringContaining('Renderer failure'),
            failureRef,
        );
    });
});

describe('normalizeRendererLogEntry', () => {
    it('falls back to info level when level is an unknown string', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/platform-ipc/registerIpcHandlers');
        const entry = normalizeRendererLogEntry({
            level: 'critical',
            section: 'search',
            message: 'hello',
            timestamp: '2026-03-21T00:00:00.000Z',
        });
        expect(entry.level).toBe('info');
    });

    it('falls back to info level when level is missing or non-string', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/platform-ipc/registerIpcHandlers');
        expect(normalizeRendererLogEntry({message: 'm'}).level).toBe('info');
        expect(normalizeRendererLogEntry({
            level: 5,
            message: 'm',
        }).level).toBe('info');
        expect(normalizeRendererLogEntry({
            level: null,
            message: 'm',
        }).level).toBe('info');
    });

    it('preserves all four known log levels', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/platform-ipc/registerIpcHandlers');
        for (const level of [
            'debug',
            'info',
            'warn',
            'error',
        ] as const) {
            expect(normalizeRendererLogEntry({
                level,
                message: 'm',
            }).level).toBe(level);
        }
    });

    it('keeps only a valid closed failure receipt', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/platform-ipc/registerIpcHandlers');
        const failureRef = {
            eventId: '0123456789abcdef0123456789abcdef',
            code: 'RENDERER_ERROR_GUARD_FAILED',
            occurredAt: 1,
            severity: 'error',
        };

        expect(normalizeRendererLogEntry({
            level: 'error',
            failureRef,
        }).failureRef).toEqual(failureRef);
        expect(normalizeRendererLogEntry({
            level: 'error',
            failureRef: {
                ...failureRef,
                rawMessage: 'private',
            },
        })).not.toHaveProperty('failureRef');
    });

    it('uses <empty> message default when message is missing or null', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/platform-ipc/registerIpcHandlers');
        expect(normalizeRendererLogEntry({level: 'info'}).message).toBe('<empty>');
        expect(normalizeRendererLogEntry({
            level: 'info',
            message: null,
        }).message).toBe('<empty>');
        expect(normalizeRendererLogEntry({
            level: 'info',
            message: 42,
        }).message).toBe('<empty>');
    });

    it('uses unknown section default when section is missing or non-string', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/platform-ipc/registerIpcHandlers');
        expect(normalizeRendererLogEntry({
            level: 'info',
            message: 'm',
        }).section).toBe('unknown');
        expect(normalizeRendererLogEntry({
            level: 'info',
            message: 'm',
            section: null,
        }).section).toBe('unknown');
        expect(normalizeRendererLogEntry({
            level: 'info',
            message: 'm',
            section: 7,
        }).section).toBe('unknown');
    });

    it('drops extra metadata fields not in the canonical entry shape', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/platform-ipc/registerIpcHandlers');
        const entry = normalizeRendererLogEntry({
            level: 'info',
            section: 'search',
            message: 'm',
            timestamp: '2026-03-21T00:00:00.000Z',
            extra: 'should-be-dropped',
            anotherField: {nested: true},
        });
        expect(entry).toEqual({
            level: 'info',
            section: 'search',
            message: 'm',
            timestamp: '2026-03-21T00:00:00.000Z',
            serializedData: '',
        });
        expect(Object.keys(entry).sort()).toEqual([
            'level',
            'message',
            'section',
            'serializedData',
            'timestamp',
        ]);
    });

    it('uses defaults for null payload', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/platform-ipc/registerIpcHandlers');
        const entry = normalizeRendererLogEntry(null);
        expect(entry.level).toBe('info');
        expect(entry.section).toBe('unknown');
        expect(entry.message).toBe('<empty>');
        expect(entry.serializedData).toBe('');
        expect(entry.timestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    it('uses defaults for undefined payload', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/platform-ipc/registerIpcHandlers');
        const entry = normalizeRendererLogEntry(undefined);
        expect(entry.level).toBe('info');
        expect(entry.section).toBe('unknown');
        expect(entry.message).toBe('<empty>');
        expect(entry.serializedData).toBe('');
    });

    it('uses defaults for string payload', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/platform-ipc/registerIpcHandlers');
        const entry = normalizeRendererLogEntry('not-a-record');
        expect(entry.level).toBe('info');
        expect(entry.section).toBe('unknown');
        expect(entry.message).toBe('<empty>');
        expect(entry.serializedData).toBe('');
    });

    it('uses defaults for number payload', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/platform-ipc/registerIpcHandlers');
        const entry = normalizeRendererLogEntry(42);
        expect(entry.level).toBe('info');
        expect(entry.section).toBe('unknown');
        expect(entry.message).toBe('<empty>');
        expect(entry.serializedData).toBe('');
    });

    it('uses defaults for array payload', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/platform-ipc/registerIpcHandlers');
        const entry = normalizeRendererLogEntry([
            'debug',
            'msg',
        ]);
        expect(entry.level).toBe('info');
        expect(entry.section).toBe('unknown');
        expect(entry.message).toBe('<empty>');
        expect(entry.serializedData).toBe('');
    });

    it('retains bounded redacted details of nested errors serialized by the renderer', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/platform-ipc/registerIpcHandlers');
        const entry = normalizeRendererLogEntry({
            level: 'error',
            message: 'Failed to invalidate',
            data: {
                category: 'operation',
                error: {
                    name: 'RangeError',
                    message: 'Invalid page in /Users/evb/private/document.pdf',
                    stack: 'RangeError: Invalid page\n at navigation.ts:115:32',
                    unrelated: {large: true},
                },
            },
        });
        const data = JSON.parse(entry.serializedData.slice(' data='.length));
        expect(data.error).toEqual({
            name: 'RangeError',
            message: expect.stringContaining('Invalid page'),
            stack: expect.stringContaining('navigation.ts:115:32'),
        });
        expect(entry.serializedData).not.toContain('/Users/evb/private/document.pdf');
    });

    it('serializes data into serializedData with leading data= marker', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/platform-ipc/registerIpcHandlers');
        const entry = normalizeRendererLogEntry({
            level: 'info',
            section: 'search',
            message: 'm',
            data: {a: 1},
        });
        expect(entry.serializedData).toBe(' data={"a":1}');
    });

    it('redacts secrets and local paths before serializing renderer log fields', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/platform-ipc/registerIpcHandlers');
        const entry = normalizeRendererLogEntry({
            level: 'info',
            section: 'search',
            message: 'authorization: secret-token opened /Users/evb/private/report.pdf',
            data: {
                fileUrl: 'file:///Users/evb/private/report.pdf',
                bearer: 'Bearer abc.def.ghi',
                nested: {path: '/Users/evb/private/nested.pdf'},
            },
        });

        expect(entry.message).toContain('[redacted-secret]');
        expect(entry.message).toContain('/Users/[redacted]');
        expect(entry.message).not.toContain('secret-token');
        expect(entry.message).not.toContain('/Users/evb/private');
        expect(entry.serializedData).toContain('file://[redacted]');
        expect(entry.serializedData).toContain('Bearer [redacted]');
        expect(entry.serializedData).not.toContain('abc.def.ghi');
        expect(entry.serializedData).not.toContain('/Users/evb/private/report.pdf');
    });

    it('redacts URL secrets while preserving renderer log routing details', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/platform-ipc/registerIpcHandlers');
        const entry = normalizeRendererLogEntry({
            level: 'error',
            section: 'updates',
            message: 'GET https://user:pass@updates.example.test:8443/releases/latest?channel=stable&channel=beta&token=secret#private failed',
        });

        expect(entry.message).toBe(
            'GET https://[redacted]@updates.example.test:8443/releases/latest?channel=[redacted]&channel=[redacted]&token=[redacted]#[redacted] failed',
        );
    });

    it('redacts secret-named properties in structured renderer data', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/platform-ipc/registerIpcHandlers');
        const entry = normalizeRendererLogEntry({
            message: 'failed',
            data: {
                authorization: 'super-secret',
                apiKey: 'api-secret',
            },
        });

        expect(entry.serializedData).not.toContain('super-secret');
        expect(entry.serializedData).not.toContain('api-secret');
        expect(entry.serializedData).toContain('"authorization":"[redacted-secret]"');
        expect(entry.serializedData).toContain('"apiKey":"[redacted-secret]"');
    });
});
