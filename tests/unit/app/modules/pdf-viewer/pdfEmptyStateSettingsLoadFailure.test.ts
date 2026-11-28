// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {TStartSection} from '@app/types/startSection';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

async function mountEmptyState(initialSection: TStartSection) {
    const vue = await import('vue');
    const {default: PdfEmptyState} = await import('@app/modules/pdf-viewer/components/PdfEmptyState.vue');
    const host = document.createElement('div');
    document.body.append(host);
    const parentErrors: unknown[] = [];
    const activeSection = vue.ref<TStartSection>(initialSection);

    const app = vue.createApp(
        vue.defineComponent({
            setup() {
                vue.onErrorCaptured((error) => {
                    parentErrors.push(error);
                    return false;
                });
                return () =>
                    vue.h(PdfEmptyState, {
                        recentFiles: [],
                        recentFilesResolved: true,
                        startSection: activeSection.value,
                        'onUpdate:startSection': (section: TStartSection) => {
                            activeSection.value = section;
                        },
                    });
            },
        }),
    );
    app.component('UIcon', vue.defineComponent({setup: () => () => vue.h('span')}));
    app.component(
        'UButton',
        vue.defineComponent({
            props: {label: String},
            emits: ['click'],
            setup:
                (props, {emit}) =>
                () =>
                    vue.h('button', {onClick: () => emit('click')}, props.label),
        }),
    );
    app.component('UInput', vue.defineComponent({setup: () => () => vue.h('input')}));
    app.component(
        'AppTooltip',
        vue.defineComponent({
            setup:
                (_, {slots}) =>
                () =>
                    vue.h('span', slots.default?.()),
        }),
    );
    app.component('UModal', vue.defineComponent({setup: () => () => null}));
    app.mount(host);
    await vue.nextTick();
    return {
        activeSection,
        host,
        parentErrors,
        unmount: () => app.unmount(),
        vue,
    };
}

describe('PdfEmptyState async Settings loading failure', () => {
    beforeEach(() => {
        vi.resetModules();
        for (const link of document.head.querySelectorAll('link[rel="stylesheet"]')) {
            link.remove();
        }
    });

    afterEach(() => {
        vi.doUnmock('@app/components/settings/SettingsPage.vue');
        document.body.innerHTML = '';
        for (const link of document.head.querySelectorAll('link[rel="stylesheet"]')) {
            link.remove();
        }
    });

    it('contains a failed Settings JS chunk inside the pane, lets the user return to Recent, and reloads the app for a fresh load', async () => {
        vi.doMock('@app/components/settings/SettingsPage.vue', () => {
            throw new Error('Failed to fetch dynamically imported module: SettingsPage.vue');
        });
        const reloadSpy = vi.fn();
        const originalLocation = window.location;
        Object.defineProperty(window, 'location', {
            configurable: true,
            value: {
                ...originalLocation,
                reload: reloadSpy,
            },
        });

        const {activeSection, host, parentErrors, unmount, vue} = await mountEmptyState('recent');
        try {
            // Open Settings while offline -> error stays inside PdfEmptyState, never propagates to parent error boundary.
            activeSection.value = 'settings';
            await vi.waitFor(() => {
                expect(host.querySelector('[data-testid="settings-load-error"]')).not.toBeNull();
            });

            expect(parentErrors).toEqual([]);
            const errorBox = host.querySelector<HTMLElement>('[data-testid="settings-load-error"]');
            expect(errorBox?.textContent).toContain('errors.settings.load');

            // Clicking Recent returns to the Recent view.
            const buttons = [...(errorBox?.querySelectorAll('button') ?? [])];
            const recentButton = buttons.find((button) => button.textContent === 'emptyState.recentFiles');
            expect(recentButton).toBeDefined();
            recentButton?.click();
            await vue.nextTick();
            expect(activeSection.value).toBe('recent');

            // Re-open Settings: failed JS chunk offers a full app reload to clear the browser's failed module-map entry.
            activeSection.value = 'settings';
            await vue.nextTick();
            const reloadButton = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="settings-load-error"] button')].find(
                (button) => button.textContent === 'errors.runtime.reload',
            );
            expect(reloadButton).toBeDefined();
            reloadButton?.click();
            expect(reloadSpy).toHaveBeenCalledOnce();
            expect(parentErrors).toEqual([]);
        } finally {
            Object.defineProperty(window, 'location', {
                configurable: true,
                value: originalLocation,
            });
            unmount();
        }
    });

    it('keeps Settings in error state when its stylesheet fails even if JS resolves, and reloads the stylesheet on Retry', async () => {
        const cssHref = 'http://127.0.0.1:4173/_nuxt/SettingsPage.test.css';
        vi.doMock('@app/components/settings/SettingsPage.vue', async () => {
            const brokenLink = document.createElement('link');
            brokenLink.rel = 'stylesheet';
            brokenLink.href = cssHref;
            document.head.appendChild(brokenLink);
            brokenLink.dispatchEvent(new Event('error'));

            const vue = await import('vue');
            return {
                default: vue.defineComponent({
                    name: 'MockSettingsPage',
                    setup: () => () => vue.h('section', {'data-testid': 'settings-page-loaded'}, 'Settings loaded'),
                }),
            };
        });

        const reloadedLinks: HTMLLinkElement[] = [];
        const originalAppendChild = document.head.appendChild.bind(document.head);
        const appendSpy = vi.spyOn(document.head, 'appendChild').mockImplementation((node) => {
            if (node instanceof HTMLLinkElement && node.rel === 'stylesheet' && node.href === cssHref) {
                reloadedLinks.push(node);
                if (reloadedLinks.length > 1) {
                    queueMicrotask(() => node.dispatchEvent(new Event('load')));
                    return node;
                }
            }
            return originalAppendChild(node);
        });

        const {host, parentErrors, unmount} = await mountEmptyState('settings');
        try {
            await vi.waitFor(() => {
                expect(host.querySelector('[data-testid="settings-load-error"]')).not.toBeNull();
            });
            expect(parentErrors).toEqual([]);
            expect(host.querySelector('[data-testid="settings-page-loaded"]')).toBeNull();

            const retryButton = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="settings-load-error"] button')].find(
                (button) => button.textContent === 'common.retry',
            );
            expect(retryButton).toBeDefined();
            retryButton?.click();

            await vi.waitFor(() => {
                expect(host.querySelector('[data-testid="settings-page-loaded"]')).not.toBeNull();
            });
            expect(parentErrors).toEqual([]);
            expect(reloadedLinks).toHaveLength(2);
            expect(document.head.querySelectorAll(`link[rel="stylesheet"][href="${cssHref}"]`)).toHaveLength(0);
        } finally {
            appendSpy.mockRestore();
            unmount();
        }
    });

    it('shares stylesheet failure and reload state when a second Start tab opens Settings after the first tab failed', async () => {
        const cssHref = 'http://127.0.0.1:4173/_nuxt/SettingsPage.second-tab.css';
        vi.doMock('@app/components/settings/SettingsPage.vue', async () => {
            const brokenLink = document.createElement('link');
            brokenLink.rel = 'stylesheet';
            brokenLink.href = cssHref;
            document.head.appendChild(brokenLink);
            brokenLink.dispatchEvent(new Event('error'));

            const vue = await import('vue');
            return {
                default: vue.defineComponent({
                    name: 'MockSettingsPage',
                    setup: () => () => vue.h('section', {'data-testid': 'settings-page-loaded'}, 'Settings loaded'),
                }),
            };
        });

        let allowReloadSuccess = false;
        const reloadedLinks: HTMLLinkElement[] = [];
        const originalAppendChild = document.head.appendChild.bind(document.head);
        const appendSpy = vi.spyOn(document.head, 'appendChild').mockImplementation((node) => {
            if (node instanceof HTMLLinkElement && node.rel === 'stylesheet' && node.href === cssHref) {
                reloadedLinks.push(node);
                if (reloadedLinks.length > 1) {
                    queueMicrotask(() => node.dispatchEvent(new Event(allowReloadSuccess ? 'load' : 'error')));
                    return node;
                }
            }
            return originalAppendChild(node);
        });

        const firstTab = await mountEmptyState('settings');
        const secondTab = await mountEmptyState('recent');
        try {
            // First tab fails CSS preload -> shows recovery panel, switches back to Recent.
            await vi.waitFor(() => {
                expect(firstTab.host.querySelector('[data-testid="settings-load-error"]')).not.toBeNull();
            });
            firstTab.activeSection.value = 'recent';
            await firstTab.vue.nextTick();

            // Second tab opens Settings while stylesheet is still failing -> retries CSS, stays in error state (never unstyled).
            secondTab.activeSection.value = 'settings';
            await vi.waitFor(() => {
                expect(secondTab.host.querySelector('[data-testid="settings-load-error"]')).not.toBeNull();
            });
            expect(secondTab.host.querySelector('[data-testid="settings-page-loaded"]')).toBeNull();
            expect(reloadedLinks).toHaveLength(2);

            // Network recovers -> Retry from the second tab reloads the stylesheet and mounts Settings cleanly.
            allowReloadSuccess = true;
            const retryButton = [...secondTab.host.querySelectorAll<HTMLButtonElement>('[data-testid="settings-load-error"] button')].find(
                (button) => button.textContent === 'common.retry',
            );
            expect(retryButton).toBeDefined();
            retryButton?.click();

            await vi.waitFor(() => {
                expect(secondTab.host.querySelector('[data-testid="settings-page-loaded"]')).not.toBeNull();
            });
            expect(reloadedLinks).toHaveLength(3);
            expect(firstTab.parentErrors).toEqual([]);
            expect(secondTab.parentErrors).toEqual([]);
        } finally {
            appendSpy.mockRestore();
            firstTab.unmount();
            secondTab.unmount();
        }
    });
});
