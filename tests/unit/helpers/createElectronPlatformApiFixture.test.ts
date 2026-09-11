import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { requireDocumentRef } from '@contracts/documentRef';
import type { IPdfSearchProgress } from '@contracts/search';
import { requireRequestId } from '@contracts/shared';
import {
    BROWSER_PLATFORM_MANIFEST,
    PLATFORM_API_DESCRIPTOR,
} from '@contracts/platformApi';
import {
    createDefaultPlatformApiFixtureMethod,
    createPlatformApiFixtureOperation,
    type IPlatformApiFixtureEventMethod,
} from '@tests/helpers/createDefaultPlatformApiFixtureMethod';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import { createPlatformApiFixture } from '@tests/helpers/createPlatformApiFixture';

function readPath(root: unknown, path: readonly string[]) {
    let value = root;
    for (const segment of path) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return undefined;
        }
        value = (value as Record<string, unknown>)[segment];
    }
    return value;
}

function formatPath(path: readonly string[]) {
    return path.join('.');
}

describe('createElectronPlatformApiFixture', () => {
    it('creates descriptor-complete callable methods', () => {
        const api = createElectronPlatformApiFixture();

        for (const descriptor of PLATFORM_API_DESCRIPTOR.methods) {
            expect(
                readPath(api, descriptor.path),
                formatPath(descriptor.path),
            ).toEqual(expect.any(Function));
        }
    });

    it('deep-merges split capability overrides', () => {
        const registerFilesForOpen = vi.fn(async () => [requireDocumentRef('/tmp/split.pdf')]);
        const openDocumentDialog = vi.fn(async () => null);
        const api = createElectronPlatformApiFixture({documentPicker: {
            registerFilesForOpen,
            openDocumentDialog,
        }});

        expect(api.documentPicker.registerFilesForOpen).toBe(registerFilesForOpen);
        expect(api.documentPicker.openDocumentDialog).toBe(openDocumentDialog);
        expect(api.documentRecentFiles.recentFiles.remove).toEqual(expect.any(Function));
    });

    it('generates electron native optional methods from the platform manifest', () => {
        const api = createElectronPlatformApiFixture();

        expect(api.documentFiles.repairPdf).toEqual(expect.any(Function));
        expect(api.documentFiles.getPdfOpeningGeometry).toEqual(expect.any(Function));
        expect(api.documentFiles.getPdfNativePageSizes).toEqual(expect.any(Function));
        expect(api.documentFiles.cancelPdfNativePagePreview).toEqual(expect.any(Function));
        expect(api.documentFiles.renderPdfNativePagePreview).toEqual(expect.any(Function));
        expect(api.diagnostics.startupPolicy).toEqual({mode: 'unknown'});
        expect(api.diagnostics.sendRecord).toEqual(expect.any(Function));
        expect(api.diagnostics.onDebugLog).toEqual(expect.any(Function));
    });

    it('uses migrated schema examples for Search defaults', async () => {
        const api = createElectronPlatformApiFixture();
        await expect(api.search.run('/tmp/example.pdf', 'needle'))
            .resolves.toEqual({
                results: [],
                truncated: false,
            });
        await expect(api.search.warmIndex('/tmp/example.pdf')).resolves.toBe(true);
        await expect(api.search.cancel()).resolves.toEqual({canceled: false});
        await expect(api.search.resetCache()).resolves.toBe(true);
        expect(api.search.onProgress(() => undefined)).toEqual(expect.any(Function));
    });

    it('delivers typed fixture events until the subscriber unsubscribes', () => {
        const api = createElectronPlatformApiFixture();
        const event = api.search.onProgress as typeof api.search.onProgress & IPlatformApiFixtureEventMethod;
        const first = vi.fn();
        const second = vi.fn();
        const unsubscribeFirst = api.search.onProgress(first);
        api.search.onProgress(second);
        const progress: IPdfSearchProgress = {
            requestId: requireRequestId('search-fixture'),
            processed: 1,
            total: 2,
            status: 'running',
        };

        event.emit(progress);
        unsubscribeFirst();
        unsubscribeFirst();
        event.emit(progress);

        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledTimes(2);
        event.dispose();
        event.dispose();
        event.emit(progress);
        expect(second).toHaveBeenCalledTimes(2);
    });

    it('exposes explicit replay and raw late-event controls without filtering the consumer input', () => {
        const api = createElectronPlatformApiFixture();
        const event = api.search.onProgress as typeof api.search.onProgress & IPlatformApiFixtureEventMethod<IPdfSearchProgress>;
        const received: IPdfSearchProgress[] = [];
        api.search.onProgress(progress => received.push(progress));
        const running = {
            requestId: requireRequestId('search-replay'),
            processed: 1,
            total: 2,
            status: 'running' as const,
        };
        const terminal = {
            ...running,
            processed: 2,
            status: 'success' as const,
        };
        event.replay(running);
        event.emit(terminal);
        event.emitLate({
            ...running,
            processed: 0,
        });

        expect(received).toEqual([
            running,
            terminal,
            {
                ...running,
                processed: 0,
            },
        ]);
    });

    it('provides an opt-in operation control for consumer cancellation and typed errors', async () => {
        const operation = createPlatformApiFixtureOperation<{ok: true}>();
        const pending = operation.method();
        await expect(operation.method()).rejects.toThrow('already has an in-flight invocation');
        operation.cancel();
        expect(operation.method).toHaveBeenCalledTimes(2);
        expect(operation.cancel).not.toThrow();
        await expect(pending).rejects.toThrow('Fixture operation canceled');

        const failedOperation = createPlatformApiFixtureOperation<{ok: true}>();
        const failed = failedOperation.method();
        failedOperation.reject(new Error('fixture failure'));
        await expect(failed).rejects.toThrow('fixture failure');
    });

    it('resolves valid undefined results without consuming examples during construction', async () => {
        const api = createElectronPlatformApiFixture();

        await expect(api.settings.save({theme: 'dark'})).resolves.toBeUndefined();
        await expect(api.shell.openExternal('https://example.test/')).resolves.toBeUndefined();
        await expect(api.windowTabs.resumeWorkspaceCheckpoint('1')).resolves.toBeUndefined();

        let calls = 0;
        const method = createDefaultPlatformApiFixtureMethod({
            path: [
                'settings',
                'save',
            ],
            kind: 'async',
            required: {
                electron: true,
                browser: true,
            },
            browserLazy: 'forwarded',
        }, () => {
            calls += 1;
            return undefined;
        });

        expect(calls).toBe(0);
        await expect((method as (value: unknown) => Promise<undefined>)({})).resolves.toBeUndefined();
        expect(calls).toBe(1);
    });

    it('rejects overrides that remove a required manifest method', () => {
        const overrides = {documentFiles: {}};
        Reflect.set(overrides.documentFiles, 'readFile', undefined);

        expect(() => createElectronPlatformApiFixture(overrides))
            .toThrow('Missing platform API fixture method documentFiles.readFile');
    });

    it('keeps required override members typed while allowing optional capability omission', () => {
        const browserApi = createPlatformApiFixture({
            backend: 'browser',
            manifest: BROWSER_PLATFORM_MANIFEST,
            overrides: {scanCleanup: {getSettings: undefined}},
        });
        const api = createElectronPlatformApiFixture({diagnostics: {
            startupPolicy: {mode: 'granted'},
            sendRecord: vi.fn(),
        }});

        expect(api.diagnostics.startupPolicy).toEqual({mode: 'granted'});
        expect(api.scanCleanup).toEqual(expect.any(Object));
        expect(browserApi.scanCleanup?.getSettings).toBeUndefined();
    });

    it('rejects required-field erasure and invalid typed diagnostics overrides at compile time', () => {
        if (process.env.EVB_FIXTURE_TYPE_ASSERTIONS === '1') {
            // @ts-expect-error Required Electron methods cannot be replaced with undefined.
            createElectronPlatformApiFixture({documentFiles: {readFile: undefined}});
            // @ts-expect-error Diagnostics policy values are closed by the shared contract.
            createElectronPlatformApiFixture({diagnostics: {startupPolicy: {mode: 'invalid'}}});
        }
    });

    it('rejects unsupported default calls instead of silently resolving undefined', async () => {
        const method = createDefaultPlatformApiFixtureMethod({
            path: [
                'shell',
                'unsupportedProbe',
            ],
            kind: 'async',
            required: {
                electron: false,
                browser: false,
            },
            browserLazy: 'direct',
        });

        await expect((method as () => Promise<unknown>)())
            .rejects.toThrow('Unsupported platform API fixture call: shell.unsupportedProbe');
    });
});
