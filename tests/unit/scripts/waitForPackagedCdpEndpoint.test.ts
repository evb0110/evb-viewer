import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {Page} from 'puppeteer-core';
import {
    waitForPackagedCdpEndpoint,
    waitForPackagedRendererPage,
} from '@scripts/release/waitForPackagedCdpEndpoint';

function createPage(url: string, options: {
    closed?: boolean;
    ready?: boolean
} = {}): Page {
    const page: Pick<Page, 'isClosed' | 'url'> & {waitForFunction(): Promise<void>} = {
        isClosed: () => options.closed === true,
        url: () => url,
        // The page answers readiness as its document would.
        waitForFunction: () => (options.ready === false
            ? Promise.reject(new Error(`${url} never became ready`))
            : Promise.resolve()),
    };
    return page as never;
}

describe('waitForPackagedCdpEndpoint', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns the debugger endpoint from a ready packaged application', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/test'}),
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(waitForPackagedCdpEndpoint(9_222, 1_000, 'Packaged test app'))
            .resolves.toBe('ws://127.0.0.1/devtools/browser/test');
        expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:9222/json/version');
    });

    it('reports the owning application when the deadline is already exhausted', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await expect(waitForPackagedCdpEndpoint(9_223, 0, 'Packaged test app'))
            .rejects.toThrow('Packaged test app did not expose CDP on port 9223');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('waitForPackagedRendererPage', () => {
    it('returns the open app page and never a blank or closed one', async () => {
        const app = createPage('evb-viewer://app/electron');
        const pages = [
            createPage('about:blank'),
            createPage('evb-viewer://app/electron', {closed: true}),
            app,
        ];

        await expect(waitForPackagedRendererPage({pages: async () => pages}, 1_000, 'Packaged test app')).resolves.toBe(app);
    });

    it('refuses a startup that shows only a blank or closed page', async () => {
        const pages = [
            createPage('about:blank'),
            createPage('evb-viewer://app/electron', {closed: true}),
        ];

        await expect(waitForPackagedRendererPage({pages: async () => pages}, 50, 'Packaged test app', 10))
            .rejects.toThrow('Packaged test app exposed no renderer page within 50ms');
    });

    it('does not return an app page whose renderer never becomes ready', async () => {
        const pages = [createPage('evb-viewer://app/electron', {ready: false})];

        await expect(waitForPackagedRendererPage({pages: async () => pages}, 1_000, 'Packaged test app'))
            .rejects.toThrow('never became ready');
    });
});
