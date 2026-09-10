// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    nextTick,
    ref,
    Teleport,
} from 'vue';
import AppFatalRuntimeDialog from '@app/components/AppFatalRuntimeDialog.vue';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {requireEpochMs} from '@contracts/timestamps';

const AlertStub = defineComponent({setup: (_props, {slots}) => () => h('section', [
    slots.title?.(),
    slots.description?.(),
])});

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

const activeUnmounts = new Set<() => void>();

function mountDialog(
    detail: string | null = 'Error: renderer failed',
    initiallyOpen = true,
    failure: FailureReceipt | null = null,
    errorIdLabel = 'Error ID',
) {
    const host = document.createElement('div');
    document.body.append(host);
    const open = ref(initiallyOpen);
    let reloadCount = 0;
    let copyCount = 0;
    let copiedText: string | undefined;
    const app = createApp(defineComponent({setup: () => () => h(AppFatalRuntimeDialog, {
        open: open.value,
        title: 'EVB Viewer stopped',
        description: 'Reload the application to recover.',
        detail,
        detailLabel: 'Details',
        errorIdLabel,
        failure,
        reloadLabel: 'Reload',
        copyLabel: 'Copy Details',
        copied: false,
        onReload: () => {
            reloadCount += 1;
        },
        onCopy: (text?: string) => {
            copyCount += 1;
            copiedText = text;
        },
    }, {default: () => [
        h('button', {'data-workspace-action': ''}, 'Workspace action'),
        h(Teleport, {to: 'body'}, h('button', {'data-teleported-action': ''}, 'Teleported action')),
    ]})}));
    app.component('UAlert', AlertStub);
    app.component('UButton', ButtonStub);
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);

    return {
        counters: () => ({
            copy: copyCount,
            reload: reloadCount,
        }),
        copiedText: () => copiedText,
        dialog: () => host.querySelector<HTMLElement>('[role="alertdialog"]')!,
        heading: () => host.querySelector<HTMLHeadingElement>('#fatal-runtime-title')!,
        host,
        open,
        unmount,
        workspace: () => host.querySelector<HTMLElement>('[data-fatal-runtime-workspace]')!,
    };
}

function pressTab(target: HTMLElement, shiftKey = false) {
    target.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Tab',
        shiftKey,
    }));
}

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
});

describe('AppFatalRuntimeDialog', () => {
    it('presents a modal alert and makes the failed workspace inert', async () => {
        const mounted = mountDialog();
        await nextTick();

        const dialog = mounted.dialog();
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.getAttribute('aria-labelledby')).toBe('fatal-runtime-title');
        expect(dialog.getAttribute('aria-describedby')).toBe('fatal-runtime-description fatal-runtime-detail');
        expect((dialog as HTMLDialogElement).open).toBe(true);
        expect(mounted.workspace().hasAttribute('inert')).toBe(true);
        expect(document.activeElement).toBe(mounted.heading());
    });

    it('moves focus into the dialog when a running workspace fails', async () => {
        const mounted = mountDialog('Error: renderer failed', false);
        const workspaceAction = mounted.host.querySelector<HTMLButtonElement>('[data-workspace-action]')!;
        workspaceAction.focus();
        expect(mounted.workspace().hasAttribute('inert')).toBe(false);

        mounted.open.value = true;
        await nextTick();
        await nextTick();

        expect(mounted.workspace().hasAttribute('inert')).toBe(true);
        expect(document.activeElement).toBe(mounted.heading());
    });

    it('returns focus from body teleports to the fatal dialog', async () => {
        const mounted = mountDialog();
        await nextTick();
        const teleportedAction = document.querySelector<HTMLButtonElement>('[data-teleported-action]')!;

        teleportedAction.focus();

        expect(document.activeElement).toBe(mounted.heading());
    });

    it('contains forward and reverse Tab movement within its recovery controls', async () => {
        const mounted = mountDialog();
        await nextTick();
        const dialog = mounted.dialog();
        const reload = mounted.host.querySelector<HTMLElement>('[data-fatal-runtime-action="reload"]')!;
        const copy = mounted.host.querySelector<HTMLElement>('[data-fatal-runtime-action="copy"]')!;

        pressTab(dialog);
        expect(document.activeElement).toBe(reload);

        pressTab(reload, true);
        expect(document.activeElement).toBe(copy);

        pressTab(copy);
        expect(document.activeElement).toBe(reload);
    });

    it('keeps Reload and Copy Details operable without an Escape dismissal path', async () => {
        const mounted = mountDialog();
        await nextTick();
        const reload = mounted.host.querySelector<HTMLButtonElement>('[data-fatal-runtime-action="reload"]')!;
        const copy = mounted.host.querySelector<HTMLButtonElement>('[data-fatal-runtime-action="copy"]')!;

        reload.click();
        copy.click();
        mounted.dialog().dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'Escape',
        }));

        expect(mounted.counters()).toEqual({
            copy: 1,
            reload: 1,
        });
        const dialogAfterEscape = mounted.host.querySelector<HTMLDialogElement>('[role="alertdialog"]');
        expect(dialogAfterEscape).not.toBeNull();
        expect(dialogAfterEscape?.open).toBe(true);
        expect(mounted.workspace().hasAttribute('inert')).toBe(true);
    });

    it('shows one short localized Error ID and copies the full receipt with local details', async () => {
        const failure: FailureReceipt = {
            eventId: '0123456789abcdef0123456789abcdef' as FailureReceipt['eventId'],
            code: 'UNCLASSIFIED_RENDERER_ERROR',
            occurredAt: requireEpochMs(Date.now()),
            severity: 'error',
        };
        const mounted = mountDialog('Renderer stack details', true, failure, 'Идентификатор ошибки');
        await nextTick();

        const dialog = mounted.dialog();
        expect(dialog.textContent).toContain('Идентификатор ошибки');
        expect(dialog.textContent).not.toContain('Error ID');
        expect(dialog.textContent).toContain('01234567');
        expect(dialog.textContent).not.toContain(failure.eventId);

        mounted.host.querySelector<HTMLButtonElement>('[data-fatal-runtime-action="copy"]')!.click();

        expect(mounted.copiedText()).toContain(`Error ID: ${failure.eventId}`);
        expect(mounted.copiedText()).toContain('EVB Viewer stopped');
        expect(mounted.copiedText()).toContain('Renderer stack details');
    });

    it('keeps focus on Reload when no diagnostic details are available', async () => {
        const mounted = mountDialog(null);
        await nextTick();
        const dialog = mounted.dialog();
        const reload = mounted.host.querySelector<HTMLElement>('[data-fatal-runtime-action="reload"]')!;

        pressTab(dialog);
        expect(document.activeElement).toBe(reload);
        pressTab(reload);
        expect(document.activeElement).toBe(reload);
        pressTab(reload, true);
        expect(document.activeElement).toBe(reload);
        expect(mounted.host.querySelector('[data-fatal-runtime-action="copy"]')).toBeNull();
    });
});
