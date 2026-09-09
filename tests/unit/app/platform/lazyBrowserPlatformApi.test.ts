import type * as TViMockOriginalModule from '@app/platform/validatePlatformApi';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    browserLoggerError: vi.fn(),
    browserPlatformImportCount: 0,
    onMenuSave: vi.fn(() => () => {}),
    openDocumentDirect: vi.fn(async (path: string) => ({
        kind: 'pdf',
        originalPath: path,
        workingPath: `${path}#working`,
    })),
    readTextFile: vi.fn(async (path: string) => `read ${path}`),
}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    error: mocks.browserLoggerError,
}}));

vi.mock('@app/platform/validatePlatformApi', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    PlatformContractError: class PlatformContractError extends Error {
        readonly failures: unknown[];

        constructor(message: string, failures: unknown[]) {
            super(message);
            this.name = 'PlatformContractError';
            this.failures = failures;
        }
    },
    validateBrowserPlatformApi: vi.fn(() => ({
        ok: true,
        failures: [],
    })),
}));

vi.mock('@app/platform/browserPlatformApi', () => {
    mocks.browserPlatformImportCount += 1;
    return {browserPlatformApi: {
        documentFiles: {readTextFile: mocks.readTextFile},
        documentMenu: {onMenuSave: mocks.onMenuSave},
        documentOpen: {openDocumentDirect: mocks.openDocumentDirect},
    }};
});

describe('lazyBrowserPlatformApi', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.browserPlatformImportCount = 0;
    });

    it('does not load the browser platform module until a forwarded lazy method is used', async () => {
        const { lazyBrowserPlatformApi } = await import('@app/platform/lazyBrowserPlatformApi');

        expect(mocks.browserPlatformImportCount).toBe(0);

        const unsubscribe = lazyBrowserPlatformApi.documentMenu.onMenuSave(vi.fn());

        await vi.waitFor(() => {
            expect(mocks.browserPlatformImportCount).toBe(1);
        });
        unsubscribe();
    });

    it('keeps direct browser-only members synchronous without loading the browser platform module', async () => {
        const { lazyBrowserPlatformApi } = await import('@app/platform/lazyBrowserPlatformApi');

        const firstFile = new File([new Uint8Array([1])], 'first.pdf', { type: 'application/pdf' });
        const secondFile = new File([new Uint8Array([2])], 'second.pdf', { type: 'application/pdf' });
        const firstRef = lazyBrowserPlatformApi.documentPicker?.getPathForFile(firstFile);
        const refs = lazyBrowserPlatformApi.documentPicker?.getPathsForFiles([
            firstFile,
            secondFile,
        ]);

        expect(firstRef).toMatch(/^browser:\/\/documents\//u);
        expect(refs?.[0]).toBe(firstRef);
        expect(refs?.[1]).toMatch(/^browser:\/\/documents\//u);
        expect(lazyBrowserPlatformApi.system.getMemoryInfo()).toBeNull();
        expect(mocks.browserPlatformImportCount).toBe(0);
    });

    it('reports split lazy event subscription failures with the split capability path', async () => {
        const subscriptionError = new Error('split subscription failed');
        mocks.onMenuSave.mockImplementation(() => {
            throw subscriptionError;
        });
        const { lazyBrowserPlatformApi } = await import('@app/platform/lazyBrowserPlatformApi');

        const unsubscribe = lazyBrowserPlatformApi.documentMenu.onMenuSave(vi.fn());

        await vi.waitFor(() => {
            expect(mocks.browserLoggerError).toHaveBeenCalledWith(
                'platform',
                'Failed to subscribe to browser event documentMenu.onMenuSave',
                subscriptionError,
                {
                    code: 'RENDERER_BROWSER_EVENT_SUBSCRIPTION_FAILED',
                    context: {},
                },
            );
        });
        unsubscribe();
    });
});
