import { createHash } from 'node:crypto';
import {
    existsSync,
    readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { session } from 'electron';
import { config } from '@electron/config';
import { isTrustedRendererUrl } from '@electron/security/isTrustedRendererUrl';
import { createLogger } from '@electron/utils/createLogger';

let isCspConfigured = false;

const logger = createLogger('content-security-policy');
const PRODUCTION_CSP_HTML_ENTRYPOINTS = ['electron/index.html'];
const CSP_SHA256_SOURCE_PATTERN = /^'sha256-[A-Za-z0-9+/]+={0,2}'$/u;
const NUXT_UI_SPA_COLOR_CLEANUP_SCRIPT = 'document.head.removeChild(document.querySelector(\'[data-nuxt-ui-colors]\'))';
const CLIPBOARD_PERMISSIONS = new Set([
    'clipboard-read',
    'clipboard-sanitized-write',
]);

interface IBuildContentSecurityPolicyOptions { inlineScriptHashes?: readonly string[]; }

function normalizeCspHashSources(values: readonly string[] = []) {
    return [...new Set(values.map(value => value.trim()).filter(value => CSP_SHA256_SOURCE_PATTERN.test(value)))];
}

export function createInlineScriptCspHash(scriptContent: string) {
    return `'sha256-${createHash('sha256').update(scriptContent, 'utf8').digest('base64')}'`;
}

export function extractInlineScriptCspHashes(html: string) {
    const hashes = new Set<string>();
    const scriptTagPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/giu;
    let match: RegExpExecArray | null;
    while ((match = scriptTagPattern.exec(html)) !== null) {
        const attributes = match[1] ?? '';
        if (/(?:^|\s)src\s*=/iu.test(attributes)) {
            continue;
        }
        hashes.add(createInlineScriptCspHash(match[2] ?? ''));
    }

    return [...hashes].sort();
}

export function collectProductionInlineScriptCspHashes(staticRoot: string | undefined) {
    if (!staticRoot) {
        return [];
    }

    const hashes = new Set<string>();
    for (const entrypoint of PRODUCTION_CSP_HTML_ENTRYPOINTS) {
        const htmlPath = join(staticRoot, entrypoint);
        if (!existsSync(htmlPath)) {
            continue;
        }
        const html = readFileSync(htmlPath, 'utf8');
        for (const hash of extractInlineScriptCspHashes(html)) {
            hashes.add(hash);
        }
    }

    return [...hashes].sort();
}

export function buildContentSecurityPolicy(
    isDev: boolean,
    options: IBuildContentSecurityPolicyOptions = {},
) {
    const connectSrc = isDev
        ? 'connect-src \'self\' ws: blob:'
        : 'connect-src \'self\' blob:';

    const scriptSrcSources = isDev
        ? [
            '\'self\'',
            '\'unsafe-inline\'',
            '\'wasm-unsafe-eval\'',
        ]
        : [
            '\'self\'',
            ...normalizeCspHashSources(options.inlineScriptHashes),
            '\'wasm-unsafe-eval\'',
        ];
    // 'wasm-unsafe-eval' is required in production too: pdf.js's renderer WebWorker compiles
    // bundled WASM (jbig2, openjpeg, qcms, quickjs-eval) on demand for PDFs containing
    // JBIG2/JPEG2000-encoded images, ICC color profiles, or JS actions. Without this directive
    // those PDFs silently fail to render those streams.
    const scriptSrc = `script-src ${scriptSrcSources.join(' ')}`;
    // Vue/PDF.js render geometry through inline style attributes and Electron preload injects a small style tag.
    const styleSrc = 'style-src \'self\' \'unsafe-inline\'';

    return [
        'default-src \'self\'',
        scriptSrc,
        'script-src-attr \'none\'',
        styleSrc,
        'img-src \'self\' data: blob:',
        'font-src \'self\' data:',
        connectSrc,
        'worker-src \'self\' blob:',
        'object-src \'none\'',
        'base-uri \'self\'',
        'frame-ancestors \'none\'',
        'form-action \'self\'',
    ].join('; ');
}

function isTrustedClipboardRequest(
    permission: string,
    requestingUrl: string | undefined,
    isMainFrame: boolean,
) {
    // Clipboard image paste is an explicit app command. Keep its read grant
    // inside the trusted top-level renderer; embedded and external pages get neither permission.
    return CLIPBOARD_PERMISSIONS.has(permission)
        && isMainFrame
        && typeof requestingUrl === 'string'
        && isTrustedRendererUrl(requestingUrl, config.renderer.trustedUrl);
}

export function setupContentSecurityPolicy() {
    if (isCspConfigured) {
        return;
    }
    isCspConfigured = true;

    const inlineScriptHashes = config.isDev
        ? []
        : [
            ...collectProductionInlineScriptCspHashes(config.renderer.staticRoot),
            createInlineScriptCspHash(NUXT_UI_SPA_COLOR_CLEANUP_SCRIPT),
        ];
    if (!config.isDev && inlineScriptHashes.length === 0) {
        logger.warn('Production CSP found no static inline script hashes; renderer bootstrap will fail if Nuxt output contains inline scripts');
    }
    const csp = buildContentSecurityPolicy(config.isDev, {inlineScriptHashes});
    session.defaultSession.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) => {
        return isTrustedClipboardRequest(
            permission,
            details.requestingUrl ?? webContents?.getURL(),
            details.isMainFrame,
        );
    });
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
        callback(isTrustedClipboardRequest(
            permission,
            details.requestingUrl,
            details.isMainFrame,
        ));
    });

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        // The default session also carries Chromium's built-in PDF viewer. Its
        // chrome-extension:// subframe must receive its own policy; replacing
        // that response with the app policy blocks the viewer's frame and
        // leaves Electron's -pdf-ready-to-print event unissued.
        if (!isTrustedRendererUrl(details.url, config.renderer.trustedOrigin)) {
            callback(details.responseHeaders ? {responseHeaders: details.responseHeaders} : {});
            return;
        }
        callback({responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [csp],
        }});
    });
}
