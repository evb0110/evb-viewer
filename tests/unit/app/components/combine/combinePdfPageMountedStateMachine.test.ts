// @vitest-environment happy-dom

import {
    createApp,
    defineComponent,
    h,
    nextTick,
    ref,
} from 'vue';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import type {TTranslateFn} from '@i18n-app';
import EN_MESSAGES from '@i18n-app/messages/en';
import {SerializableError} from '@contracts/serializableError';
import {CombinePdfError} from '@app/services/pdf/combinePdfFiles';
import {requireDocumentRef} from '@contracts/documentRef';
import { CombinePdfPage } from '@app/modules/combine/public';
import { useCombinePdfOperation } from '@app/modules/combine/useCombinePdfOperation';
import { useCombinePdfQueue } from '@app/modules/combine/useCombinePdfQueue';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

const mocks = vi.hoisted(() => ({
    combinePdfFiles: vi.fn(),
    isCombineCancellationSupported: vi.fn(),
    savePdfAs: vi.fn(),
    getDocumentRevision: vi.fn(),
    cleanupFile: vi.fn(async () => {}),
    logError: vi.fn(),
    failure: {
        eventId: '0123456789abcdef0123456789abcdef',
        code: 'UNCLASSIFIED_RENDERER_ERROR',
        occurredAt: 1,
        severity: 'error',
    } as FailureReceipt,
}));

vi.mock('@app/services/pdf/combinePdfFiles', () => ({
    CombinePdfError: class CombinePdfError extends Error {
        public readonly failure: FailureReceipt | undefined;

        public constructor(public readonly code: string, options?: {
            failure?: FailureReceipt;
            cause?: unknown
        }) {
            super(`PDF combine failed (${code})`, {cause: options?.cause});
            this.failure = options?.failure;
        }
    },
    combinePdfFiles: mocks.combinePdfFiles,
    isCombineCancellationSupported: mocks.isCombineCancellationSupported,
    getCombinePdfCapabilities: () => ({supportedExtensions: ['.pdf']}),
}));
const platformApi = createElectronPlatformApiFixture({
    documentFiles: {
        savePdfAs: mocks.savePdfAs,
        getDocumentRevision: mocks.getDocumentRevision,
    },
    documentWorkingCopy: {cleanupFile: mocks.cleanupFile},
});
vi.mock('@app/utils/platform', () => ({
    getPlatformAPI: () => platformApi,
    hasElectronAPI: () => false,
}));
vi.stubGlobal('useToast', () => ({add: vi.fn()}));
vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {error: mocks.logError}}));

const ButtonStub = defineComponent({
    inheritAttrs: false,
    setup: (_props, {
        attrs,
        slots,
    }) => () => h('button', {
        ...attrs,
        type: 'button',
    }, slots.default?.()),
});
const IconStub = defineComponent({setup: () => () => h('span')});
const PassthroughStub = defineComponent({setup: (_props, {slots}) => () => h('span', slots.default?.())});

interface IQueueFile {
    id: string;
    file: File;
    name: string;
}

const translate: TTranslateFn = (key, ...args) => {
    if (key === 'errors.browser.documentTooLarge') {
        const params = args[0];
        if (typeof params === 'object' && params !== null && 'limitMiB' in params) {
            return EN_MESSAGES.errors.browser.documentTooLarge.replace('{limitMiB}', String(params.limitMiB));
        }
    }
    if (key === 'errors.pdfStructurePreservation') return EN_MESSAGES.errors.pdfStructurePreservation;
    if (key === 'errors.browser.notEnoughMemory') return EN_MESSAGES.errors.browser.notEnoughMemory;
    return key;
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {
        promise,
        resolve,
    };
}

async function flushUpdates() {
    await Promise.resolve();
    await nextTick();
    await Promise.resolve();
    await nextTick();
}

function createQueueFile(id: string): IQueueFile {
    const file = new File([new Uint8Array([1])], `${id}.pdf`, { type: 'application/pdf' });
    return {
        id,
        file,
        name: file.name,
    };
}

async function mountCombinePageStateMachine(openResult: (result: TOpenFileResult) => Promise<boolean>) {
    const host = document.createElement('div');
    document.body.append(host);
    const Harness = defineComponent({setup() {
        const files = ref<IQueueFile[]>([
            createQueueFile('first'),
            createQueueFile('second'),
        ]);
        const operation = useCombinePdfOperation({
            files,
            openResult,
            emitOpenResult: () => undefined,
            translate,
        });
        const queue = useCombinePdfQueue({
            files,
            isMutationLocked: operation.queueMutationLocked,
            isSupported: () => true,
            toQueueItem: file => ({
                id: file.name,
                file,
                name: file.name,
            }),
        });

        return () => h('section', { class: 'combine-page-state-machine' }, [
            h('ol', files.value.map(item => h('li', {
                class: 'queue-row',
                key: item.id,
            }, item.name))),
            h('button', {
                class: 'remove',
                disabled: operation.queueMutationLocked.value,
                onClick: () => queue.removeFile(0),
            }, 'Remove'),
            h('button', {
                class: 'clear',
                disabled: operation.queueMutationLocked.value,
                onClick: queue.clearFiles,
            }, 'Clear'),
            operation.pendingCombinedResult.value && !operation.isCombining.value
                ? h('button', {
                    class: 'save-as',
                    onClick: operation.savePendingAs,
                }, 'Save As')
                : null,
            operation.pendingCombinedResult.value && !operation.isCombining.value
                ? h('button', {
                    class: 'discard',
                    onClick: operation.discardPendingResult,
                }, 'Discard')
                : null,
            operation.canCancel.value && operation.phase.value === 'combining'
                ? h('button', {
                    class: 'cancel',
                    onClick: operation.cancel,
                }, 'Cancel')
                : null,
            h('button', {
                class: 'combine',
                onClick: operation.combine,
            }, operation.pendingCombinedResult.value ? 'Retry' : 'Combine'),
            operation.combineError.value
                ? h('output', { class: 'error' }, operation.combineError.value)
                : null,
            h('output', { class: 'phase' }, operation.phase.value),
        ]);
    }});
    const app = createApp(Harness);
    app.mount(host);
    await nextTick();
    return {
        host,
        unmount() {
            app.unmount();
            host.remove();
        },
    };
}

describe('mounted Combine PDF page state machine', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.savePdfAs.mockResolvedValue('/tmp/saved.pdf');
        mocks.getDocumentRevision.mockImplementation(async (path: string) => ({token: `current-revision-of:${path}`}));
        mocks.logError.mockReturnValue(mocks.failure);
        mocks.isCombineCancellationSupported.mockReturnValue(true);
    });

    it('executes the page component with the queue controls unlocked', async () => {
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(CombinePdfPage, {
            showBack: false,
            showEyebrow: false,
            showHeader: false,
        });
        app.component('UButton', ButtonStub);
        app.component('UIcon', IconStub);
        app.component('UAlert', PassthroughStub);
        app.component('AppTooltip', PassthroughStub);
        app.mount(host);

        try {
            await nextTick();
            expect(host.querySelector('[data-combine-page]')).not.toBeNull();
            expect(host.querySelector('button')).not.toBeNull();
        } finally {
            app.unmount();
            host.remove();
        }
    });

    it('unlocks queue mutations after saving a failed-open result', async () => {
        const combined = deferred<TOpenFileResult>();
        const result: TOpenFileResult = {
            kind: 'pdf',
            workingPath: requireDocumentRef('/tmp/combined-working.pdf'),
            originalPath: requireDocumentRef('/tmp/combined-working.pdf'),
            isGenerated: true,
        };
        mocks.combinePdfFiles.mockReturnValueOnce(combined.promise);
        const openResult = vi.fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const page = await mountCombinePageStateMachine(openResult);

        (page.host.querySelector('.combine') as HTMLButtonElement).click();
        await nextTick();
        expect(page.host.querySelectorAll('.queue-row')).toHaveLength(2);
        expect((page.host.querySelector('.clear') as HTMLButtonElement).disabled).toBe(true);
        expect((page.host.querySelector('.remove') as HTMLButtonElement).disabled).toBe(true);

        (page.host.querySelector('.clear') as HTMLButtonElement).click();
        (page.host.querySelector('.remove') as HTMLButtonElement).click();
        expect(page.host.querySelectorAll('.queue-row')).toHaveLength(2);

        combined.resolve(result);
        await flushUpdates();
        expect(openResult).toHaveBeenCalledTimes(1);
        expect(page.host.querySelectorAll('.queue-row')).toHaveLength(2);
        expect(page.host.querySelector('.combine')?.textContent).toBe('Retry');
        expect(page.host.querySelector('.save-as')).not.toBeNull();
        expect(mocks.logError).toHaveBeenCalledOnce();
        expect((page.host.querySelector('.clear') as HTMLButtonElement).disabled).toBe(true);
        expect((page.host.querySelector('.remove') as HTMLButtonElement).disabled).toBe(true);

        (page.host.querySelector('.clear') as HTMLButtonElement).click();
        (page.host.querySelector('.remove') as HTMLButtonElement).click();
        expect(page.host.querySelectorAll('.queue-row')).toHaveLength(2);

        expect(mocks.cleanupFile).not.toHaveBeenCalled();
        (page.host.querySelector('.save-as') as HTMLButtonElement).click();
        await flushUpdates();
        // No document opened the result, so Save As names the working copy's
        // current revision; the main process refuses a save without one.
        expect(mocks.savePdfAs).toHaveBeenCalledWith('/tmp/combined-working.pdf', undefined, {expectedDocumentRevisionToken: 'current-revision-of:/tmp/combined-working.pdf'});
        // Saved elsewhere, the temporary combined file has no owner left.
        expect(mocks.cleanupFile).toHaveBeenCalledWith('/tmp/combined-working.pdf');

        expect(page.host.querySelector('.save-as')).toBeNull();
        expect(page.host.querySelector('.combine')?.textContent).not.toContain('Retry');
        expect((page.host.querySelector('.clear') as HTMLButtonElement).disabled).toBe(false);
        expect((page.host.querySelector('.remove') as HTMLButtonElement).disabled).toBe(false);
        (page.host.querySelector('.clear') as HTMLButtonElement).click();
        await nextTick();
        expect(page.host.querySelectorAll('.queue-row')).toHaveLength(0);
        expect(openResult).toHaveBeenCalledTimes(1);
        expect(mocks.combinePdfFiles).toHaveBeenCalledTimes(1);
        expect(mocks.logError).toHaveBeenCalledOnce();

        page.unmount();
    });

    it('hides cancel when the native batch cancel capability is unavailable', async () => {
        mocks.isCombineCancellationSupported.mockReturnValue(false);
        const combined = deferred<TOpenFileResult>();
        mocks.combinePdfFiles.mockReturnValueOnce(combined.promise);
        const page = await mountCombinePageStateMachine(vi.fn().mockResolvedValue(true));

        (page.host.querySelector('.combine') as HTMLButtonElement).click();
        await nextTick();

        expect(page.host.querySelector('.cancel')).toBeNull();

        combined.resolve({
            kind: 'pdf',
            workingPath: requireDocumentRef('/tmp/combined-working.pdf'),
            originalPath: requireDocumentRef('/tmp/combined-working.pdf'),
            isGenerated: true,
        });
        await flushUpdates();
        page.unmount();
    });

    it('moves from combining to opening and stops offering cancel once the PDF exists', async () => {
        const combined = deferred<TOpenFileResult>();
        const opened = deferred<boolean>();
        mocks.combinePdfFiles.mockReturnValueOnce(combined.promise);
        const page = await mountCombinePageStateMachine(() => opened.promise);

        (page.host.querySelector('.combine') as HTMLButtonElement).click();
        await nextTick();
        expect(page.host.querySelector('.phase')?.textContent).toBe('combining');
        expect(page.host.querySelector('.cancel')).not.toBeNull();

        combined.resolve({
            kind: 'pdf',
            workingPath: requireDocumentRef('/tmp/combined-working.pdf'),
            originalPath: requireDocumentRef('/tmp/combined-working.pdf'),
            isGenerated: true,
        });
        await flushUpdates();
        expect(page.host.querySelector('.phase')?.textContent).toBe('opening');
        expect(page.host.querySelector('.cancel')).toBeNull();

        opened.resolve(true);
        await flushUpdates();
        expect(page.host.querySelector('.phase')?.textContent).toBe('idle');
        expect(page.host.querySelectorAll('.queue-row')).toHaveLength(0);
        page.unmount();
    });

    it('names the failed step: combining the files or opening the result', async () => {
        mocks.combinePdfFiles.mockRejectedValueOnce(new Error('native combine crashed'));
        const failedCombine = await mountCombinePageStateMachine(vi.fn().mockResolvedValue(true));
        (failedCombine.host.querySelector('.combine') as HTMLButtonElement).click();
        await flushUpdates();
        expect(failedCombine.host.querySelector('.error')?.textContent).toBe('combinePdf.combineFailed');
        expect(failedCombine.host.querySelector('.combine')?.textContent).toBe('Combine');
        failedCombine.unmount();

        mocks.combinePdfFiles.mockResolvedValueOnce({
            kind: 'pdf',
            workingPath: requireDocumentRef('/tmp/combined-working.pdf'),
            originalPath: requireDocumentRef('/tmp/combined-working.pdf'),
            isGenerated: true,
        });
        const failedOpen = await mountCombinePageStateMachine(vi.fn().mockResolvedValue(false));
        (failedOpen.host.querySelector('.combine') as HTMLButtonElement).click();
        await flushUpdates();
        expect(failedOpen.host.querySelector('.error')?.textContent).toBe('errors.file.open');
        expect(failedOpen.host.querySelector('.combine')?.textContent).toBe('Retry');
        failedOpen.unmount();
    });

    it('shows the localized structure refusal through an outer capability failure', async () => {
        mocks.combinePdfFiles.mockRejectedValueOnce(new CombinePdfError('invalid-input', {cause: {
            code: 'native-failure',
            message: 'Native capability failed',
            cause: new SerializableError({
                code: 'invalid-request',
                message: 'ERR_PDF_STRUCTURE_PRESERVATION: layers cannot be preserved',
            }),
        }}));
        const page = await mountCombinePageStateMachine(vi.fn().mockResolvedValue(true));
        try {
            (page.host.querySelector('.combine') as HTMLButtonElement).click();
            await flushUpdates();
            expect(page.host.querySelector('.error')?.textContent).toBe('This operation was stopped because it cannot preserve the PDF’s accessibility tags or layers. No result was saved.');
            expect(page.host.querySelectorAll('.queue-row')).toHaveLength(2);
        } finally {
            page.unmount();
        }
    });

    it.each([
        {
            envelope: {
                code: 'browser-byte-limit',
                message: 'Request too large',
                maxBytes: 512 * 1024 * 1024,
            },
            message: EN_MESSAGES.errors.browser.documentTooLarge.replace('{limitMiB}', '512'),
        },
        {
            envelope: {
                code: 'too-large',
                message: 'Image combine WASM ran out of memory',
            },
            message: EN_MESSAGES.errors.browser.notEnoughMemory,
        },
    ])('shows the browser engine refusal as "$message"', async ({
        envelope, message,
    }) => {
        mocks.combinePdfFiles.mockRejectedValueOnce(new CombinePdfError('limit', {cause: new SerializableError(envelope)}));
        const page = await mountCombinePageStateMachine(vi.fn().mockResolvedValue(true));
        try {
            (page.host.querySelector('.combine') as HTMLButtonElement).click();
            await flushUpdates();
            expect(page.host.querySelector('.error')?.textContent).toBe(message);
            expect(page.host.querySelectorAll('.queue-row')).toHaveLength(2);
        } finally {
            page.unmount();
        }
    });

    it('leaves a newer pending result alone when an older Save As finishes late', async () => {
        const pendingResult = (name: string): TOpenFileResult => ({
            kind: 'pdf',
            workingPath: requireDocumentRef(`/tmp/${name}.pdf`),
            originalPath: requireDocumentRef(`/tmp/${name}.pdf`),
            isGenerated: true,
        });
        mocks.combinePdfFiles
            .mockResolvedValueOnce(pendingResult('combined-a'))
            .mockResolvedValueOnce(pendingResult('combined-b'));
        const saveA = deferred<string | null>();
        mocks.savePdfAs.mockReturnValueOnce(saveA.promise);
        const page = await mountCombinePageStateMachine(vi.fn().mockResolvedValue(false));

        (page.host.querySelector('.combine') as HTMLButtonElement).click();
        await flushUpdates();
        (page.host.querySelector('.save-as') as HTMLButtonElement).click();
        await flushUpdates();
        // A's Save As is still writing when A is discarded and B replaces it.
        (page.host.querySelector('.discard') as HTMLButtonElement).click();
        await nextTick();
        (page.host.querySelector('.combine') as HTMLButtonElement).click();
        await flushUpdates();
        expect(page.host.querySelector('.combine')?.textContent).toBe('Retry');
        saveA.resolve('/tmp/saved-a.pdf');
        await flushUpdates();

        expect(page.host.querySelector('.save-as')).not.toBeNull();
        expect(page.host.querySelector('.combine')?.textContent).toBe('Retry');
        expect(mocks.cleanupFile).not.toHaveBeenCalledWith('/tmp/combined-b.pdf');
        page.unmount();
    });

    it('keeps a pending result that Retry is opening when its Save As finishes', async () => {
        const path = requireDocumentRef('/tmp/combined-retry.pdf');
        mocks.combinePdfFiles.mockResolvedValueOnce({
            kind: 'pdf',
            workingPath: path,
            originalPath: path,
        });
        const saving = deferred<string | null>();
        const opening = deferred<boolean>();
        mocks.savePdfAs.mockReturnValueOnce(saving.promise);
        const page = await mountCombinePageStateMachine(vi.fn().mockResolvedValueOnce(false).mockReturnValueOnce(opening.promise));
        try {
            (page.host.querySelector('.combine') as HTMLButtonElement).click();
            await flushUpdates();
            (page.host.querySelector('.save-as') as HTMLButtonElement).click();
            await flushUpdates();
            // Retry opens the same file while its Save As is still writing.
            (page.host.querySelector('.combine') as HTMLButtonElement).click();
            await flushUpdates();
            expect(page.host.querySelector('.phase')?.textContent).toBe('opening');
            saving.resolve('/tmp/saved.pdf');
            await flushUpdates();
            expect(mocks.cleanupFile).not.toHaveBeenCalledWith(path);
            expect(page.host.querySelector('.phase')?.textContent).toBe('opening');
        } finally {
            opening.resolve(true);
            await flushUpdates();
            page.unmount();
        }
    });

    it('reports a Save As failure even while Retry is opening the same result', async () => {
        const path = requireDocumentRef('/tmp/combined-retry-failure.pdf');
        mocks.combinePdfFiles.mockResolvedValueOnce({
            kind: 'pdf',
            workingPath: path,
            originalPath: path,
        });
        const saving = Promise.withResolvers<string | null>();
        const opening = deferred<boolean>();
        mocks.savePdfAs.mockReturnValueOnce(saving.promise);
        const page = await mountCombinePageStateMachine(vi.fn().mockResolvedValueOnce(false).mockReturnValueOnce(opening.promise));
        try {
            (page.host.querySelector('.combine') as HTMLButtonElement).click();
            await flushUpdates();
            (page.host.querySelector('.save-as') as HTMLButtonElement).click();
            await flushUpdates();
            (page.host.querySelector('.combine') as HTMLButtonElement).click();
            await flushUpdates();
            saving.reject(new Error('disk full'));
            await flushUpdates();
            expect(page.host.querySelector('.error')?.textContent).toBe('errors.file.save');
        } finally {
            opening.resolve(true);
            await flushUpdates();
            page.unmount();
        }
    });

    it('discards a failed-open result without changing the queued files', async () => {
        const combined = deferred<TOpenFileResult>();
        mocks.combinePdfFiles.mockReturnValueOnce(combined.promise);
        const page = await mountCombinePageStateMachine(vi.fn().mockResolvedValue(false));

        (page.host.querySelector('.combine') as HTMLButtonElement).click();
        combined.resolve({
            kind: 'pdf',
            workingPath: requireDocumentRef('/tmp/combined-working.pdf'),
            originalPath: requireDocumentRef('/tmp/combined-working.pdf'),
            isGenerated: true,
        });
        await flushUpdates();

        expect(mocks.cleanupFile).not.toHaveBeenCalled();
        (page.host.querySelector('.discard') as HTMLButtonElement).click();
        await nextTick();

        expect(page.host.querySelector('.discard')).toBeNull();
        expect(page.host.querySelectorAll('.queue-row')).toHaveLength(2);
        expect((page.host.querySelector('.clear') as HTMLButtonElement).disabled).toBe(false);
        expect(mocks.cleanupFile).toHaveBeenCalledWith('/tmp/combined-working.pdf');
        page.unmount();
        expect(mocks.cleanupFile).toHaveBeenCalledOnce();
    });

    it('removes a pending combined file when the page goes away', async () => {
        const combined = deferred<TOpenFileResult>();
        mocks.combinePdfFiles.mockReturnValueOnce(combined.promise);
        const page = await mountCombinePageStateMachine(vi.fn().mockResolvedValue(false));

        (page.host.querySelector('.combine') as HTMLButtonElement).click();
        combined.resolve({
            kind: 'pdf',
            workingPath: requireDocumentRef('/tmp/combined-working.pdf'),
            originalPath: requireDocumentRef('/tmp/combined-working.pdf'),
            isGenerated: true,
        });
        await flushUpdates();
        expect(page.host.querySelector('.combine')?.textContent).toBe('Retry');

        page.unmount();
        expect(mocks.cleanupFile).toHaveBeenCalledWith('/tmp/combined-working.pdf');
    });

    it('leaves the combined file to the document that opened it', async () => {
        const combined = deferred<TOpenFileResult>();
        mocks.combinePdfFiles.mockReturnValueOnce(combined.promise);
        const page = await mountCombinePageStateMachine(vi.fn().mockResolvedValue(true));

        (page.host.querySelector('.combine') as HTMLButtonElement).click();
        combined.resolve({
            kind: 'pdf',
            workingPath: requireDocumentRef('/tmp/combined-working.pdf'),
            originalPath: requireDocumentRef('/tmp/combined-working.pdf'),
            isGenerated: true,
        });
        await flushUpdates();
        page.unmount();

        expect(mocks.cleanupFile).not.toHaveBeenCalled();
    });

    it('removes the combined file when the page goes away while its open fails', async () => {
        const opened = deferred<boolean>();
        mocks.combinePdfFiles.mockResolvedValueOnce({
            kind: 'pdf',
            workingPath: requireDocumentRef('/tmp/combined-working.pdf'),
            originalPath: requireDocumentRef('/tmp/combined-working.pdf'),
            isGenerated: true,
        });
        const page = await mountCombinePageStateMachine(() => opened.promise);

        (page.host.querySelector('.combine') as HTMLButtonElement).click();
        await flushUpdates();
        // The user leaves while the result is still opening; then it fails.
        page.unmount();
        expect(mocks.cleanupFile).not.toHaveBeenCalled();
        opened.resolve(false);
        await flushUpdates();

        expect(mocks.cleanupFile).toHaveBeenCalledWith('/tmp/combined-working.pdf');
    });

    it('leaves the combined file to the document when the page goes away while it opens', async () => {
        const opened = deferred<boolean>();
        mocks.combinePdfFiles.mockResolvedValueOnce({
            kind: 'pdf',
            workingPath: requireDocumentRef('/tmp/combined-working.pdf'),
            originalPath: requireDocumentRef('/tmp/combined-working.pdf'),
            isGenerated: true,
        });
        const page = await mountCombinePageStateMachine(() => opened.promise);

        (page.host.querySelector('.combine') as HTMLButtonElement).click();
        await flushUpdates();
        page.unmount();
        opened.resolve(true);
        await flushUpdates();

        expect(mocks.cleanupFile).not.toHaveBeenCalled();
    });
});
