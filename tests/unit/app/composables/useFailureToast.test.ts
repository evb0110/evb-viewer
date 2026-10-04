// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    nextTick,
    ref,
    type VNode,
} from 'vue';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {requireEpochMs} from '@contracts/timestamps';

const toastAdd = vi.fn((_options: unknown) => undefined);
const toastUpdate = vi.fn();

function installUseToastStub() {
    vi.stubGlobal('useToast', () => ({
        add: toastAdd,
        update: toastUpdate,
    }));
}

interface IPresentedToast {
    color: string;
    title: string;
    description: () => VNode;
    actions: Array<{
        label: string;
        onClick: () => void;
    }>;
}

function presentedToast(index = 0) {
    return toastAdd.mock.calls[index]?.[0] as IPresentedToast;
}

function renderDescription(toast: IPresentedToast) {
    const host = document.createElement('div');
    const app = createApp({render: toast.description});
    app.mount(host);
    const text = [...host.querySelectorAll('span > span')].map(line => line.textContent);
    app.unmount();
    return text;
}

function createFailure(): FailureReceipt {
    return {
        eventId: '0123456789abcdef0123456789abcdef' as FailureReceipt['eventId'],
        code: 'UNCLASSIFIED_RENDERER_ERROR',
        occurredAt: requireEpochMs(1767225600000),
        severity: 'error',
    };
}

async function loadFailureToast() {
    return import('@app/composables/useFailureToast');
}

describe('useFailureToast', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        installUseToastStub();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('presents one short Error ID and keeps the full receipt local to copy', async () => {
        const {
            formatFailurePresentationCopy,
            useFailureToast,
        } = await loadFailureToast();
        const {presentFailureToast} = useFailureToast();
        const failure = createFailure();
        const presentation = {
            failure,
            title: 'Renderer failure',
            description: 'The document could not be opened.',
        };

        presentFailureToast(presentation);

        const toast = presentedToast();
        expect(toast).toMatchObject({
            color: 'error',
            title: 'Renderer failure',
        });
        expect(renderDescription(toast)).toEqual([
            'The document could not be opened.',
            'errors.runtime.errorId: 01234567',
        ]);
        expect(formatFailurePresentationCopy(presentation)).toBe([
            `Error ID: ${failure.eventId}`,
            'Renderer failure',
            'The document could not be opened.',
        ].join('\n'));
    });

    it('copies the full ID and local details without capturing', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', {clipboard: {writeText}});
        const {
            copyFailurePresentation,
            useFailureToast,
        } = await loadFailureToast();
        const failure = createFailure();
        const presentation = {
            failure,
            title: 'Renderer failure',
            description: 'The document could not be opened.',
        };

        expect(await copyFailurePresentation(presentation)).toBe(true);
        expect(writeText).toHaveBeenCalledWith([
            `Error ID: ${failure.eventId}`,
            'Renderer failure',
            'The document could not be opened.',
        ].join('\n'));
        expect(useFailureToast().copyFailurePresentation).toBe(copyFailurePresentation);
    });

    it('keeps technical details in Copy details instead of the short toast text', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', {clipboard: {writeText}});
        const {
            formatFailurePresentationCopy,
            useFailureToast,
        } = await loadFailureToast();
        const presentation = {
            failure: createFailure(),
            title: 'Failed to open file',
            description: 'The PDF viewer needs synchronized development dependencies.',
            technicalDetails: 'PDF.js vendored asset version mismatch at /pdf/.pdfjs-version',
        };

        useFailureToast().presentFailureToast(presentation);

        expect(renderDescription(presentedToast())).toEqual([
            'The PDF viewer needs synchronized development dependencies.',
            'errors.runtime.errorId: 01234567',
        ]);
        expect(formatFailurePresentationCopy(presentation)).toContain(presentation.technicalDetails);
    });

    it('puts the caller\'s actions first and always keeps Copy details', async () => {
        const {useFailureToast} = await loadFailureToast();
        const {presentFailureToast} = useFailureToast();
        const actions = [{
            label: 'Details',
            onClick: vi.fn(),
        }];

        presentFailureToast({
            failure: createFailure(),
            title: 'Renderer failure',
            actions,
        });

        expect(presentedToast().actions.map(action => action.label)).toEqual([
            'Details',
            'errors.runtime.copy',
        ]);
    });

    it('says Copied on the toast once the details are on the clipboard', async () => {
        vi.stubGlobal('navigator', {clipboard: {writeText: vi.fn().mockResolvedValue(undefined)}});
        const {useFailureToast} = await loadFailureToast();

        useFailureToast().presentFailureToast({
            failure: createFailure(),
            title: 'Renderer failure',
        });
        presentedToast().actions.at(-1)?.onClick();

        await vi.waitFor(() => expect(toastUpdate).toHaveBeenCalledOnce());
        expect(toastUpdate.mock.calls[0]?.[0]).toBe('0123456789abcdef0123456789abcdef');
        expect(toastUpdate.mock.calls[0]?.[1].actions.at(-1).label).toBe('errors.runtime.copied');
    });

    it('labels a toast in the locale current when it is shown, not when the composable was created', async () => {
        vi.stubGlobal('navigator', {clipboard: {writeText: vi.fn().mockResolvedValue(undefined)}});
        const locale = ref('en');
        vi.doMock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => `${locale.value}:${key}`})}));
        const {useFailureToast} = await loadFailureToast();
        const {presentFailureToast} = useFailureToast();

        locale.value = 'ru';
        presentFailureToast({
            failure: createFailure(),
            title: 'Не удалось открыть файл',
        });

        expect(renderDescription(presentedToast())).toEqual(['ru:errors.runtime.errorId: 01234567']);
        expect(presentedToast().actions.at(-1)?.label).toBe('ru:errors.runtime.copy');

        locale.value = 'de';
        presentedToast().actions.at(-1)?.onClick();
        await vi.waitFor(() => expect(toastUpdate).toHaveBeenCalledOnce());
        expect(toastUpdate.mock.calls[0]?.[1].actions.at(-1).label).toBe('de:errors.runtime.copied');
    });

    it('names the toast by its receipt so the toaster keeps one toast per failure', async () => {
        const {useFailureToast} = await loadFailureToast();
        const failure = createFailure();

        useFailureToast().presentFailureToast({
            failure,
            title: 'Failed to open file',
        });

        expect(toastAdd.mock.calls[0]?.[0]).toMatchObject({id: failure.eventId});
    });

    it('presents an expected outcome as a notice with nothing to copy', async () => {
        const {useFailureToast} = await loadFailureToast();

        useFailureToast().presentNoticeToast({
            tone: 'warning',
            title: 'Recent file is no longer available',
            description: 'gone.pdf was removed',
        });

        expect(toastAdd.mock.calls[0]?.[0]).toEqual({
            color: 'warning',
            icon: 'i-ph-warning',
            title: 'Recent file is no longer available',
            description: 'gone.pdf was removed',
        });
    });

    it('does not create another toast when the presenter owner rerenders', async () => {
        const {useFailureToast} = await loadFailureToast();
        const failure = createFailure();
        const revision = ref(0);
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(defineComponent({setup: () => {
            useFailureToast().presentFailureToast({
                failure,
                title: 'Renderer failure',
            });
            return () => h('span', revision.value);
        }}));

        app.mount(host);
        onTestFinished(() => {
            app.unmount();
            host.remove();
        });
        revision.value += 1;
        await nextTick();

        expect(toastAdd).toHaveBeenCalledOnce();
    });
});
