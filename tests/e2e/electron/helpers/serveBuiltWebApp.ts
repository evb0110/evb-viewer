import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
    extname,
    join,
    normalize,
    sep,
} from 'node:path';
import { projectRoot } from '@scripts/electron-run/projectRoot';

const WEB_ROOT = join(projectRoot, 'nuxt-output', 'public');
const CONTENT_TYPES: Record<string, string> = {
    '.css': 'text/css',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.mjs': 'text/javascript',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.woff2': 'font/woff2',
};

async function resolveFile(pathname: string) {
    const candidate = normalize(join(WEB_ROOT, decodeURIComponent(pathname)));
    if (candidate !== WEB_ROOT && !candidate.startsWith(`${WEB_ROOT}${sep}`)) {
        return null;
    }
    const stats = await stat(candidate).catch(() => null);
    if (stats?.isDirectory()) {
        return join(candidate, 'index.html');
    }
    return stats?.isFile() ? candidate : null;
}

/**
 * Serves the built web renderer, the same nuxt-output the Electron E2E app
 * loads, so a test can compare the browser build with the desktop one.
 */
export async function serveBuiltWebApp() {
    const server = createServer((request, response) => {
        void resolveFile(new URL(request.url ?? '/', 'http://localhost').pathname).then((file) => {
            if (!file) {
                response.writeHead(404).end();
                return;
            }
            response.writeHead(200, {'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream'});
            createReadStream(file).pipe(response);
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const {port} = server.address() as AddressInfo;
    return {
        origin: `http://127.0.0.1:${String(port)}`,
        close: () => new Promise<void>(resolve => server.close(() => resolve())),
    };
}
