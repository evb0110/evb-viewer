import {
    chromium,
    type Browser,
    type Download,
} from 'playwright';

export const BROWSER_INTEGRATION_WS_ENDPOINT_ENV = 'EVB_BROWSER_INTEGRATION_WS_ENDPOINT';

export async function connectOrLaunchChromium(): Promise<Browser> {
    const wsEndpoint = process.env[BROWSER_INTEGRATION_WS_ENDPOINT_ENV]?.trim();
    if (wsEndpoint) {
        return chromium.connect(wsEndpoint);
    }
    return chromium.launch({ headless: true });
}

export async function closeChromiumBrowser(browser: Browser | undefined): Promise<void> {
    if (!browser) return;
    try {
        await Promise.allSettled(browser.contexts().map(context => context.close()));
    } finally {
        await browser.close();
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
