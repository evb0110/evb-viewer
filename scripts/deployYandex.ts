import {
    createHash, createHmac,
} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {
    mkdir, mkdtemp, readFile, readdir, rm, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
import {
    chunk, pick,
} from 'es-toolkit';
import * as v from 'valibot';
import {getCliErrorMessage} from './lib/cli-error.mjs';
import {getWebDeployVendorDependencies} from './check-web-deploy-source.mjs';
import {
    acquireProductionDeployLock,
    resolveViewerAppVersion,
    shouldCopyPrivateDeployPath,
} from './deployVercelPrivate.mjs';

interface IS3RequestOptions {
    body?: string | Buffer<ArrayBuffer>;
    headers?: Record<string, string>;
    query?: string;
}

interface IAsset {
    key: string;
    body: Buffer<ArrayBuffer>;
    sha256: string;
}

const projectRoot = path.resolve(import.meta.dirname, '..');
const endpoint = 'https://storage.yandexcloud.net';
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

function command(executable: string, args: string[], cwd = projectRoot, env: NodeJS.ProcessEnv = process.env) {
    return execFileSync(executable, args, {
        cwd,
        env,
        encoding: 'utf8',
        stdio: [
            'ignore',
            'pipe',
            'inherit',
        ],
    }).trim();
}

async function batches<TInput, TOutput>(items: TInput[], task: (item: TInput) => Promise<TOutput>) {
    const output: TOutput[] = [];
    for (const batch of chunk(items, 6)) {
        const results = await Promise.allSettled(batch.map(task));
        for (const result of results) {
            if (result.status === 'rejected') throw result.reason;
            output.push(result.value);
        }
    }
    return output;
}

function storage(credentials: NodeJS.ProcessEnv) {
    const accessKey = credentials.YANDEX_S3_ACCESS_KEY_ID ?? credentials.MIRROR_S3_ACCESS_KEY_ID;
    const secretKey = credentials.YANDEX_S3_SECRET_KEY ?? credentials.MIRROR_S3_SECRET_KEY;
    if (!accessKey || !secretKey) throw new Error('Set YANDEX_S3_ACCESS_KEY_ID and YANDEX_S3_SECRET_KEY in .env.yandex.local or the environment.');
    return async (method: 'GET' | 'HEAD' | 'PUT' | 'DELETE', key: string, {
        body = '', headers = {}, query = '',
    }: IS3RequestOptions = {}) => {
        const uri = `/${key.split('/').map(encodeURIComponent).join('/')}`;
        const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/gu, '');
        const day = timestamp.slice(0, 8);
        const scope = `${day}/ru-central1/s3/aws4_request`;
        headers = {
            'host': 'storage.yandexcloud.net',
            'x-amz-date': timestamp,
            'x-amz-content-sha256': digest(body),
            ...headers,
        };
        const names = Object.keys(headers).sort();
        const canonical = [
            method,
            uri,
            query,
            names.map(name => `${name}:${headers[name] ?? ''}\n`).join(''),
            names.join(';'),
            digest(body),
        ].join('\n');
        let signingKey = Buffer.from(`AWS4${secretKey}`);
        for (const part of [
            day,
            'ru-central1',
            's3',
            'aws4_request',
        ]) {
            signingKey = createHmac('sha256', signingKey).update(part).digest();
        }
        const signature = createHmac('sha256', signingKey).update(`AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${digest(canonical)}`).digest('hex');
        headers.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
        const response = await fetch(`${endpoint}${uri}${query ? `?${query}` : ''}`, {
            method,
            headers,
            body: method === 'PUT' ? body : null,
            signal: AbortSignal.timeout(120_000),
            redirect: 'error',
        });
        if (!response.ok && !(response.status === 404 && [
            'GET',
            'HEAD',
        ].includes(method))) {
            await response.body?.cancel();
            throw new Error(`Yandex ${method} ${key}: HTTP ${response.status}`);
        }
        return response;
    };
}

async function sanitizeSource(source: string) {
    const vendors = getWebDeployVendorDependencies(source);
    async function visit(directory: string): Promise<void> {
        for (const entry of await readdir(directory, {withFileTypes: true})) {
            const name = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await visit(name);
            } else if (!shouldCopyPrivateDeployPath(name, source, 'viewer', vendors)) {
                await rm(name, {
                    recursive: true,
                    force: true,
                });
            } else if (entry.isSymbolicLink()) {
                throw new Error(`Deployment source contains a symbolic link: ${name}`);
            }
        }
    }
    await visit(source);
    const manifestPath = path.join(source, 'package.json');
    const manifest = v.parse(v.looseObject({scripts: v.record(v.string(), v.string())}), JSON.parse(await readFile(manifestPath, 'utf8')));
    delete manifest.scripts.prepare;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const registry = path.join(source, 'packages/contracts/ocrLanguages.ts');
    const original = await readFile(registry, 'utf8');
    const upstream = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/${TESSDATA_BEST_REF}/';
    if (original.split(upstream).length !== 2) throw new Error('OCR download contract changed; expected exactly one upstream URL template.');
    await writeFile(registry, original.replace(upstream, '/ocr-models/${TESSDATA_BEST_REF}/'));
}

function contentType(key: string) {
    const extension = path.extname(key);
    const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.json': 'application/json',
        '.css': 'text/css',
        '.wasm': 'application/wasm',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
        '.jpg': 'image/jpeg',
        '.webp': 'image/webp',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
        '.otf': 'font/otf',
        '.xml': 'application/xml',
        '.txt': 'text/plain; charset=utf-8',
        '.pdf': 'application/pdf',
    };
    return types[extension] ?? 'application/octet-stream';
}

async function publicBytes(url: string) {
    const response = await fetch(url, {
        signal: AbortSignal.timeout(120_000),
        cache: 'no-store',
        redirect: 'error',
    });
    if (!response.ok) throw new Error(`Mirror verification ${url}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
}

async function deploy() {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
        console.log('Usage: pnpm deploy:web:yandex:prod [--bucket=web-evb-viewer]\nCredentials: .env.yandex.local or YANDEX_S3_ACCESS_KEY_ID / YANDEX_S3_SECRET_KEY. Requires gh, pnpm and a successful CI run for HEAD.');
        return;
    }
    if (args.some(arg => !arg.startsWith('--bucket=')) || args.length > 1) throw new Error('Unsupported arguments. Use --help.');
    const bucket = args[0]?.slice('--bucket='.length) ?? 'web-evb-viewer';
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(bucket)) throw new Error('Use a bucket name of 3–63 lowercase letters, digits and hyphens, with no dots.');
    let local: NodeJS.ProcessEnv = {};
    try { local = parseEnv(await readFile(path.join(projectRoot, '.env.yandex.local'), 'utf8')); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    const s3 = storage({
        ...local,
        ...process.env,
    });
    if (command('git', [
        'status',
        '--porcelain',
    ])) throw new Error('Commit or preserve working changes before deploying.');
    const sha = command('git', [
        'rev-parse',
        'HEAD',
    ]);
    const version = resolveViewerAppVersion(projectRoot);
    const runs = v.parse(v.array(v.object({
        databaseId: v.number(),
        headSha: v.string(),
        status: v.string(),
        conclusion: v.nullable(v.string()),
    })), JSON.parse(command('gh', [
        'run',
        'list',
        '--workflow',
        'CI',
        '--commit',
        sha,
        '--limit',
        '20',
        '--json',
        'databaseId,status,conclusion,headSha',
    ])));
    const run = runs.find(candidate => candidate.headSha === sha && candidate.status === 'completed' && candidate.conclusion === 'success');
    if (!run) throw new Error(`HEAD ${sha} has no successful CI run. Wait for CI before deploying.`);
    const releaseLock = await acquireProductionDeployLock({
        env: process.env,
        projectId: `yandex:${bucket}`,
    });
    const scratchParent = path.join(projectRoot, '.devkit');
    await mkdir(scratchParent, {recursive: true});
    const scratch = await mkdtemp(path.join(scratchParent, 'yandex-build-'));
    try {
        const archive = path.join(scratch, 'source.tar');
        const source = path.join(scratch, 'source');
        await mkdir(source);
        command('git', [
            'archive',
            '--output',
            archive,
            sha,
        ]);
        command('tar', [
            '-xf',
            archive,
            '-C',
            source,
        ]);
        await sanitizeSource(source);
        command('gh', [
            'run',
            'download',
            String(run.databaseId),
            '--name',
            'browser-wasm',
            '--dir',
            source,
        ]);
        const env: NodeJS.ProcessEnv = {
            ...pick(process.env, [
                'PATH',
                'HOME',
                'TMPDIR',
                'TMP',
                'TEMP',
                'CI',
                'LANG',
                'LC_ALL',
                'TZ',
                'HTTP_PROXY',
                'HTTPS_PROXY',
                'ALL_PROXY',
                'NO_PROXY',
                'http_proxy',
                'https_proxy',
                'all_proxy',
                'no_proxy',
                'SSL_CERT_FILE',
                'SSL_CERT_DIR',
                'NODE_EXTRA_CA_CERTS',
            ]),
            VERCEL: '1',
            NODE_ENV: 'production',
            EVB_APP_VERSION: version,
            NUXT_PUBLIC_SITE_URL: `https://${bucket}.website.yandexcloud.net`,
            NUXT_PUBLIC_ANALYTICS_ENABLED: '0',
            GITHUB_SHA: sha,
            GIT_CEILING_DIRECTORIES: scratch,
            SENTRY_AUTH_TOKEN: '',
            SENTRY_BROWSER_DSN: '',
        };
        console.log(`Building ${version} (${sha}), WASM from CI run ${run.databaseId}.`);
        for (const args of [
            [
                'install',
                '--frozen-lockfile',
                '--ignore-scripts',
            ],
            [
                'exec',
                'nuxi',
                'prepare',
            ],
            [
                'run',
                'copy:pdfjs',
            ],
            [
                'run',
                'build',
            ],
        ]) {
            execFileSync('pnpm', args, {
                cwd: source,
                env,
                stdio: 'inherit',
            });
        }
        const modelData = v.parse(v.array(v.object({
            key: v.string(),
            url: v.string(),
            sha256: v.string(),
            bytes: v.number(),
        })), JSON.parse(command(process.execPath, [
            '--import',
            'tsx',
            '--input-type=module',
            '--eval',
            'import {TESSDATA_BEST_REF, OCR_MODEL_CODES, OCR_LANGUAGE_MODEL_SHA256, OCR_LANGUAGE_MODEL_BYTES, getOcrModelSourcePath} from \'./packages/contracts/ocrLanguages.ts\'; console.log(JSON.stringify(OCR_MODEL_CODES.map(code=>({key:\'ocr-models/\'+TESSDATA_BEST_REF+\'/\'+getOcrModelSourcePath(code)+\'.traineddata\',url:\'https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/\'+TESSDATA_BEST_REF+\'/\'+getOcrModelSourcePath(code)+\'.traineddata\',sha256:OCR_LANGUAGE_MODEL_SHA256[code],bytes:OCR_LANGUAGE_MODEL_BYTES[code]}))))',
        ], source, env)));
        const output = path.join(source, '.vercel/output');
        const config = v.parse(v.object({routes: v.array(v.object({headers: v.optional(v.record(v.string(), v.string()))}))}), JSON.parse(await readFile(path.join(output, 'config.json'), 'utf8')));
        const security = config.routes.find(route => route.headers?.['Content-Security-Policy'])?.headers;
        const policy = security?.['Content-Security-Policy'];
        const referrer = security?.['Referrer-Policy'];
        if (!policy || !referrer) throw new Error('Build output has no security policy. Refusing to publish.');
        const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
        // Object Storage cannot emit arbitrary security headers. Preserve the
        // directives HTML supports; frame-ancestors requires an HTTP header.
        const csp = policy.split(';').filter(directive => !directive.trim().startsWith('frame-ancestors')).join(';');
        const metadata = `<meta http-equiv="Content-Security-Policy" content="${escape(csp)}"><meta name="referrer" content="${escape(referrer)}"><meta name="robots" content="noindex, nofollow">`;
        const assets: IAsset[] = [];
        async function collect(directory: string, prefix = ''): Promise<void> {
            for (const entry of await readdir(directory, {withFileTypes: true})) {
                const key = `${prefix}${entry.name}`;
                const name = path.join(directory, entry.name);
                if (entry.isDirectory()) await collect(name, `${key}/`);
                else if (entry.isFile()) {
                    let body = await readFile(name);
                    if (key.endsWith('.html')) {
                        const html = body.toString();
                        if (!html.includes('<head>')) throw new Error(`Cannot inject security metadata: ${key} has no <head> tag.`);
                        body = Buffer.from(html.replace('<head>', () => `<head>${metadata}`));
                    }
                    assets.push({
                        key,
                        body,
                        sha256: digest(body),
                    });
                }
            }
        }
        await collect(path.join(output, 'static'));
        const index = assets.find(asset => asset.key === 'index.html');
        if (!index) throw new Error('Static output is missing index.html.');
        const exists = await s3('HEAD', bucket);
        if (exists.status === 404) {
            await (await s3('PUT', bucket)).body?.cancel();
            try {
                const claim = JSON.stringify({
                    bucket,
                    claimed_at: new Date().toISOString(),
                });
                await (await s3('PUT', `${bucket}/mirror-manifest.json`, {
                    body: claim,
                    headers: {
                        'content-type': 'application/json',
                        'x-amz-acl': 'public-read',
                        'cache-control': 'no-store',
                    },
                })).body?.cancel();
            } catch (error) {
                await (await s3('DELETE', bucket)).body?.cancel();
                throw error;
            }
        } else {
            const manifest = await s3('GET', `${bucket}/mirror-manifest.json`);
            if (!manifest.ok) throw new Error('Existing bucket is not a Viewer mirror; refusing to change it.');
            const identity = v.parse(v.object({bucket: v.string()}), await manifest.json());
            if (identity.bucket !== bucket) throw new Error('Existing bucket is not a Viewer mirror; refusing to change it.');
        }
        const xml = '<WebsiteConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IndexDocument><Suffix>index.html</Suffix></IndexDocument><RoutingRules><RoutingRule><Condition><KeyPrefixEquals>workspace</KeyPrefixEquals></Condition><Redirect><ReplaceKeyWith></ReplaceKeyWith><HttpRedirectCode>302</HttpRedirectCode><Protocol>https</Protocol></Redirect></RoutingRule></RoutingRules></WebsiteConfiguration>';
        await (await s3('PUT', bucket, {
            query: 'website=',
            body: xml,
            headers: {'content-type': 'application/xml'},
        })).body?.cancel();
        const put = async (key: string, body: Buffer<ArrayBuffer>, sha256: string, cache: string) => {
            const current = await s3('HEAD', `${bucket}/${key}`);
            if (current.ok && current.headers.get('x-amz-meta-sha256') === sha256 && Number(current.headers.get('content-length')) === body.length) return;
            const response = await s3('PUT', `${bucket}/${key}`, {
                body,
                headers: {
                    'content-type': contentType(key),
                    'x-amz-acl': 'public-read',
                    'x-amz-meta-sha256': sha256,
                    'cache-control': cache,
                },
            });
            if (!response.ok) throw new Error(`Upload failed: ${key}`);
            await response.body?.cancel();
        };
        const immutable = 'public, max-age=31536000, immutable';
        const revalidate = 'no-cache, max-age=0, must-revalidate';
        await batches(modelData, async model => {
            const existing = await s3('HEAD', `${bucket}/${model.key}`);
            if (existing.ok && existing.headers.get('x-amz-meta-sha256') === model.sha256 && Number(existing.headers.get('content-length')) === model.bytes) return;
            const body = await publicBytes(model.url);
            if (body.length !== model.bytes || digest(body) !== model.sha256) throw new Error(`OCR model integrity mismatch: ${model.key}`);
            await put(model.key, body, model.sha256, immutable);
        });
        await batches(assets.filter(asset => asset !== index), asset => put(asset.key, asset.body, asset.sha256, asset.key.startsWith('_nuxt/') && !asset.key.startsWith('_nuxt/builds/') ? immutable : revalidate));
        const url = `https://${bucket}.website.yandexcloud.net`;
        // Verify the public host before switching the home page. Retain old
        // hashed assets so already-open workspaces can finish their requests.
        await batches([
            ...assets.filter(asset => asset.key.endsWith('.wasm')),
            ...assets.filter(asset => asset.key.endsWith('.js') && asset.key.startsWith('_nuxt/')),
        ], async asset => {
            if (digest(await publicBytes(`${url}/${asset.key}`)) !== asset.sha256) throw new Error(`Public asset mismatch: ${asset.key}`);
        });
        const previous = await s3('GET', `${bucket}/index.html`);
        const previousIndex = previous.ok ? Buffer.from(await previous.arrayBuffer()) : null;
        try {
            await put(index.key, index.body, index.sha256, revalidate);
            if (digest(await publicBytes(`${url}/`)) !== index.sha256) throw new Error('Published home page does not match the build.');
            const manifest = Buffer.from(`${JSON.stringify({
                bucket,
                url,
                source_sha: sha,
                version,
                ci_run: run.databaseId,
                assets: assets.length,
                ocr_models: modelData.length,
                published_at: new Date().toISOString(),
            }, null, 2)}\n`);
            await put('mirror-manifest.json', manifest, digest(manifest), revalidate);
        } catch (error) {
            try {
                if (previousIndex) await put('index.html', previousIndex, digest(previousIndex), revalidate);
                else await (await s3('DELETE', `${bucket}/index.html`)).body?.cancel();
            } catch (restoreError) {
                console.error(`Home page restoration failed: ${getCliErrorMessage(restoreError)}`);
            }
            throw error;
        }
        console.log(`Yandex mirror verified: ${url}/`);
    } finally {
        await rm(scratch, {
            recursive: true,
            force: true,
        });
        await releaseLock();
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    deploy().catch(error => { console.error(getCliErrorMessage(error)); process.exitCode = 1; });
}
