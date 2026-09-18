import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import {
    realpath, stat,
} from 'node:fs/promises';
import {
    extname, resolve, sep,
} from 'node:path';

/** Loopback-only, directory-confined evidence delivery, including MP4 byte-range seeking. */
export async function serveRecordingReview(directory: string, port = 0) {
    const root = await realpath(directory);
    if (!(await stat(root)).isDirectory()) { throw new Error('Review server requires a directory'); }
    const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.mp4': 'video/mp4',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.json': 'application/json; charset=utf-8',
        '.jsonl': 'text/plain; charset=utf-8',
        '.md': 'text/plain; charset=utf-8',
    };
    const server = createServer((request, response) => {
        void (async () => {
            if (request.method !== 'GET' && request.method !== 'HEAD') {
                response.writeHead(405).end(); return;
            }
            const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
            const candidate = resolve(root, '.' + pathname, pathname.endsWith('/') ? 'index.html' : '');
            const path = await realpath(candidate);
            if (!path.startsWith(root + sep) || !types[extname(path)]) { response.writeHead(404).end(); return; }
            const info = await stat(path);
            if (!info.isFile()) { response.writeHead(404).end(); return; }
            let start = 0;
            let end = info.size - 1;
            const range = request.headers.range;
            if (range) {
                const match = /^bytes=(\d*)-(\d*)$/.exec(range);
                if (!match || (!match[1] && !match[2])) { response.writeHead(416).end(); return; }
                if (!match[1]) { start = Math.max(0, info.size - Number(match[2])); }
                else { start = Number(match[1]); end = Math.min(end, match[2] ? Number(match[2]) : end); }
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
                    response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return;
                }
            }
            response.writeHead(range ? 206 : 200, {
                'Content-Type': types[extname(path)] ?? 'application/octet-stream',
                'Content-Length': Math.max(0, end - start + 1),
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-cache',
                'X-Content-Type-Options': 'nosniff',
                ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
            });
            if (request.method === 'HEAD' || info.size === 0) { response.end(); return; }
            const stream = createReadStream(path, {
                start,
                end,
            });
            stream.on('error', () => response.destroy());
            response.on('close', () => stream.destroy());
            stream.pipe(response);
        })().catch(() => { if (!response.headersSent) { response.writeHead(404).end(); } else { response.destroy(); } });
    });
    await new Promise<void>((ready, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', ready);
    });
    const address = server.address();
    if (!address || typeof address === 'string') { throw new Error('Review server has no TCP address'); }
    return {
        url: `http://127.0.0.1:${address.port}/`,
        directory: root,
        close: () => new Promise<void>((done, reject) => {
            server.close(error => error ? reject(error) : done());
            server.closeAllConnections();
        }),
    };
}
