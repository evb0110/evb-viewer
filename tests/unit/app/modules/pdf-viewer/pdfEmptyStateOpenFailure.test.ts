// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    nextTick,
} from 'vue';
import { decodeFailureReceipt } from '@contracts/diagnostics/failureReceipt';
import type { IStartOpenFailure } from '@app/types/startSection';
import PdfEmptyState from '@app/modules/pdf-viewer/components/PdfEmptyState.vue';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

afterEach(() => {
    document.body.innerHTML = '';
});

interface IAlertAction {
    label: string;
    onClick: () => void;
}

async function mountStartWithOpenFailure(openFailure: IStartOpenFailure) {
    const host = document.createElement('div');
    document.body.append(host);
    const onDismissOpenFailure = vi.fn();
    const app = createApp(defineComponent({setup: () => () => h(PdfEmptyState, {
        recentFiles: [],
        recentFilesResolved: true,
        openFailure,
        onDismissOpenFailure,
    })}));
    app.component('UIcon', defineComponent({setup: () => () => h('span')}));
    app.component('UButton', defineComponent({
        props: {label: String},
        setup: props => () => h('button', props.label),
    }));
    app.component('UInput', defineComponent({setup: () => () => h('input')}));
    app.component('UAlert', defineComponent({
        props: {
            title: String,
            description: String,
            actions: Array,
        },
        setup: props => () => h('div', {'data-alert': ''}, [
            h('strong', props.title),
            h('p', props.description),
            ...((props.actions ?? []) as IAlertAction[]).map(action => h('button', {
                'data-alert-action': action.label,
                onClick: action.onClick,
            }, action.label)),
        ]),
    }));
    app.component('AppTooltip', defineComponent({setup: (_, {slots}) => () => h('span', slots.default?.())}));
    app.component('UModal', defineComponent({setup: () => () => null}));
    app.mount(host);
    await nextTick();
    const alert = host.querySelector<HTMLElement>('[data-testid="start-open-failure"]');
    return {
        alert,
        onDismissOpenFailure,
        unmount: () => app.unmount(),
    };
}

describe('PdfEmptyState open failure', () => {
    it('names the file that failed and dismisses a message-only failure', async () => {
        const {
            alert,
            onDismissOpenFailure,
            unmount,
        } = await mountStartWithOpenFailure({
            fileName: 'broken.pdf',
            message: 'Invalid or non-existent file',
            failure: null,
        });

        expect(alert?.textContent).toContain('errors.file.open');
        expect(alert?.textContent).toContain('broken.pdf: Invalid or non-existent file');
        expect(alert?.textContent).not.toContain('Error ID');
        alert?.querySelector<HTMLButtonElement>('[data-alert-action="errors.runtime.dismiss"]')?.click();
        expect(onDismissOpenFailure).toHaveBeenCalledOnce();
        unmount();
    });

    it('shows the error ID and a copy action when the failure has a receipt', async () => {
        const failure = decodeFailureReceipt({
            eventId: '0123456789abcdef0123456789abcdef',
            code: 'RENDERER_PDF_DOCUMENT_LOAD_FAILED',
            occurredAt: 1_790_000_000_000,
            severity: 'error',
        });
        expect(failure).not.toBeNull();
        const {
            alert,
            onDismissOpenFailure,
            unmount,
        } = await mountStartWithOpenFailure({
            fileName: 'broken.pdf',
            message: 'Invalid or non-existent file',
            failure,
        });

        expect(alert?.textContent).toContain('broken.pdf: Invalid or non-existent file');
        expect(alert?.textContent).toContain('Error ID: 01234567');
        expect(alert?.querySelector('[data-alert-action="errors.runtime.copy"]')).not.toBeNull();
        alert?.querySelector<HTMLButtonElement>('[data-alert-action="errors.runtime.dismiss"]')?.click();
        expect(onDismissOpenFailure).toHaveBeenCalledOnce();
        unmount();
    });
});
