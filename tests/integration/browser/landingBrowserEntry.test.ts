import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {
    afterAll, beforeAll, expect, it, vi,
} from 'vitest';
import {chromium} from 'playwright';
import type {Browser} from 'playwright';
import {buildNuxtDevServerEnv} from '@scripts/electron-run/electronRunLaunchConfig';
import {
    findFreePort, killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';

let server: ReturnType<typeof spawn>;
let browser: Browser;
let origin: string;
let output = '';

beforeAll(async () => {
    const port = await findFreePort();
    origin = `http://127.0.0.1:${port}`;
    const env = buildNuxtDevServerEnv(process.env, port, `landing-entry-${process.pid}`);
    const capture = (chunk: Buffer) => {
        output = `${output}${chunk.toString()}`.slice(-10_000);
    };
    server = spawn(process.execPath, [
        resolve('node_modules/nuxt/bin/nuxt.mjs'),
        'build',
    ], {
        cwd: resolve('landing'),
        env: {
            ...env,
            NITRO_PRESET: 'node-server',
        },
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });
    server.stdout?.on('data', capture);
    server.stderr?.on('data', capture);
    const [buildStatus] = await once(server, 'close');
    expect(buildStatus, output).toBe(0);
    server = spawn(process.execPath, [resolve('landing/.output/server/index.mjs')], {
        cwd: resolve('landing'),
        env: {
            ...env,
            NITRO_HOST: '127.0.0.1',
            NITRO_PORT: String(port),
        },
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });
    server.stdout?.on('data', capture);
    server.stderr?.on('data', capture);
    await once(server, 'spawn');
    await vi.waitFor(async () => {
        if (server.exitCode !== null) throw new Error(output);
        const status = await fetch(`${origin}/`).then(response => response.status).catch(() => 0);
        expect(status, output).toBe(200);
    }, {timeout: 90_000});
    browser = await chromium.launch({headless: true});
}, 180_000);

afterAll(async () => {
    try {
        await browser?.close();
    } finally {
        if (server?.pid) await killProcessTree(server.pid);
    }
});

// Exercise the real landing pages and trusted clicks. Only the destination is
// stubbed: this regression protects host selection, not viewer functionality.
it('keeps browser entry links on the matching primary or Vercel host', async () => {
    const context = await browser.newContext();
    try {
        for (const hostname of [
            'evb-viewer.vercel.app',
            'evb-viewer.com',
        ]) {
            await context.route(`https://${hostname}/**`, async (route) => {
                const url = new URL(route.request().url());
                const response = await route.fetch({
                    url: `${origin}${url.pathname}${url.search}`,
                    headers: {
                        ...route.request().headers(),
                        host: hostname,
                    },
                    maxRedirects: 0,
                });
                await route.fulfill({response});
            });
        }
        for (const hostname of [
            'web.evb-viewer.com',
            'evb-viewer-web.vercel.app',
        ]) {
            await context.route(`https://${hostname}/**`, route => route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><title>Navigation destination</title>',
            }));
        }
        await context.route('**/api/releases/latest', route => route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: '{"statusMessage":"Release lookup is outside this navigation test"}',
        }));
        const page = await context.newPage();
        for (const hostname of [
            'evb-viewer.vercel.app',
            'evb-viewer.com',
        ]) {
            const expectedHost = hostname.endsWith('.vercel.app')
                ? 'evb-viewer-web.vercel.app'
                : 'web.evb-viewer.com';
            for (const locale of [
                '',
                '/ru',
            ]) {
                for (const path of [
                    '',
                    '/features',
                    '/docs',
                ]) {
                    const response = await page.goto(`https://${hostname}${locale}${path}`);
                    expect(response?.status(), await page.locator('body').innerText()).toBe(200);
                    const label = locale ? 'Использовать в браузере' : 'Use in browser';
                    const link = page.getByRole('link', {
                        name: label,
                        exact: true,
                    });
                    await expect.poll(() => link.isVisible(), {message: await page.locator('body').innerText()}).toBe(true);
                    const popupReady = page.waitForEvent('popup');
                    await link.click();
                    const popup = await popupReady;
                    try {
                        await popup.waitForLoadState();
                        expect(new URL(popup.url()).hostname, `${hostname}${locale}${path}`).toBe(expectedHost);
                    } finally {
                        await popup.close();
                    }
                }
            }
        }
    } finally {
        await context.unrouteAll({behavior: 'wait'});
        await context.close();
    }
}, 120_000);
