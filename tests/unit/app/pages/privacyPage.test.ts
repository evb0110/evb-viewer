// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    nextTick,
    ref,
} from 'vue';
import PrivacyPage from '@app/pages/privacy.vue';

const locale = ref('en');

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({locale}),
}));

const head = vi.fn();

/**
 * The published policy has to describe what the app actually does. Rendering it
 * here keeps the copy honest: a section that names a control the app no longer
 * ships, or a locale that silently falls back to English, fails this test
 * instead of shipping to web.evb-viewer.com.
 */
const activeUnmounts = new Set<() => void>();

function mountPage() {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(PrivacyPage);
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);
    return host;
}

beforeEach(() => {
    vi.stubGlobal('useHead', head);
});

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
    locale.value = 'en';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe('privacy page', () => {
    it('describes assistant providers without offering a response report control', () => {
        const host = mountPage();

        const assistantSection = [...host.querySelectorAll('section')]
            .find(section => section.querySelector('h2')?.textContent === 'Optional assistant services');
        expect(assistantSection?.textContent).toContain('sent to that provider under your account');
        expect(assistantSection?.querySelectorAll('p')).toHaveLength(1);
        expect(host.textContent).not.toContain('report control');
        expect(host.textContent).toContain('sent only with your consent');
        expect(host.textContent).toContain('never for analytics, advertising, profiling, AI, or training');
        expect(host.textContent).toContain('Server-side Nitro reporting is disabled');
        expect(host.querySelector('h1')?.textContent).toBe('Privacy Policy');
        expect(head).toHaveBeenCalledOnce();
    });

    it('renders the Russian policy when the locale is Russian', async () => {
        locale.value = 'ru';
        const host = mountPage();
        await nextTick();

        expect(host.querySelector('h1')?.textContent).toBe('Политика конфиденциальности');
        expect(host.textContent).not.toContain('не копирует и не отправляет ответ');
    });
});
