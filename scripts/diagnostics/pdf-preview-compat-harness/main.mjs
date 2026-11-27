import {app, BrowserWindow} from 'electron';
import {createServer} from 'node:http';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {basename, extname, resolve} from 'node:path';

const args = Object.fromEntries(
    process.argv.slice(2).map((argument) => {
        const [key, ...value] = argument.replace(/^--/u, '').split('=');
        return [key, value.join('=')];
    }),
);

if (!args.pdf) {
    throw new Error('--pdf is required');
}
const pdfPath = resolve(args.pdf);
const outputDirectory = resolve(args.out ?? '.devkit/pdf-preview-compat');
const pdfjsRoot = resolve(args.pdfjs ?? 'node_modules/pdfjs-dist-codex-preview');
const requestedPages = (args.pages ?? '')
    .split(',')
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
const scale = Number(args.scale ?? '1.3333333333333333');
if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error('--scale must be positive');
}

const html = String.raw`<!doctype html>
<html>
<head><meta charset="utf-8"><style>
html, body { margin: 0; background: white; }
canvas { display: block; }
</style></head>
<body><canvas id="page"></canvas>
<script type="module">
import * as pdfjs from '/pdfjs/build/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.mjs';
const canvas = document.querySelector('#page');
const context = canvas.getContext('2d', {alpha: false});
// Deliberately mirror the Codex artifact preview. It converts the data URL to
// Uint8Array and calls getDocument({data}) without a wasmUrl. Do not "fix" this
// harness: its purpose is to reject PDFs that disappear in that exact consumer.
const inputData = new Uint8Array(await (await fetch('/input.pdf')).arrayBuffer());
const documentTask = pdfjs.getDocument({data: inputData});
const documentProxy = await documentTask.promise;
window.pdfHarness = {
    pageCount: documentProxy.numPages,
    async render(pageNumber, scale) {
        const page = await documentProxy.getPage(pageNumber);
        const viewport = page.getViewport({scale});
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        context.save();
        context.fillStyle = 'white';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.restore();
        await page.render({canvas, canvasContext: context, viewport}).promise;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let darkPixels = 0;
        let inkPixels = 0;
        let luminanceTotal = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
            const luminance = pixels[offset] * 0.2126
                + pixels[offset + 1] * 0.7152
                + pixels[offset + 2] * 0.0722;
            luminanceTotal += luminance;
            if (luminance < 245) inkPixels += 1;
            if (luminance < 128) darkPixels += 1;
        }
        const pixelCount = canvas.width * canvas.height;
        return {
            dataUrl: canvas.toDataURL('image/png'),
            darkPixelRatio: darkPixels / pixelCount,
            height: canvas.height,
            inkPixelRatio: inkPixels / pixelCount,
            meanLuminance: luminanceTotal / pixelCount,
            width: canvas.width,
        };
    },
};
</script></body>
</html>`;

function contentType(path) {
    switch (extname(path)) {
        case '.mjs':
        case '.js':
            return 'text/javascript';
        case '.bcmap':
            return 'application/octet-stream';
        case '.pdf':
            return 'application/pdf';
        case '.wasm':
            return 'application/wasm';
        default:
            return 'application/octet-stream';
    }
}

const server = createServer(async (request, response) => {
    try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/' || url.pathname === '/index.html') {
            response.writeHead(200, {'Content-Type': 'text/html'});
            response.end(html);
            return;
        }
        if (url.pathname === '/input.pdf') {
            response.writeHead(200, {'Content-Type': 'application/pdf'});
            response.end(await readFile(pdfPath));
            return;
        }
        if (url.pathname.startsWith('/pdfjs/')) {
            const relativePath = url.pathname.slice('/pdfjs/'.length);
            const requestedPath = resolve(pdfjsRoot, relativePath);
            if (!requestedPath.startsWith(`${pdfjsRoot}/`)) {
                throw new Error('Invalid asset path');
            }
            response.writeHead(200, {'Content-Type': contentType(requestedPath)});
            response.end(await readFile(requestedPath));
            return;
        }
        response.writeHead(404);
        response.end('not found');
    } catch (error) {
        response.writeHead(500);
        response.end(String(error));
    }
});

await app.whenReady();
await mkdir(outputDirectory, {recursive: true});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
if (typeof address !== 'object' || address === null) {
    throw new Error('Server did not bind');
}

const consoleMessages = [];
const window = new BrowserWindow({
    show: false,
    width: 1200,
    height: 1600,
    webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        sandbox: true,
    },
});
window.webContents.on('console-message', (_event, details, legacyMessage) => {
    const message = typeof details === 'object' ? details.message : String(legacyMessage ?? details);
    const level = typeof details === 'object' ? details.level : details;
    consoleMessages.push({
        level,
        message,
    });
    console.error(`[renderer:${String(level)}] ${message}`);
});
window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    const message = `${String(errorCode)} ${errorDescription}`;
    consoleMessages.push({
        level: 'load',
        message,
    });
    console.error(`[renderer:load] ${message}`);
});
await window.loadURL(`http://127.0.0.1:${String(address.port)}/`);
await window.webContents.executeJavaScript(
    `new Promise((resolve, reject) => {
        const deadline = Date.now() + 15000;
        const poll = () => {
            if (window.pdfHarness) return resolve();
            if (Date.now() >= deadline) return reject(new Error('Timed out waiting for PDF harness'));
            setTimeout(poll, 10);
        };
        poll();
    })`,
);
const pageCount = await window.webContents.executeJavaScript('window.pdfHarness.pageCount');
const pages =
    requestedPages.length > 0
        ? requestedPages.filter((page) => page <= pageCount)
        : Array.from({length: pageCount}, (_, index) => index + 1);
const results = [];
for (const pageNumber of pages) {
    const result = await window.webContents.executeJavaScript(`window.pdfHarness.render(${String(pageNumber)}, ${JSON.stringify(scale)})`);
    const png = Buffer.from(result.dataUrl.replace(/^data:image\/png;base64,/u, ''), 'base64');
    const outputPath = resolve(outputDirectory, `page-${String(pageNumber).padStart(String(pageCount).length, '0')}.png`);
    await writeFile(outputPath, png);
    results.push({
        ...result,
        dataUrl: undefined,
        outputPath,
        pageNumber,
    });
}
await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
const report = {
    consoleMessages,
    input: pdfPath,
    pageCount,
    pdfjsRoot,
    pdfjsVersion: '5.4.296',
    renderer: `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`,
    results,
    scale,
};
await writeFile(resolve(outputDirectory, 'render-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(
    JSON.stringify({
        input: basename(pdfPath),
        outputDirectory,
        pageCount,
        renderedPages: results.length,
        renderer: report.renderer,
    }),
);
window.destroy();
await new Promise((resolveClose) => server.close(resolveClose));
app.exit(0);
