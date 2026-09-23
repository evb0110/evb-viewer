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
import {requireDocumentRef} from '@contracts/documentRef';
import CombinePdfPage from '@app/components/combine/CombinePdfPage.vue';
import { useCombinePdfOperation } from '@app/modules/combine/useCombinePdfOperation';
import { useCombinePdfQueue } from '@app/modules/combine/useCombinePdfQueue';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

const mocks = vi.hoisted(() => ({
    combinePdfFiles: vi.fn(),
    isCombineCancellationSupported: vi.fn(),
    savePdfAs: vi.fn(),
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

        public constructor(public readonly code: string, options?: {failure?: FailureReceipt}) {
            super(`PDF combine failed (${code})`);
            this.failure = options?.failure;
        }
    },
    combinePdfFiles: mocks.combinePdfFiles,
    isCombineCancellationSupported: mocks.isCombineCancellationSupported,
    getCombinePdfCapabilities: () => ({
        supportedExtensions: ['.pdf'],
        maxInputs: 500,
        maxInputBytes: 32 * 1024 * 1024,
        maxTotalInputBytes: 64 * 1024 * 1024,
    }),
}));
const platformApi = createElectronPlatformApiFixture({
    documentFiles: {savePdfAs: mocks.savePdfAs},
    documentWorkingCopy: {cleanupFile: mocks.cleanupFile},
});
vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => platformApi}));
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
            translate: key => key,
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
        expect(mocks.savePdfAs).toHaveBeenCalledWith('/tmp/combined-working.pdf', undefined);
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
});
