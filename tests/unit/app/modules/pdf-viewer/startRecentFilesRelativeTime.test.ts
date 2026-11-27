// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {requireDocumentRef} from '@contracts/documentRef';
import {requireEpochMs} from '@contracts/timestamps';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createApp, defineComponent, h, nextTick, ref} from 'vue';
import type {App} from 'vue';
import type {IRecentFile} from '@contracts/shared';
import PdfEmptyState from '@app/modules/pdf-viewer/components/PdfEmptyState.vue';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string, values?: {count?: number}) => (values?.count === undefined ? key : `${key}:${values.count}`)}),
}));

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const OPENED_AT = Date.UTC(2026, 10, 20, 9, 0, 0);
const mountedApps = new Set<App>();

function registerUiStubs(app: App) {
    app.component('UIcon', defineComponent({setup: () => () => h('span')}));
    app.component(
        'UButton',
        defineComponent({
            props: {label: String},
            setup: (props) => () => h('button', props.label),
        }),
    );
    app.component('UInput', defineComponent({setup: () => () => h('input')}));
    app.component('UModal', defineComponent({setup: () => () => null}));
}

function mountStart() {
    const file: IRecentFile = {
        originalPath: requireDocumentRef('browser://documents/grammar.pdf'),
        backend: 'browser',
        fileName: 'grammar.pdf',
        timestamp: requireEpochMs(OPENED_AT),
    };
    const isVisible = ref(true);
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(
        defineComponent({
            setup: () => () =>
                h('div', {style: isVisible.value ? '' : 'display: none'}, [
                    h(PdfEmptyState, {
                        recentFiles: [file],
                        recentFilesResolved: true,
                        isVisible: isVisible.value,
                    }),
                ]),
        }),
    );
    registerUiStubs(app);
    app.mount(host);
    mountedApps.add(app);
    const unmount = () => {
        app.unmount();
        mountedApps.delete(app);
    };
    const opened = () => host.querySelector('.recent-row--data .recent-col--time')?.textContent?.trim();
    return {unmount, isVisible, opened};
}

function setDocumentVisibility(state: DocumentVisibilityState) {
    Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => state});
    document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
    vi.useFakeTimers({toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date']});
    vi.setSystemTime(OPENED_AT);
});

afterEach(() => {
    // A failed assertion leaves its app mounted; tear it down before the clock
    // and visibility are restored.
    for (const app of mountedApps) {
        app.unmount();
    }
    mountedApps.clear();
    vi.useRealTimers();
    setDocumentVisibility('visible');
    document.body.innerHTML = '';
});

describe('Start Recent Files Opened column', () => {
    it('advances from "Just now" through minutes, hours and days while Start stays on screen', async () => {
        const {unmount, opened} = mountStart();
        await nextTick();
        expect(opened()).toBe('relativeTime.justNow');

        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        expect(opened()).toBe('relativeTime.oneMinuteAgo');

        await vi.advanceTimersByTimeAsync(HOUR_MS - MINUTE_MS);
        expect(opened()).toBe('relativeTime.oneHourAgo');

        await vi.advanceTimersByTimeAsync(DAY_MS - HOUR_MS);
        expect(opened()).toBe('relativeTime.yesterday');

        await vi.advanceTimersByTimeAsync(DAY_MS);
        expect(opened()).toBe('relativeTime.daysAgo:2');

        unmount();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops ticking while hidden and shows the current age as soon as Start is shown again', async () => {
        const {unmount, isVisible, opened} = mountStart();
        await nextTick();
        expect(opened()).toBe('relativeTime.justNow');
        expect(vi.getTimerCount()).toBe(1);

        isVisible.value = false;
        await nextTick();
        expect(vi.getTimerCount()).toBe(0);

        vi.setSystemTime(OPENED_AT + 2 * DAY_MS + HOUR_MS);
        isVisible.value = true;
        await nextTick();
        expect(opened()).toBe('relativeTime.daysAgo:2');
        expect(vi.getTimerCount()).toBe(1);

        unmount();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops ticking in a hidden window and catches up when the window is shown or focused', async () => {
        const {unmount, opened} = mountStart();
        await nextTick();

        setDocumentVisibility('hidden');
        await nextTick();
        expect(vi.getTimerCount()).toBe(0);

        vi.setSystemTime(OPENED_AT + 3 * HOUR_MS);
        setDocumentVisibility('visible');
        await nextTick();
        expect(opened()).toBe('relativeTime.hoursAgo:3');

        // A throttled window that missed its ticks catches up when focused.
        vi.setSystemTime(OPENED_AT + DAY_MS + 5 * MINUTE_MS);
        window.dispatchEvent(new Event('focus'));
        await nextTick();
        expect(opened()).toBe('relativeTime.yesterday');

        unmount();
        expect(vi.getTimerCount()).toBe(0);
    });
});
