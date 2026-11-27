import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium, type Browser, type BrowserContext, type Download, type Page, type Video} from 'playwright';

export const BROWSER_INTEGRATION_WS_ENDPOINT_ENV = 'EVB_BROWSER_INTEGRATION_WS_ENDPOINT';

const wrappedVideoContexts = new WeakSet<BrowserContext>();

function combineErrors(errors: unknown[], message: string): unknown {
    return errors.length === 1 ? errors[0] : new AggregateError(errors, message);
}

// Playwright clears `recordVideo.dir` for server-backed `chromium.connect()`
// contexts and deletes server temp recordings on disconnect. Export recorded
// videos into the requested directory as each context closes and surface any
// export failure instead of dropping video evidence silently.
function attachRemoteVideoExport(context: BrowserContext, videoDir: string): void {
    if (wrappedVideoContexts.has(context)) {
        return;
    }
    wrappedVideoContexts.add(context);
    const videos = new Set<Video>();
    const trackPage = (page: Page) => {
        const video = page.video();
        if (video) {
            videos.add(video);
        }
    };
    for (const page of context.pages()) {
        trackPage(page);
    }
    context.on('page', trackPage);

    let exported = false;
    const originalClose = context.close.bind(context);
    context.close = async (options) => {
        for (const page of context.pages()) {
            trackPage(page);
        }
        const failures: unknown[] = [];
        try {
            await originalClose(options);
        } catch (closeError) {
            failures.push(closeError);
        }
        if (!exported) {
            exported = true;
            if (videos.size > 0) {
                try {
                    await mkdir(videoDir, {recursive: true});
                    const results = await Promise.allSettled(
                        [...videos].map((video) => video.saveAs(join(videoDir, `${randomUUID()}.webm`))),
                    );
                    for (const result of results) {
                        if (result.status === 'rejected') {
                            failures.push(result.reason);
                        }
                    }
                } catch (exportError) {
                    failures.push(exportError);
                }
            }
        }
        if (failures.length > 0) {
            throw combineErrors(failures, `Failed closing context or exporting videos to ${videoDir}`);
        }
    };
}

function wrapConnectedBrowserForVideoExport(browser: Browser): Browser {
    const originalNewContext = browser.newContext.bind(browser);
    browser.newContext = async (options) => {
        const context = await originalNewContext(options);
        const videoDir = options?.recordVideo?.dir;
        if (videoDir) {
            attachRemoteVideoExport(context, videoDir);
        }
        return context;
    };
    browser.newPage = async (options) => {
        const context = await browser.newContext(options);
        try {
            const page = await context.newPage();
            const originalPageClose = page.close.bind(page);
            page.close = async (closeOptions) => {
                const failures: unknown[] = [];
                try {
                    await originalPageClose(closeOptions);
                } catch (closeError) {
                    failures.push(closeError);
                }
                try {
                    await context.close();
                } catch (contextError) {
                    failures.push(contextError);
                }
                if (failures.length > 0) {
                    throw combineErrors(failures, 'Failed closing page or its owning context');
                }
            };
            return page;
        } catch (error) {
            await context.close().catch(() => {});
            throw error;
        }
    };
    return browser;
}

export async function connectOrLaunchChromium(): Promise<Browser> {
    const wsEndpoint = process.env[BROWSER_INTEGRATION_WS_ENDPOINT_ENV]?.trim();
    if (wsEndpoint) {
        return wrapConnectedBrowserForVideoExport(await chromium.connect(wsEndpoint));
    }
    return chromium.launch({headless: true});
}

export async function closeChromiumBrowser(browser: Browser | undefined): Promise<void> {
    if (!browser) {
        return;
    }
    const failures: unknown[] = [];
    try {
        const results = await Promise.allSettled(browser.contexts().map((context) => context.close()));
        for (const result of results) {
            if (result.status === 'rejected') {
                failures.push(result.reason);
            }
        }
    } finally {
        try {
            await browser.close();
        } catch (closeError) {
            failures.push(closeError);
        }
    }
    if (failures.length > 0) {
        throw combineErrors(failures, 'Failed closing Chromium browser contexts or connection');
    }
}

// `download.path()` throws on a `chromium.connect()` client; streaming works
// identically over both remote and local Playwright browsers.
export async function readDownloadBytes(download: Download): Promise<Buffer> {
    const failure = await download.failure();
    if (failure) {
        throw new Error(`Download failed: ${failure}`);
    }
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}
