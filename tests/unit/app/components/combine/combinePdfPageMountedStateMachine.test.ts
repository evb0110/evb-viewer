// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/utils/platformDocuments';

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

const mocks = vi.hoisted(() => ({
    combinePdfFiles: vi.fn(),
    savePdfAs: vi.fn(),
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
    getCombinePdfCapabilities: () => ({
        supportedExtensions: ['.pdf'],
        maxInputs: 500,
        maxInputBytes: 32 * 1024 * 1024,
        maxTotalInputBytes: 64 * 1024 * 1024,
    }),
}));
vi.mock('@app/utils/platformDocuments', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getDocumentFilesCapability: () => ({ savePdfAs: mocks.savePdfAs }),
}));
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
            h('button', {
                class: 'combine',
                onClick: operation.combine,
            }, operation.pendingCombinedResult.value ? 'Retry' : 'Combine'),
            operation.combineError.value
                ? h('output', { class: 'error' }, operation.combineError.value)
                : null,
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

    it('locks queue mutations, retains a failed-open result, then saves or retries without recombining', async () => {
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

        (page.host.querySelector('.save-as') as HTMLButtonElement).click();
        await flushUpdates();
        expect(mocks.savePdfAs).toHaveBeenCalledWith('/tmp/combined-working.pdf', undefined);

        (page.host.querySelector('.combine') as HTMLButtonElement).click();
        await flushUpdates();
        expect(openResult).toHaveBeenCalledTimes(2);
        expect(mocks.combinePdfFiles).toHaveBeenCalledTimes(1);
        expect(page.host.querySelectorAll('.queue-row')).toHaveLength(0);
        expect(page.host.querySelector('.save-as')).toBeNull();
        expect(mocks.logError).toHaveBeenCalledOnce();

        page.unmount();
    });
});
