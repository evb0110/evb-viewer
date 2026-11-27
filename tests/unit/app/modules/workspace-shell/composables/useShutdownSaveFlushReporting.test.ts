import {afterEach, describe, expect, it, vi} from 'vitest';
import {effectScope, nextTick, ref} from 'vue';
import type {IShutdownSaveFlushResponse} from '@contracts/systemPlatformFeature';
import {requireDocumentRef, type TDocumentRef} from '@contracts/documentRef';
import {
    preventBrowserUnloadWhenDirty,
    useBrowserDirtyUnloadGuard,
    useShutdownSaveFlushReporting,
} from '@app/modules/workspace-shell/composables/useShutdownSaveFlushReporting';

const mocks = vi.hoisted(() => ({info: vi.fn()}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {info: mocks.info}}));

type TShutdownSaveFlushCallback = () => Promise<IShutdownSaveFlushResponse> | IShutdownSaveFlushResponse;

function createHarness(
    options: {
        dirty?: boolean;
        workingCopyPath?: string | null;
        flushAdditionalState?: () => Promise<void> | void;
    } = {},
) {
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
    const scope = effectScope();

    scope.run(() => {
        useShutdownSaveFlushReporting({
            workingCopyPath,
            hasPendingUnsavedChanges,
            ...(options.flushAdditionalState === undefined ? {} : {flushAdditionalState: options.flushAdditionalState}),
            systemCapability,
        });
    });

    return {
        hasPendingUnsavedChanges,
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
        let activeBeforeUnloadListeners = 0;
        const browserWindow = new EventTarget();
        const originalAdd = browserWindow.addEventListener.bind(browserWindow);
        const originalRemove = browserWindow.removeEventListener.bind(browserWindow);
        browserWindow.addEventListener = (type, listener, options) => {
            if (type === 'beforeunload') {
                activeBeforeUnloadListeners += 1;
            }
            return originalAdd(type, listener, options);
        };
        browserWindow.removeEventListener = (type, listener, options) => {
            if (type === 'beforeunload') {
                activeBeforeUnloadListeners -= 1;
            }
            return originalRemove(type, listener, options);
        };
        vi.stubGlobal('window', browserWindow);
        const dirty = ref(false);
        const scope = effectScope();
        scope.run(() => useBrowserDirtyUnloadGuard(() => dirty.value));

        expect(activeBeforeUnloadListeners).toBe(0);
        const initiallyClean = new Event('beforeunload', {cancelable: true});
        browserWindow.dispatchEvent(initiallyClean);
        expect(initiallyClean.defaultPrevented).toBe(false);

        dirty.value = true;
        await nextTick();
        expect(activeBeforeUnloadListeners).toBe(1);
        const becameDirty = new Event('beforeunload', {cancelable: true});
        browserWindow.dispatchEvent(becameDirty);
        expect(becameDirty.defaultPrevented).toBe(true);

        dirty.value = false;
        await nextTick();
        expect(activeBeforeUnloadListeners).toBe(0);
        const becameClean = new Event('beforeunload', {cancelable: true});
        browserWindow.dispatchEvent(becameClean);
        expect(becameClean.defaultPrevented).toBe(false);

        dirty.value = true;
        await nextTick();
        expect(activeBeforeUnloadListeners).toBe(1);
        scope.stop();
        expect(activeBeforeUnloadListeners).toBe(0);

        const afterStop = new Event('beforeunload', {cancelable: true});
        browserWindow.dispatchEvent(afterStop);
        expect(afterStop.defaultPrevented).toBe(false);
    });

    it('attaches immediately when initially dirty and detaches on scope disposal', () => {
        const browserWindow = new EventTarget();
        vi.stubGlobal('window', browserWindow);
        const dirty = ref(true);
        const scope = effectScope();
        scope.run(() => useBrowserDirtyUnloadGuard(() => dirty.value));

        const whileDirty = new Event('beforeunload', {cancelable: true});
        browserWindow.dispatchEvent(whileDirty);
        expect(whileDirty.defaultPrevented).toBe(true);

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

    it('leaves a dirty working copy for checkpoint recovery during shutdown', async () => {
        const harness = createHarness();

        await expect(harness.invoke()).resolves.toEqual({dirtyWorkingCopyPaths: ['/tmp/document-working-copy.pdf']});
        expect(mocks.info).toHaveBeenCalledWith(
            'workspace',
            expect.stringContaining('checkpoint recovery'),
            expect.objectContaining({workingCopyPath: '/tmp/document-working-copy.pdf'}),
        );

        harness.scope.stop();
    });

    it('leaves clean or unopened documents unreported', async () => {
        const cleanHarness = createHarness({dirty: false});

        await expect(cleanHarness.invoke()).resolves.toEqual({});
        cleanHarness.scope.stop();

        const unopenedHarness = createHarness({workingCopyPath: null});

        await expect(unopenedHarness.invoke()).resolves.toEqual({});
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
