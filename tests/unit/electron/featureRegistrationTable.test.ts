import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    FEATURE_REGISTRATION_DESCRIPTORS,
    RAW_IPC_HANDLER_DESCRIPTORS,
    type IFeatureRegistrationDescriptor,
} from '@electron/platform-ipc/featureRegistrationTable';
import {createRawIpcRegistrationAudit} from '@electron/platform-ipc/rawIpcRegistration';
import {createFeatureRegistrationRuntime} from '@electron/platform-ipc/registerFeatureIpcAdapters';

describe('main-process feature registration table', () => {
    it('type-checks disposer keys against the binding returned by the loader', () => {
        if (process.env.EVB_REGISTRATION_TYPE_ASSERTIONS === '1') {
            const invalidDescriptor: IFeatureRegistrationDescriptor<{dispose: () => Promise<void>}> = {
                name: 'invalid-fixture',
                startOrder: 1,
                kind: 'platform',
                create: async () => ({dispose: async () => undefined}),
                lifecycle: {
                    create: 'fixture',
                    ipcRegistration: 'fixture',
                    shutdown: 'fixture',
                },
                // @ts-expect-error A disposer key must be exported by the loader binding.
                disposeBindingKey: 'missing',
            };
            void invalidDescriptor;
        }
    });

    it('enumerates every feature with a unique start order and complete hooks', () => {
        const names = FEATURE_REGISTRATION_DESCRIPTORS.map(descriptor => descriptor.name);
        const startOrders = FEATURE_REGISTRATION_DESCRIPTORS.map(descriptor => descriptor.startOrder);

        expect(names).toEqual([
            'documentPicker',
            'documentOpen',
            'documentWorkingCopy',
            'documentFiles',
            'documentPdf',
            'documentRecentFiles.recentFiles',
            'documentWindow',
            'documentMenu',
            'window-tabs',
            'agent',
            'settings',
            'shell',
            'updates',
            'host',
            'image-export',
            'page-ops',
            'ocr',
            'scan-cleanup',
            'search',
            'djvu',
        ]);
        expect(new Set(startOrders).size).toBe(startOrders.length);
        expect(startOrders).toEqual([...startOrders].sort((left, right) => left - right));
        for (const descriptor of FEATURE_REGISTRATION_DESCRIPTORS) {
            expect(descriptor.lifecycle.create).not.toBe('');
            expect(descriptor.lifecycle.ipcRegistration).not.toBe('');
            expect(descriptor.lifecycle.shutdown).not.toBe('');
        }
    });

    it('derives shutdown order by reversing the start order', () => {
        const shutdownNames = [...FEATURE_REGISTRATION_DESCRIPTORS]
            .sort((left, right) => right.startOrder - left.startOrder)
            .map(descriptor => descriptor.name);

        expect(shutdownNames).toEqual([
            'djvu',
            'search',
            'scan-cleanup',
            'ocr',
            'page-ops',
            'image-export',
            'host',
            'updates',
            'shell',
            'settings',
            'agent',
            'window-tabs',
            'documentMenu',
            'documentWindow',
            'documentRecentFiles.recentFiles',
            'documentPdf',
            'documentFiles',
            'documentWorkingCopy',
            'documentOpen',
            'documentPicker',
        ]);
    });

    it('keeps raw IPC bridges explicit and justified', () => {
        expect(RAW_IPC_HANDLER_DESCRIPTORS).toEqual([
            {
                name: 'diagnostics-canary',
                reason: 'automation-only trusted-sender canary, not a renderer feature invoke',
            },
            {
                name: 'renderer-log',
                reason: 'one-way renderer diagnostic bridge with process-level suppression metadata',
            },
            {
                name: 'renderer-diagnostic',
                reason: 'one-way renderer diagnostic bridge with trusted-sender capture',
            },
            {
                name: 'shutdown-save-flush-result',
                reason: 'temporary renderer-to-main shutdown handshake, not a feature request',
            },
            {
                name: 'window-close-response',
                reason: 'temporary native window-close handshake response',
            },
        ]);
        expect(new Set(RAW_IPC_HANDLER_DESCRIPTORS.map(handler => handler.name)).size)
            .toBe(RAW_IPC_HANDLER_DESCRIPTORS.length);
    });

    it('rejects duplicate and orphan raw registrations at the runtime seam', () => {
        const audit = createRawIpcRegistrationAudit();

        audit.register('renderer-log', () => undefined);
        expect(() => audit.register('renderer-log', () => undefined))
            .toThrow('Duplicate raw IPC registration: renderer-log (global)');
        expect(audit.getRegisteredNames()).toEqual(['renderer-log']);
    });

    it('allows distinct live-window scopes and releases each scope', () => {
        const audit = createRawIpcRegistrationAudit();

        audit.register('window-close-response', () => undefined, 'window:1');
        audit.register('window-close-response', () => undefined, 'window:2');
        expect(audit.getRegisteredNames()).toEqual([
            'window-close-response',
            'window-close-response',
        ]);
        expect(() => audit.register('window-close-response', () => undefined, 'window:1'))
            .toThrow('Duplicate raw IPC registration: window-close-response (window:1)');

        audit.release('window-close-response', 'window:1');
        expect(audit.getRegisteredNames()).toEqual(['window-close-response']);
    });

    it('disposes retained registrations in reverse order exactly once', async () => {
        const calls: string[] = [];
        const registrations = FEATURE_REGISTRATION_DESCRIPTORS.slice(0, 3).map(descriptor => ({
            descriptor,
            dispose: vi.fn(async () => {
                calls.push(descriptor.name);
            }),
        }));
        const runtime = createFeatureRegistrationRuntime(registrations);

        await runtime.disposeAll();
        await runtime.disposeAll();

        expect(calls).toEqual([
            'documentWorkingCopy',
            'documentOpen',
            'documentPicker',
        ]);
        expect(registrations.map(registration => registration.dispose.mock.calls.length))
            .toEqual([
                1,
                1,
                1,
            ]);
    });

    it('shares the in-flight disposal promise with concurrent shutdown callers', async () => {
        let release!: () => void;
        const blocker = new Promise<void>(resolve => {
            release = resolve;
        });
        const registration = {
            descriptor: FEATURE_REGISTRATION_DESCRIPTORS[0]!,
            dispose: vi.fn(async () => blocker),
        };
        const runtime = createFeatureRegistrationRuntime([registration]);

        const first = runtime.disposeAll();
        const second = runtime.disposeAll();

        expect(second).toBe(first);
        expect(registration.dispose).toHaveBeenCalledOnce();
        let secondSettled = false;
        void second.then(() => {
            secondSettled = true;
        });
        await Promise.resolve();
        expect(secondSettled).toBe(false);

        release();
        await expect(first).resolves.toBeUndefined();
        expect(secondSettled).toBe(true);
    });

});
