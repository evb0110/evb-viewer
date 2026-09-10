// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {readFileSync} from 'node:fs';
import { resolve } from 'node:path';
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
    defineComponent,
    h,
} from 'vue';
import AboutPage from '@app/pages/about.vue';

const mocks = vi.hoisted(() => ({
    desktopRuntime: false,
    openExternal: vi.fn(async () => undefined),
    translations: {
        'app.title': 'EVB Viewer',
        'about.eyebrow': 'Application',
        'about.title': 'About EVB Viewer',
        'about.version': 'Version {version}',
        'about.acknowledgementsHeading': 'Acknowledgements',
        'about.sentryAcknowledgement.message': 'Thank you to Sentry for supporting EVB Viewer through its open-source program.',
        'about.sentryAcknowledgement.linkLabel': 'Learn about Sentry for Open Source',
        'about.sentryAcknowledgement.privacyNotice': 'The Sentry acknowledgement is bundled with EVB Viewer and does not contact Sentry. Error diagnostics are controlled separately in Privacy settings.',
        'about.legalHeading': 'Legal',
        'about.licenseLinkLabel': 'License',
        'about.thirdPartyNoticesLinkLabel': 'Third-party notices',
        'about.privacyPolicyLinkLabel': 'Privacy policy',
        'about.backToViewer': 'Back to viewer',
    } as Record<string, string>,
}));

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (
        key: string,
        params?: Record<string, string>,
    ) => {
        const message = mocks.translations[key] ?? key;
        return Object.entries(params ?? {}).reduce(
            (translated, [
                name,
                value,
            ]) => translated.replace(`{${name}}`, value),
            message,
        );
    }}),
}));
vi.mock('@app/composables/useRuntimeEnvironment', () => ({useRuntimeEnvironment: () => ({isDesktopRuntime: {get value() { return mocks.desktopRuntime; }}})}));
vi.mock('@app/utils/getShellCapability', () => ({getShellCapability: () => ({openExternal: mocks.openExternal})}));

const NuxtLinkStub = defineComponent({
    props: {to: {
        type: String,
        required: true,
    }},
    setup: (props, {slots}) => () => h('a', {href: props.to}, slots.default?.()),
});
const IconStub = defineComponent({setup: () => () => h('span', {'aria-hidden': 'true'})});
const activeUnmounts = new Set<() => void>();
const projectRoot = process.cwd();
const pageSource = readFileSync(resolve(projectRoot, 'app/pages/about.vue'), 'utf8');
const settingsSource = readFileSync(resolve(projectRoot, 'app/components/settings/SettingsContent.vue'), 'utf8');

function mountPage() {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(AboutPage);
    app.component('NuxtLink', NuxtLinkStub);
    app.component('UIcon', IconStub);
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
    vi.stubGlobal('useHead', vi.fn());
});

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
    mocks.desktopRuntime = false;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe('About and Acknowledgements page', () => {
    it('renders the app version, legal links, local wordmark, and acknowledgement without network access', () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const host = mountPage();
        const packageVersion = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')) as {version: string};
        const image = host.querySelector<HTMLImageElement>('.about-sentry-wordmark');
        const externalLinks = [...host.querySelectorAll<HTMLAnchorElement>('a[target="_blank"]')];

        expect(host.querySelector('h1')?.textContent).toBe('About EVB Viewer');
        expect(host.textContent).toContain(`Version ${packageVersion.version}`);
        expect(host.textContent).toContain('Thank you to Sentry for supporting EVB Viewer');
        expect(host.textContent).toContain('does not contact Sentry');
        expect(host.textContent).toContain('Error diagnostics are controlled separately');
        expect(image?.getAttribute('src')).toBe('/sentry-wordmark.svg');
        expect(image?.getAttribute('alt')).toBe('Sentry');
        expect(externalLinks.map(link => link.href)).toEqual([
            'https://sentry.io/for/open-source/',
            'https://github.com/evb0110/evb-viewer/blob/main/LICENSE',
            'https://github.com/evb0110/evb-viewer/blob/main/THIRD_PARTY_NOTICES.md',
        ]);
        for (const link of externalLinks) {
            expect(link.target).toBe('_blank');
            expect(link.rel).toBe('noopener noreferrer');
        }
        expect(fetchMock).not.toHaveBeenCalled();
        expect(mocks.openExternal).not.toHaveBeenCalled();
    });

    it('uses normal secure links in the hosted viewer and the shell capability in Electron', async () => {
        const hosted = mountPage();
        const hostedLink = hosted.querySelector<HTMLAnchorElement>('a[href="https://sentry.io/for/open-source/"]')!;
        const hostedClick = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
        });
        hostedLink.dispatchEvent(hostedClick);

        expect(hostedClick.defaultPrevented).toBe(false);
        expect(mocks.openExternal).not.toHaveBeenCalled();

        mocks.desktopRuntime = true;
        const desktop = mountPage();
        const desktopLink = desktop.querySelector<HTMLAnchorElement>('a[href="https://sentry.io/for/open-source/"]')!;
        const desktopClick = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
        });
        desktopLink.dispatchEvent(desktopClick);
        await Promise.resolve();

        expect(desktopClick.defaultPrevented).toBe(true);
        expect(mocks.openExternal).toHaveBeenCalledWith('https://sentry.io/for/open-source/');
    });

    it('keeps every link keyboard reachable with visible focus and a narrow layout', () => {
        const host = mountPage();
        const links = [...host.querySelectorAll<HTMLAnchorElement>('a')];

        expect(links.map(link => link.textContent?.trim())).toEqual([
            'Learn about Sentry for Open Source',
            'License',
            'Third-party notices',
            'Privacy policy',
            'Back to viewer',
        ]);
        for (const link of links) {
            link.focus();
            expect(document.activeElement).toBe(link);
        }
        expect(pageSource).toContain('.about-page a:focus-visible');
        expect(pageSource).toContain('outline: 2px solid var(--ui-primary);');
        expect(pageSource).toContain('@media (width <= 40rem)');
        expect(pageSource).not.toMatch(/fetch|XMLHttpRequest|sendBeacon|SENTRY_DSN|@sentry\//u);
    });

    it('ships the official local asset and a Settings link to the page', () => {
        expect(readFileSync(resolve(projectRoot, 'public/sentry-wordmark.svg')))
            .toEqual(readFileSync(resolve(projectRoot, 'landing/public/sentry-wordmark.svg')));
        expect(settingsSource).toContain('<NuxtLink class="settings-about-link" to="/about">');
        expect(settingsSource).toContain('t(\'settings.openAbout\')');
        expect(settingsSource).toContain('.settings-about-link:focus-visible');
    });
});
