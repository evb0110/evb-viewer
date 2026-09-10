import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    nextTick,
    ref,
} from 'vue';
import type { IShutdownSaveFlushResponse } from '@contracts/systemPlatformFeature';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    preventBrowserUnloadWhenDirty,
    useBrowserDirtyUnloadGuard,
    useShutdownSaveFlushReporting,
} from '@app/modules/workspace-shell/composables/useShutdownSaveFlushReporting';

const mocks = vi.hoisted(() => ({warn: vi.fn()}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {warn: mocks.warn}}));

type TShutdownSaveFlushCallback = () => Promise<IShutdownSaveFlushResponse> | IShutdownSaveFlushResponse;

function createHarness(options: {
    dirty?: boolean;
    workingCopyPath?: string | null;
    saveForExternalRead?: () => Promise<boolean> | boolean;
    flushAdditionalState?: () => Promise<void> | void;
} = {}) {
    let callback: TShutdownSaveFlushCallback | null = null;
    const unsubscribe = vi.fn();
    const onShutdownSaveFlushRequest = vi.fn((nextCallback: TShutdownSaveFlushCallback) => {
        callback = nextCallback;
        return unsubscribe;
    });
    const systemCapability = {onShutdownSaveFlushRequest};
    const workingCopyPath = ref<TDocumentRef | null>(
        options.workingCopyPath === undefined
            ? requireDocumentRef('/tmp/document-working-copy.pdf')
            : options.workingCopyPath === null
                ? null
                : requireDocumentRef(options.workingCopyPath),
    );
    const hasPendingUnsavedChanges = ref(options.dirty ?? true);
    const saveForExternalRead = vi.fn(options.saveForExternalRead ?? (async () => true));
    const scope = effectScope();

    scope.run(() => {
        useShutdownSaveFlushReporting({
            workingCopyPath,
            hasPendingUnsavedChanges,
            saveForExternalRead,
            ...(options.flushAdditionalState === undefined
                ? {}
                : {flushAdditionalState: options.flushAdditionalState}),
            systemCapability,
        });
    });

    return {
        hasPendingUnsavedChanges,
        saveForExternalRead,
        scope,
        systemCapability,
        unsubscribe,
        workingCopyPath,
        invoke: async () => {
            expect(callback).toEqual(expect.any(Function));
            return callback ? await callback() : {};
        },
    };
}

describe('useShutdownSaveFlushReporting', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('requests the browser confirmation dialog only for dirty documents', () => {
        const dirtyEvent = new Event('beforeunload', {cancelable: true}) as BeforeUnloadEvent;

        expect(preventBrowserUnloadWhenDirty(dirtyEvent, true)).toBe(true);
        expect(dirtyEvent.defaultPrevented).toBe(true);

        const cleanEvent = new Event('beforeunload', {cancelable: true}) as BeforeUnloadEvent;
        expect(preventBrowserUnloadWhenDirty(cleanEvent, false)).toBe(false);
        expect(cleanEvent.defaultPrevented).toBe(false);
    });

    it('attaches and removes the browser unload guard with reactive dirty state', async () => {
        const browserWindow = new EventTarget();
        vi.stubGlobal('window', browserWindow);
        const dirty = ref(false);
        const scope = effectScope();
        scope.run(() => useBrowserDirtyUnloadGuard(() => dirty.value));

        const initiallyClean = new Event('beforeunload', {cancelable: true});
        browserWindow.dispatchEvent(initiallyClean);
        expect(initiallyClean.defaultPrevented).toBe(false);

        dirty.value = true;
        await nextTick();
        const becameDirty = new Event('beforeunload', {cancelable: true});
        browserWindow.dispatchEvent(becameDirty);
        expect(becameDirty.defaultPrevented).toBe(true);

        dirty.value = false;
        await nextTick();
        const becameClean = new Event('beforeunload', {cancelable: true});
        browserWindow.dispatchEvent(becameClean);
        expect(becameClean.defaultPrevented).toBe(false);

        dirty.value = true;
        scope.stop();

        const afterStop = new Event('beforeunload', {cancelable: true});
        browserWindow.dispatchEvent(afterStop);
        expect(afterStop.defaultPrevented).toBe(false);
    });

    it('registers and disposes the shutdown save-flush subscriber', () => {
        const harness = createHarness();

        expect(harness.systemCapability.onShutdownSaveFlushRequest).toHaveBeenCalledTimes(1);
        harness.scope.stop();
        expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('flushes a dirty working copy before reporting it safe for shutdown cleanup', async () => {
        const harness = createHarness();

        await expect(harness.invoke()).resolves.toEqual({flushedWorkingCopyPaths: ['/tmp/document-working-copy.pdf']});
        expect(harness.saveForExternalRead).toHaveBeenCalledTimes(1);

        harness.scope.stop();
    });

    it('reports the captured dirty working copy when shutdown save cannot complete', async () => {
        const harness = createHarness({saveForExternalRead: async () => false});

        harness.workingCopyPath.value = requireDocumentRef('/tmp/document-working-copy-after-registration.pdf');
        await expect(harness.invoke()).resolves.toEqual({dirtyWorkingCopyPaths: ['/tmp/document-working-copy-after-registration.pdf']});
        expect(harness.saveForExternalRead).toHaveBeenCalledTimes(1);

        harness.scope.stop();
    });

    it('preserves a failed dirty materialization and reports its stable outcome code', async () => {
        const error = Object.assign(
            new Error('The original document is unavailable'),
            {code: 'SOURCE_BACKING_UNAVAILABLE'},
        );
        const harness = createHarness({saveForExternalRead: async () => {
            throw error;
        }});

        await expect(harness.invoke()).resolves.toEqual({dirtyWorkingCopyPaths: ['/tmp/document-working-copy.pdf']});
        expect(mocks.warn).toHaveBeenCalledWith(
            'workspace',
            'Failed to flush dirty working copy during shutdown',
            {
                error,
                errorCode: 'SOURCE_BACKING_UNAVAILABLE',
                workingCopyPath: '/tmp/document-working-copy.pdf',
            },
        );

        harness.scope.stop();
    });

    it('leaves clean or unopened documents unreported', async () => {
        const cleanHarness = createHarness({dirty: false});

        await expect(cleanHarness.invoke()).resolves.toEqual({});
        expect(cleanHarness.saveForExternalRead).not.toHaveBeenCalled();
        cleanHarness.scope.stop();

        const unopenedHarness = createHarness({workingCopyPath: null});

        await expect(unopenedHarness.invoke()).resolves.toEqual({});
        expect(unopenedHarness.saveForExternalRead).not.toHaveBeenCalled();
        unopenedHarness.scope.stop();
    });

    it('flushes additional persistence even when the document is clean or unopened', async () => {
        const flushCleanState = vi.fn(async () => {});
        const cleanHarness = createHarness({
            dirty: false,
            flushAdditionalState: flushCleanState,
        });

        await expect(cleanHarness.invoke()).resolves.toEqual({});
        expect(flushCleanState).toHaveBeenCalledOnce();
        cleanHarness.scope.stop();

        const flushUnopenedState = vi.fn(async () => {});
        const unopenedHarness = createHarness({
            workingCopyPath: null,
            flushAdditionalState: flushUnopenedState,
        });

        await expect(unopenedHarness.invoke()).resolves.toEqual({});
        expect(flushUnopenedState).toHaveBeenCalledOnce();
        unopenedHarness.scope.stop();
    });
});
