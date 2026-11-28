import {mkdtempSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
    onHeadersReceived: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    config: {
        isDev: false,
        renderer: {
            staticRoot: '/missing/nuxt-output/public',
            trustedOrigin: 'evb-viewer://app',
            trustedUrl: 'evb-viewer://app/electron',
        },
    },
}));

vi.mock('electron', () => ({
    session: {
        defaultSession: {
            setPermissionCheckHandler: mocks.setPermissionCheckHandler,
            setPermissionRequestHandler: mocks.setPermissionRequestHandler,
            webRequest: {onHeadersReceived: mocks.onHeadersReceived},
        },
    },
}));
vi.mock('@electron/config', () => ({config: mocks.config}));

const {
    buildContentSecurityPolicy,
    collectProductionInlineScriptCspHashes,
    collectProductionInlineScriptCspHashesAsync,
    createInlineScriptCspHash,
    extractInlineScriptCspHashes,
    resolveProductionContentSecurityPolicy,
    setupContentSecurityPolicy,
} = await import('@electron/security/csp');

// setupContentSecurityPolicy registers its handlers once per process, and
// Vitest clears mock calls between tests, so capture them here.
setupContentSecurityPolicy();
const checkHandler = mocks.setPermissionCheckHandler.mock.calls[0]?.[0];
const requestHandler = mocks.setPermissionRequestHandler.mock.calls[0]?.[0];
const prodHeadersRegistrationCount = mocks.onHeadersReceived.mock.calls.length;

it('does not install session-wide onHeadersReceived in production mode', () => {
    expect(prodHeadersRegistrationCount).toBe(0);
});

it('retries the policy installation after header registration fails in development mode', async () => {
    vi.resetModules();
    mocks.config.isDev = true;
    try {
        const {setupContentSecurityPolicy: installPolicy} = await import('@electron/security/csp');
        mocks.onHeadersReceived.mockImplementationOnce(() => {
            throw new Error('Header registration failed');
        });
        expect(() => installPolicy()).toThrow('Header registration failed');
        installPolicy();
        expect(mocks.onHeadersReceived).toHaveBeenCalledTimes(2);
    } finally {
        mocks.config.isDev = false;
    }
});

function parseCsp(csp: string) {
    return Object.fromEntries(
        csp.split('; ').map((directive) => {
            const [name, ...tokens] = directive.split(' ');
            return [name, tokens];
        }),
    );
}

describe('buildContentSecurityPolicy', () => {
    it('allows inline scripts in development policy for Nuxt bootstrap/HMR', () => {
        const directives = parseCsp(buildContentSecurityPolicy(true));

        expect(directives).toEqual({
            'base-uri': ["'self'"],
            'connect-src': ["'self'", 'ws:', 'blob:'],
            'default-src': ["'self'"],
            'font-src': ["'self'", 'data:'],
            'form-action': ["'self'"],
            'frame-ancestors': ["'none'"],
            'img-src': ["'self'", 'data:', 'blob:'],
            'object-src': ["'none'"],
            'script-src': ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'"],
            'script-src-attr': ["'none'"],
            'style-src': ["'self'", "'unsafe-inline'"],
            'worker-src': ["'self'", 'blob:'],
        });
    });

    it('allows only hashed inline script elements and WASM eval in production', () => {
        const bootstrapHash = createInlineScriptCspHash('window.__NUXT__={};');
        const directives = parseCsp(buildContentSecurityPolicy(false, {inlineScriptHashes: [bootstrapHash, 'not-a-csp-hash']}));

        // 'wasm-unsafe-eval' is intentionally enabled in production: pdf.js's
        // renderer WebWorker compiles bundled WASM (jbig2/openjpeg/qcms/quickjs)
        // for JBIG2/JPEG2000 images, ICC profiles, and embedded JS actions.
        expect(directives).toEqual({
            'base-uri': ["'self'"],
            'connect-src': ["'self'", 'blob:'],
            'default-src': ["'self'"],
            'font-src': ["'self'", 'data:'],
            'form-action': ["'self'"],
            'frame-ancestors': ["'none'"],
            'img-src': ["'self'", 'data:', 'blob:'],
            'object-src': ["'none'"],
            'script-src': ["'self'", bootstrapHash, "'wasm-unsafe-eval'"],
            'script-src-attr': ["'none'"],
            'style-src': ["'self'", "'unsafe-inline'"],
            'worker-src': ["'self'", 'blob:'],
        });
    });

    it('extracts deterministic CSP hashes from inline script elements only', () => {
        const html = [
            '<script src="/_nuxt/app.js"></script>',
            '<script>window.__NUXT__={};</script>',
            '<script type="application/json">{"payload":true}</script>',
            '<script>window.__NUXT__={};</script>',
        ].join('');
        const expectedPayloadHash = `'sha256-${createHash('sha256').update('{"payload":true}', 'utf8').digest('base64')}'`;

        expect(extractInlineScriptCspHashes(html)).toEqual([expectedPayloadHash, createInlineScriptCspHash('window.__NUXT__={};')].sort());
    });

    it('collects production hashes from the Electron Nuxt entrypoint artifact synchronously and asynchronously', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-csp-test-'));
        try {
            mkdirSync(join(tempRoot, 'electron'), {recursive: true});
            writeFileSync(join(tempRoot, 'electron', 'index.html'), '<script>globalThis.__NUXT__={serverRendered:false};</script>');

            const staticBootstrapHash = createInlineScriptCspHash('globalThis.__NUXT__={serverRendered:false};');

            expect(collectProductionInlineScriptCspHashes(tempRoot)).toEqual([staticBootstrapHash]);
            await expect(collectProductionInlineScriptCspHashesAsync(tempRoot)).resolves.toEqual([staticBootstrapHash]);
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('does not cache an empty hash lookup when the entrypoint appears after prewarm', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-csp-retry-'));
        try {
            const firstPolicy = await resolveProductionContentSecurityPolicy(tempRoot);
            const expectedHash = createInlineScriptCspHash('globalThis.__NUXT__={retry:true};');
            expect(firstPolicy).not.toContain(expectedHash);

            mkdirSync(join(tempRoot, 'electron'), {recursive: true});
            writeFileSync(join(tempRoot, 'electron', 'index.html'), '<script>globalThis.__NUXT__={retry:true};</script>');

            const secondPolicy = await resolveProductionContentSecurityPolicy(tempRoot);
            expect(secondPolicy).toContain(expectedHash);
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('allows clipboard permissions only for the trusted main renderer', () => {
        expect(checkHandler).toBeTypeOf('function');
        expect(requestHandler).toBeTypeOf('function');

        expect(
            checkHandler?.({getURL: () => 'evb-viewer://app/electron'}, 'clipboard-read', 'evb-viewer://app', {
                isMainFrame: true,
                requestingUrl: 'evb-viewer://app/electron',
            }),
        ).toBe(true);
        expect(
            checkHandler?.({getURL: () => 'evb-viewer://app/electron'}, 'clipboard-sanitized-write', 'evb-viewer://app', {
                isMainFrame: false,
                requestingUrl: 'evb-viewer://app/electron',
            }),
        ).toBe(false);
        expect(
            checkHandler?.({getURL: () => 'https://untrusted.example/'}, 'clipboard-read', 'https://untrusted.example', {
                isMainFrame: true,
                requestingUrl: 'https://untrusted.example/',
            }),
        ).toBe(false);

        const trustedClipboardCallback = vi.fn();
        requestHandler?.({getURL: () => 'evb-viewer://app/electron'}, 'clipboard-sanitized-write', trustedClipboardCallback, {
            isMainFrame: true,
            requestingUrl: 'evb-viewer://app/electron',
        });
        expect(trustedClipboardCallback).toHaveBeenCalledWith(true);

        const trustedClipboardReadCallback = vi.fn();
        requestHandler?.({getURL: () => 'evb-viewer://app/electron'}, 'clipboard-read', trustedClipboardReadCallback, {
            isMainFrame: true,
            requestingUrl: 'evb-viewer://app/electron',
        });
        expect(trustedClipboardReadCallback).toHaveBeenCalledWith(true);

        const deniedMediaCallback = vi.fn();
        requestHandler?.({getURL: () => 'evb-viewer://app/electron'}, 'media', deniedMediaCallback, {
            isMainFrame: true,
            requestingUrl: 'evb-viewer://app/electron',
        });
        expect(deniedMediaCallback).toHaveBeenCalledWith(false);
    });

    it('authorizes the Nuxt UI SPA color cleanup without allowing arbitrary inline scripts', async () => {
        const policy = await resolveProductionContentSecurityPolicy();
        const directives = parseCsp(policy);
        const cleanupHash = createInlineScriptCspHash("document.head.removeChild(document.querySelector('[data-nuxt-ui-colors]'))");

        expect(directives['script-src']).toContain(cleanupHash);
        expect(directives['script-src']).not.toContain("'unsafe-inline'");
    });

    it('leaves PDF and extension responses under their own security policies in development mode', async () => {
        vi.resetModules();
        mocks.config.isDev = true;
        try {
            const {setupContentSecurityPolicy: installDevPolicy} = await import('@electron/security/csp');
            installDevPolicy();
            const devHeadersListener = mocks.onHeadersReceived.mock.calls.at(-1)?.[0];
            expect(devHeadersListener).toBeTypeOf('function');

            const trustedCallback = vi.fn();
            devHeadersListener?.({url: 'evb-viewer://app/electron'}, trustedCallback);
            expect(trustedCallback.mock.calls[0]?.[0]?.responseHeaders?.['Content-Security-Policy']?.[0]).toContain("'unsafe-inline'");

            const pdfHeaders = {'Content-Type': ['application/pdf']};
            const pdfCallback = vi.fn();
            devHeadersListener?.(
                {
                    url: 'file:///tmp/document.pdf',
                    responseHeaders: pdfHeaders,
                },
                pdfCallback,
            );
            expect(pdfCallback).toHaveBeenCalledWith({responseHeaders: pdfHeaders});

            const noHeadersCallback = vi.fn();
            devHeadersListener?.({url: 'file:///tmp/document-without-headers.pdf'}, noHeadersCallback);
            expect(noHeadersCallback).toHaveBeenCalledWith({});

            const extensionHeaders = {'Content-Security-Policy': ["script-src 'self'; object-src *"]};
            const extensionCallback = vi.fn();
            devHeadersListener?.(
                {
                    url: 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html',
                    responseHeaders: extensionHeaders,
                },
                extensionCallback,
            );
            expect(extensionCallback).toHaveBeenCalledWith({responseHeaders: extensionHeaders});
        } finally {
            mocks.config.isDev = false;
        }
    });
});
