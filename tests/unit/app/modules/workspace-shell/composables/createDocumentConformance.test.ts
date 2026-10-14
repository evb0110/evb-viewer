import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import {
    createDocumentConformance,
    type IPdfConformanceIdleScheduler,
} from '@app/modules/workspace-shell/composables/document-session/createDocumentConformance';
import { createDocumentSessionState } from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import { requireDocumentRef } from '@contracts/documentRef';

const { mockReadPdfConformanceProfile } = vi.hoisted(() => (
    {mockReadPdfConformanceProfile: vi.fn()}
));

vi.mock('@app/utils/platformDocuments', () => (
    {getDocumentPdfCapability: () => ({analyzePdfConformance: mockReadPdfConformanceProfile})}
));

const unsignedProfile = {
    isSigned: false,
    isEncrypted: false,
    isTagged: false,
    pdfaLevel: null,
    hasAcroForm: false,
    hasXfa: false,
    canIncrementalSave: true,
    saveRestrictions: [] as string[],
};

function deferred<T>() {
    let resolve: ((value: T) => void) | null = null;
    let reject: ((reason: unknown) => void) | null = null;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {
        promise,
        reject: (reason: unknown) => reject?.(reason),
        resolve: (value: T) => resolve?.(value),
    };
}

function createIdleScheduler() {
    let nextHandle = 0;
    const callbacks = new Map<number, () => void>();
    const scheduler: IPdfConformanceIdleScheduler = {
        cancel: handle => callbacks.delete(handle),
        schedule(callback) {
            const handle = ++nextHandle;
            callbacks.set(handle, callback);
            return handle;
        },
    };
    return {
        callbacks,
        flush() {
            const entries = [...callbacks.entries()];
            callbacks.clear();
            entries.forEach(([
                ,
                callback,
            ]) => callback());
        },
        scheduler,
    };
}

function createHarness(path = '/tmp/book.pdf') {
    const documentRef = requireDocumentRef(path);
    const state = createDocumentSessionState({isDesktopRuntime: ref(true)});
    state.workingCopyPath.value = documentRef;
    const idle = createIdleScheduler();
    const conformance = createDocumentConformance(state, idle.scheduler);
    return {
        conformance,
        idle,
        path: documentRef,
        state,
    };
}

describe('createDocumentConformance', () => {
    beforeEach(() => {
        mockReadPdfConformanceProfile.mockReset();
        mockReadPdfConformanceProfile.mockResolvedValue(unsignedProfile);
    });

    it('waits for the matching initial visual and idle slot', async () => {
        const {
            conformance,
            idle,
            path,
            state,
        } = createHarness();

        conformance.deferPdfConformanceProfile(path, {fileSize: 1024});
        expect(state.pdfConformanceAnalysisState.value).toBe('waiting-initial-visual');
        expect(mockReadPdfConformanceProfile).not.toHaveBeenCalled();
        expect(conformance.notifyPdfInitialVisualReady(requireDocumentRef('/tmp/other.pdf'))).toBe(false);
        expect(conformance.notifyPdfInitialVisualReady(path)).toBe(true);
        expect(state.pdfConformanceAnalysisState.value).toBe('waiting-idle');
        expect(mockReadPdfConformanceProfile).not.toHaveBeenCalled();

        idle.flush();
        await vi.waitFor(() => {
            expect(state.pdfConformanceProfile.value).toEqual(unsignedProfile);
        });
        expect(state.pdfConformanceAnalysisState.value).toBe('ready');
    });

    it('cancels a scheduled analysis and fences a stale in-flight result', async () => {
        const first = deferred<typeof unsignedProfile>();
        const secondProfile = {
            ...unsignedProfile,
            isTagged: true,
        };
        mockReadPdfConformanceProfile
            .mockImplementationOnce(() => first.promise)
            .mockResolvedValueOnce(secondProfile);
        const {
            conformance,
            idle,
            path,
            state,
        } = createHarness();

        conformance.deferPdfConformanceProfile(path);
        conformance.notifyPdfInitialVisualReady(path);
        idle.flush();
        expect(mockReadPdfConformanceProfile).toHaveBeenCalledTimes(1);

        state.workingCopyPath.value = requireDocumentRef('/tmp/next.pdf');
        conformance.deferPdfConformanceProfile(requireDocumentRef('/tmp/next.pdf'));
        first.resolve(unsignedProfile);
        await Promise.resolve();
        await Promise.resolve();
        expect(state.pdfConformanceProfile.value).toBeNull();
        expect(state.pdfConformanceAnalysisState.value).toBe('waiting-initial-visual');

        conformance.notifyPdfInitialVisualReady(requireDocumentRef('/tmp/next.pdf'));
        idle.flush();
        await vi.waitFor(() => {
            expect(state.pdfConformanceProfile.value).toEqual(secondProfile);
        });
    });

    it('shares scheduled and in-flight work with an immediate mutation check', async () => {
        const gate = deferred<typeof unsignedProfile>();
        mockReadPdfConformanceProfile.mockImplementation(() => gate.promise);
        const {
            conformance,
            idle,
            path,
        } = createHarness();

        conformance.deferPdfConformanceProfile(path);
        conformance.notifyPdfInitialVisualReady(path);
        const firstRefresh = conformance.refreshPdfConformanceProfile(path);
        const secondRefresh = conformance.refreshPdfConformanceProfile(path);
        expect(idle.callbacks.size).toBe(0);
        expect(mockReadPdfConformanceProfile).toHaveBeenCalledTimes(1);

        gate.resolve(unsignedProfile);
        await expect(Promise.all([
            firstRefresh,
            secondRefresh,
        ])).resolves.toEqual([
            unsignedProfile,
            unsignedProfile,
        ]);
        expect(mockReadPdfConformanceProfile).toHaveBeenCalledTimes(1);
    });

    it('keeps large files on demand and retries a failed analysis', async () => {
        const failure = new Error('analysis failed');
        mockReadPdfConformanceProfile
            .mockRejectedValueOnce(failure)
            .mockResolvedValueOnce(unsignedProfile);
        const {
            conformance,
            idle,
            path,
            state,
        } = createHarness();

        conformance.deferPdfConformanceProfile(path, {fileSize: 64 * 1024 * 1024 + 1});
        expect(state.pdfConformanceAnalysisState.value).toBe('on-demand-only');
        expect(conformance.notifyPdfInitialVisualReady(path)).toBe(true);
        expect(idle.callbacks.size).toBe(1);

        await expect(conformance.refreshPdfConformanceProfile(path)).rejects.toThrow(failure);
        expect(idle.callbacks.size).toBe(0);
        expect(state.pdfConformanceAnalysisState.value).toBe('failed');
        await expect(conformance.refreshPdfConformanceProfile(path)).resolves.toEqual(unsignedProfile);
        expect(state.pdfConformanceAnalysisState.value).toBe('ready');
        expect(mockReadPdfConformanceProfile).toHaveBeenCalledTimes(2);
    });

    it('primes the bounded save-restriction check after a large document becomes visible', async () => {
        mockReadPdfConformanceProfile.mockResolvedValue(unsignedProfile);
        const {
            conformance,
            idle,
            path,
            state,
        } = createHarness();

        conformance.deferPdfConformanceProfile(path, {fileSize: 64 * 1024 * 1024 + 1});
        expect(conformance.notifyPdfInitialVisualReady(path)).toBe(true);
        idle.flush();
        await vi.waitFor(() => expect(mockReadPdfConformanceProfile).toHaveBeenCalledOnce());

        await expect(conformance.shouldForceSaveAsForWorkingCopy('rewrite', path)).resolves.toBe(false);
        expect(mockReadPdfConformanceProfile).toHaveBeenCalledWith(path, {purpose: 'save-restrictions'});
        expect(mockReadPdfConformanceProfile).toHaveBeenCalledTimes(1);
        expect(state.pdfConformanceAnalysisState.value).toBe('on-demand-only');
    });

    it('cancels idle work when cleared', () => {
        const {
            conformance,
            idle,
            path,
            state,
        } = createHarness();

        conformance.deferPdfConformanceProfile(path);
        conformance.notifyPdfInitialVisualReady(path);
        expect(idle.callbacks.size).toBe(1);
        conformance.clearPdfConformanceProfile();
        expect(idle.callbacks.size).toBe(0);
        expect(state.pdfConformanceAnalysisState.value).toBe('none');
    });
});
