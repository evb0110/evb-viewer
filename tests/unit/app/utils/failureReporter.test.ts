import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createRendererFailureReporter,
    readHostedDiagnosticsPreferenceSync,
    type IHostedDiagnosticsTransport,
    type TRendererDiagnosticSender,
} from '@app/utils/failureReporter';
import type {DiagnosticEventId} from '@contracts/diagnostics/diagnosticEventId';

function eventId(value: number) {
    return value.toString(16).padStart(32, '0') as DiagnosticEventId;
}

function createFailureInput(message = 'renderer failed') {
    const cause = new Error(message);
    cause.stack = `Error: ${message}\n    at renderDocument (app/modules/viewer/render.ts:12:4)`;
    return {
        code: 'UNCLASSIFIED_RENDERER_ERROR' as const,
        context: {},
        local: {
            source: 'failure-reporter-test',
            message,
            cause,
            data: {rawMessage: message},
        },
    };
}

function createElectronReporter(overrides: Parameters<typeof createRendererFailureReporter>[0] = {}) {
    const sends: Array<{
        record: Parameters<TRendererDiagnosticSender>[0];
        suppressedCount?: number;
    }> = [];
    const sender = vi.fn((record: Parameters<TRendererDiagnosticSender>[0]) => {
        sends.push({record});
    });
    let nextEventId = 1;
    const reporter = createRendererFailureReporter({
        host: 'electron',
        electronSender: sender,
        preference: 'granted',
        createEventId: () => eventId(nextEventId++),
        ...overrides,
    });
    return {
        reporter,
        sender,
        sends,
    };
}

describe('renderer failure reporter', () => {
    it('captures one closed Electron record synchronously and keeps raw details in the local sink', () => {
        const localSink = vi.fn();
        const {
            reporter,
            sender,
        } = createElectronReporter({localSink});

        const receipt = reporter.capture(createFailureInput('private local detail'));

        expect(sender).toHaveBeenCalledOnce();
        expect(sender).toHaveBeenCalledWith(expect.objectContaining({
            runtime: 'electron-renderer',
            code: 'UNCLASSIFIED_RENDERER_ERROR',
            context: {},
        }));
        expect(sender.mock.calls[0]?.[0]).not.toHaveProperty('local');
        expect(JSON.stringify(sender.mock.calls[0]?.[0])).not.toContain('private local detail');
        expect(localSink).toHaveBeenCalledWith(expect.objectContaining({
            message: 'private local detail',
            cause: expect.any(Error),
        }), receipt);
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 1,
            accepted: 1,
            duplicate: 0,
            transportFailed: 0,
        });
    });

    it('uses the browser worker parent runtime for an overridden capture', () => {
        const {
            reporter,
            sender,
        } = createElectronReporter();

        reporter.capture(createFailureInput(), {runtime: 'browser-worker-parent'});

        expect(sender).toHaveBeenCalledWith(expect.objectContaining({runtime: 'browser-worker-parent'}));
    });

    it('rejects a repeated event ID without a second local projection or send', () => {
        const localSink = vi.fn();
        const {
            reporter,
            sender,
        } = createElectronReporter({
            createEventId: () => eventId(1),
            localSink,
        });

        reporter.capture(createFailureInput());
        reporter.capture(createFailureInput());

        expect(sender).toHaveBeenCalledOnce();
        expect(localSink).toHaveBeenCalledTimes(2);
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 2,
            accepted: 1,
            duplicate: 1,
            lastDropReason: 'duplicate',
        });
    });

    it('suppresses a burst and forwards one clamped summary when its window rolls over', () => {
        let currentTime = 0;
        const sent: Array<{suppressedCount?: number}> = [];
        const reporter = createRendererFailureReporter({
            host: 'electron',
            preference: 'granted',
            now: () => currentTime,
            burstLimit: 1,
            burstWindowMs: 10,
            createEventId: (() => {
                let value = 1;
                return () => eventId(value++);
            })(),
            electronSender: (_record, suppressedCount) => {
                sent.push(suppressedCount === undefined ? {} : {suppressedCount});
            },
        });

        reporter.capture(createFailureInput());
        reporter.capture(createFailureInput());
        currentTime = 10;
        reporter.capture(createFailureInput());

        expect(sent).toHaveLength(2);
        expect(sent[1]).toEqual({suppressedCount: 1});
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 3,
            accepted: 2,
            burstSuppressed: 1,
        });
    });

    it('clamps a burst summary at 10,000 suppressed occurrences', () => {
        let currentTime = 0;
        const sender = vi.fn();
        const reporter = createRendererFailureReporter({
            host: 'electron',
            preference: 'granted',
            now: () => currentTime,
            burstLimit: 1,
            burstWindowMs: 10,
            createEventId: (() => {
                let value = 1;
                return () => eventId(value++);
            })(),
            electronSender: sender,
        });

        reporter.capture(createFailureInput());
        for (let index = 0; index < 10_001; index += 1) {
            reporter.capture(createFailureInput());
        }
        currentTime = 10;
        reporter.capture(createFailureInput());

        expect(sender).toHaveBeenCalledTimes(2);
        expect(sender.mock.calls[1]?.[1]).toBe(10_000);
        expect(reporter.getHealthSnapshot()).toMatchObject({
            burstSuppressed: 10_001,
            accepted: 2,
        });
    }, 15_000);

    it('counts an owned projection without creating an occurrence', () => {
        const {
            reporter,
            sender,
        } = createElectronReporter();

        const receipt = reporter.withSuppressedCapture(() => reporter.capture(createFailureInput()));

        expect(receipt.eventId).toMatch(/^[0-9a-f]{32}$/u);
        expect(sender).not.toHaveBeenCalled();
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 0,
            ownedProjection: 1,
            lastDropReason: 'owned-projection',
        });
    });

    it.each([
        'unknown',
        'denied',
    ] as const)('forwards closed Electron records to the authoritative main gate while the %s startup hint is active', (startupHint) => {
        const {
            reporter,
            sender,
        } = createElectronReporter({
            preference: startupHint,
            readHostedPreference: () => 'granted',
        });

        reporter.capture(createFailureInput());

        expect(sender).toHaveBeenCalledOnce();
        expect(reporter.getHealthSnapshot()).toMatchObject({
            mode: startupHint,
            policyDropped: 0,
            accepted: 1,
        });
    });

    it.each([
        'unknown',
        'denied',
    ] as const)('does not load or send a hosted transport while %s', async (preference) => {
        const transport: IHostedDiagnosticsTransport = {send: vi.fn()};
        const loadHostedTransport = vi.fn(async () => transport);
        const reporter = createRendererFailureReporter({
            host: 'hosted-browser',
            readHostedPreference: () => preference,
            loadHostedTransport,
            createEventId: () => eventId(1),
        });

        reporter.capture(createFailureInput());
        await Promise.resolve();

        expect(loadHostedTransport).not.toHaveBeenCalled();
        expect(transport.send).not.toHaveBeenCalled();
        expect(reporter.getHealthSnapshot()).toMatchObject({
            mode: preference,
            attempted: 1,
            policyDropped: 1,
            accepted: 0,
        });
    });

    it('reads the hosted preference from local storage before loading a transport', () => {
        const localStorage = {getItem: vi.fn(() => JSON.stringify({clientDiagnosticsPreference: 'denied'}))};
        vi.stubGlobal('window', {localStorage});
        const loadHostedTransport = vi.fn();

        try {
            const reporter = createRendererFailureReporter({
                host: 'hosted-browser',
                loadHostedTransport,
                createEventId: () => eventId(1),
            });

            expect(readHostedDiagnosticsPreferenceSync()).toBe('denied');
            reporter.capture(createFailureInput());

            expect(localStorage.getItem).toHaveBeenCalledWith('evb-viewer:browser:settings');
            expect(loadHostedTransport).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('uses the hosted runtime and transport after a local grant', async () => {
        const send = vi.fn();
        const reporter = createRendererFailureReporter({
            host: 'hosted-browser',
            readHostedPreference: () => 'granted',
            loadHostedTransport: () => ({send}),
            createEventId: () => eventId(1),
        });

        const receipt = reporter.capture(createFailureInput());
        await Promise.resolve();

        expect(send).toHaveBeenCalledWith(expect.objectContaining({
            runtime: 'hosted-browser',
            eventId: receipt.eventId,
        }));
        expect(reporter.getHealthSnapshot()).toMatchObject({
            mode: 'granted',
            accepted: 1,
        });
    });

    it('keeps one closed Electron record in a move-only lease until grant', () => {
        const {
            reporter,
            sender,
        } = createElectronReporter({
            preference: 'unknown',
            createEventId: () => eventId(41),
        });

        const presented = reporter.captureForPresentation(createFailureInput('lease detail'));
        const lease = presented.pendingDiagnostic;

        expect(lease).toBeDefined();
        expect(lease).not.toHaveProperty('record');
        expect(lease).not.toHaveProperty('getRecord');
        expect(lease?.failure).toEqual(presented.failure);
        expect(lease?.isLive).toBe(true);
        expect(sender).toHaveBeenCalledOnce();

        reporter.setPreference('granted');

        expect(lease?.resendOnceAfterGrant()).toBe(true);
        expect(sender).toHaveBeenCalledTimes(2);
        expect(sender.mock.calls[0]?.[0]).toMatchObject({eventId: presented.failure.eventId});
        expect(sender.mock.calls[1]?.[0]).toMatchObject({eventId: presented.failure.eventId});
        expect(lease?.isLive).toBe(false);
        expect(lease?.resendOnceAfterGrant()).toBe(false);
        lease?.discard();
        expect(sender).toHaveBeenCalledTimes(2);
    });

    it('reserves hosted recent-ID and burst slots before a deferred transport resolves', async () => {
        let resolveTransport!: (transport: IHostedDiagnosticsTransport) => void;
        const transport = {send: vi.fn()};
        const loadHostedTransport = vi.fn(() => new Promise<IHostedDiagnosticsTransport>((resolve) => {
            resolveTransport = resolve;
        }));
        const eventIds = [
            eventId(1),
            eventId(1),
            eventId(2),
        ];
        const reporter = createRendererFailureReporter({
            host: 'hosted-browser',
            burstLimit: 1,
            readHostedPreference: () => 'granted',
            loadHostedTransport,
            createEventId: () => eventIds.shift() ?? eventId(3),
        });

        reporter.capture(createFailureInput('first'));
        reporter.capture(createFailureInput('duplicate'));
        reporter.capture(createFailureInput('burst'));

        expect(loadHostedTransport).toHaveBeenCalledOnce();
        expect(transport.send).not.toHaveBeenCalled();
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 3,
            accepted: 0,
            duplicate: 1,
            burstSuppressed: 1,
        });

        resolveTransport(transport);
        await Promise.resolve();
        await Promise.resolve();

        expect(transport.send).toHaveBeenCalledOnce();
        expect(reporter.getHealthSnapshot()).toMatchObject({
            accepted: 1,
            transportFailed: 0,
        });
    });

    it('fences a pending hosted continuation after revocation and opens a fresh generation after grant', async () => {
        let resolveFirstTransport!: (transport: IHostedDiagnosticsTransport) => void;
        let resolveSecondTransport!: (transport: IHostedDiagnosticsTransport) => void;
        const firstTransport = {send: vi.fn()};
        const secondTransport = {send: vi.fn()};
        const loadHostedTransport = vi.fn()
            .mockImplementationOnce(() => new Promise<IHostedDiagnosticsTransport>((resolve) => {
                resolveFirstTransport = resolve;
            }))
            .mockImplementationOnce(() => new Promise<IHostedDiagnosticsTransport>((resolve) => {
                resolveSecondTransport = resolve;
            }));
        const reporter = createRendererFailureReporter({
            host: 'hosted-browser',
            preference: 'granted',
            readHostedPreference: () => 'granted',
            loadHostedTransport,
            createEventId: (() => {
                let value = 50;
                return () => eventId(value++);
            })(),
        });

        reporter.capture(createFailureInput('stale hosted send'));
        const generationBeforeRevoke = reporter.getGeneration();
        reporter.setPreference('denied');

        expect(reporter.getGeneration()).toBe(generationBeforeRevoke + 1);
        resolveFirstTransport(firstTransport);
        await Promise.resolve();
        await Promise.resolve();
        expect(firstTransport.send).not.toHaveBeenCalled();

        reporter.setPreference('granted');
        reporter.capture(createFailureInput('fresh hosted send'));
        expect(loadHostedTransport).toHaveBeenCalledTimes(2);
        resolveSecondTransport(secondTransport);
        await Promise.resolve();
        await Promise.resolve();

        expect(secondTransport.send).toHaveBeenCalledOnce();
    });

    it('does not apply a hosted send result after revocation', async () => {
        let resolveSend!: (value: unknown) => void;
        const transport = {send: vi.fn(() => new Promise(resolve => {
            resolveSend = resolve;
        }))};
        const reporter = createRendererFailureReporter({
            host: 'hosted-browser',
            preference: 'granted',
            readHostedPreference: () => 'granted',
            loadHostedTransport: () => transport,
            createEventId: () => eventId(60),
        });

        reporter.capture(createFailureInput('pending result'));
        await Promise.resolve();
        await Promise.resolve();
        expect(transport.send).toHaveBeenCalledOnce();

        reporter.setPreference('denied');
        resolveSend(undefined);
        await Promise.resolve();
        await Promise.resolve();

        expect(reporter.getHealthSnapshot()).toMatchObject({
            accepted: 0,
            transportFailed: 0,
        });
    });

    it('rechecks persisted consent for a hydrated reporter and fences a pending load after cross-tab revocation', async () => {
        let persistedPreference: 'granted' | 'denied' = 'granted';
        let resolveTransport!: (transport: IHostedDiagnosticsTransport) => void;
        const transport = {send: vi.fn()};
        const loadHostedTransport = vi.fn(() => new Promise<IHostedDiagnosticsTransport>((resolve) => {
            resolveTransport = resolve;
        }));
        const windowEventTarget = new EventTarget();
        vi.stubGlobal('window', windowEventTarget);
        const reporter = createRendererFailureReporter({
            host: 'hosted-browser',
            preference: 'granted',
            readHostedPreference: () => persistedPreference,
            loadHostedTransport,
            createEventId: () => eventId(70),
        });
        try {
            reporter.capture(createFailureInput('before cross-tab revoke'));
            persistedPreference = 'denied';
            const storageEvent = new Event('storage');
            Object.defineProperty(storageEvent, 'key', {value: 'evb-viewer:browser:settings'});
            windowEventTarget.dispatchEvent(storageEvent);
            resolveTransport(transport);
            await Promise.resolve();
            await Promise.resolve();

            expect(transport.send).not.toHaveBeenCalled();
            reporter.capture(createFailureInput('after cross-tab revoke'));
            expect(loadHostedTransport).toHaveBeenCalledOnce();
            expect(reporter.getHealthSnapshot()).toMatchObject({
                mode: 'denied',
                policyDropped: 1,
            });

            persistedPreference = 'granted';
            reporter.setPreference('granted');
            expect(reporter.getPreference()).toBe('granted');
        } finally {
            reporter.dispose();
            vi.unstubAllGlobals();
        }
    });

    it('contains transport failure warnings and never turns a warning into another occurrence', () => {
        const rawWarningSink = vi.fn((_message: string) => {
            throw new Error('raw warning failed');
        });
        const {reporter} = createElectronReporter({
            electronSender: () => false,
            rawWarningSink,
        });

        expect(() => reporter.capture(createFailureInput())).not.toThrow();

        expect(rawWarningSink).toHaveBeenCalledOnce();
        expect(rawWarningSink.mock.calls[0]?.[0].length).toBeLessThanOrEqual(512);
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 1,
            accepted: 0,
            transportFailed: 1,
        });
    });

    it('keeps an async-rejected send reserved without counting it as accepted', async () => {
        const sender = vi.fn(() => Promise.reject(new Error('send rejected')));
        const reporter = createRendererFailureReporter({
            host: 'electron',
            preference: 'granted',
            electronSender: sender,
            createEventId: () => eventId(1),
        });

        reporter.capture(createFailureInput('first'));
        reporter.capture(createFailureInput('duplicate'));
        await Promise.resolve();
        await Promise.resolve();

        expect(sender).toHaveBeenCalledOnce();
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 2,
            accepted: 0,
            duplicate: 1,
            transportFailed: 1,
            lastDropReason: 'transport-failed',
        });
    });

    it('counts malformed closed records as schema drops without sending them', () => {
        const {
            reporter,
            sender,
        } = createElectronReporter();

        const receipt = reporter.captureRecord({eventId: 'not-a-record'});

        expect(receipt.eventId).toMatch(/^[0-9a-f]{32}$/u);
        expect(sender).not.toHaveBeenCalled();
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 1,
            schemaDropped: 1,
            lastDropReason: 'schema-dropped',
        });
    });

    it('exposes one initialized reporter and leaves capture-before-initialize explicit', async () => {
        vi.resetModules();
        const module = await import('@app/utils/failureReporter');
        const sender = vi.fn();

        expect(module.getRendererFailureReporter()).toBeNull();
        expect(module.captureRendererFailure(createFailureInput())).toBeUndefined();

        const initialized = module.initializeRendererFailureReporter({
            host: 'electron',
            preference: 'granted',
            electronSender: sender,
            createEventId: () => eventId(1),
        });
        const secondInitialization = module.initializeRendererFailureReporter({host: 'hosted-browser'});
        const receipt = module.captureRendererFailure(createFailureInput());

        expect(secondInitialization).toBe(initialized);
        expect(module.getRendererFailureReporter()).toBe(initialized);
        expect(receipt).toEqual(expect.objectContaining({eventId: eventId(1)}));
        expect(sender).toHaveBeenCalledOnce();
    });

    it('keeps the early Electron singleton while later initialization fills its missing callbacks', async () => {
        vi.resetModules();
        const sendRecord = vi.fn();
        const localSink = vi.fn();
        vi.stubGlobal('window', {electronAPI: {diagnostics: {sendRecord}}});

        try {
            const module = await import('@app/utils/failureReporter');
            const early = module.initializeRendererFailureReporter({
                host: 'electron',
                preference: 'granted',
                createEventId: () => eventId(1),
            });
            const later = module.initializeRendererFailureReporter({
                host: 'hosted-browser',
                localSink,
                readHostedPreference: () => 'granted',
                loadHostedTransport: () => ({send: vi.fn()}),
            });

            const receipt = early.capture(createFailureInput('local only'));

            expect(later).toBe(early);
            expect(sendRecord).toHaveBeenCalledWith(expect.objectContaining({
                runtime: 'electron-renderer',
                eventId: receipt.eventId,
            }), undefined);
            expect(localSink).toHaveBeenCalledWith(expect.objectContaining({message: 'local only'}), receipt);
            expect(early.getHealthSnapshot()).toMatchObject({
                initializationCount: 2,
                accepted: 1,
                duplicate: 0,
            });
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
