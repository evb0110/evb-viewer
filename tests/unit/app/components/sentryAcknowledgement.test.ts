// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createApp } from 'vue';
import SentryAcknowledgement from '@landing/app/components/SentryAcknowledgement.vue';

vi.mock('@landing/app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => ({
    'footer.sentryAcknowledgement.message': 'Thank you to Sentry for supporting EVB Viewer through its open-source program.',
    'footer.sentryAcknowledgement.linkLabel': 'Learn about Sentry for Open Source',
}[key] ?? key)})}));

const activeUnmounts = new Set<() => void>();

function mountAcknowledgement() {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(SentryAcknowledgement);
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);

    return {
        host,
        unmount,
    };
}

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
    vi.unstubAllGlobals();
});

describe('SentryAcknowledgement', () => {
    it('renders the local wordmark and secure OSS link without making a request', () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const mounted = mountAcknowledgement();
        const image = mounted.host.querySelector<HTMLImageElement>('.sentry-wordmark');
        const link = mounted.host.querySelector<HTMLAnchorElement>('a');

        expect(mounted.host.textContent).toContain('Thank you to Sentry for supporting EVB Viewer');
        expect(image?.getAttribute('src')).toBe('/sentry-wordmark.svg');
        expect(image?.getAttribute('alt')).toBe('Sentry');
        expect(link?.href).toBe('https://sentry.io/for/open-source/');
        expect(link?.target).toBe('_blank');
        expect(link?.rel).toBe('noopener noreferrer');
        expect(link?.tabIndex).toBe(0);
        link?.focus();
        expect(document.activeElement).toBe(link);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
