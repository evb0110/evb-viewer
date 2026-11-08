#!/usr/bin/env node
// Builds the Chrome extension into dist-chrome-extension/: the browser
// workspace as a client-only page (nuxt.config.ts, EVB_BROWSER_EXTENSION_BUILD),
// the extension's service worker and open page (packages/chrome-extension),
// its manifest and locale strings, and a zip of the whole for the store.
//
//   node scripts/build-browser-extension.mjs [--skip-app-build]
//
// --skip-app-build repackages the last workspace build, for extension-only edits.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';

const projectRoot = path.resolve(import.meta.dirname, '..');
const extensionSourceRoot = path.join(projectRoot, 'packages/chrome-extension');
const cacheRoot = path.join(projectRoot, '.devkit/cache/chrome-extension');
const nuxtOutputRoot = path.join(cacheRoot, 'nuxt-output');
const nuxtPublicRoot = path.join(nuxtOutputRoot, 'public');
const outputRoot = path.join(projectRoot, 'dist-chrome-extension');
const unpackedRoot = path.join(outputRoot, 'unpacked');

// Output of the workspace build that the extension does not serve: other
// routes' shells, crawler files, and images only search results show.
const EXCLUDED_WORKSPACE_ENTRIES = new Set([
    '200.html',
    '404.html',
    'electron',
    'favicon-dev-16x16.png',
    'favicon-dev-32x32.png',
    'favicon-dev.ico',
    'favicon-dev.svg',
    'evb-viewer-og.png',
    'evb-viewer-preview-cropped.png',
    'evb-viewer-seo.png',
    'privacy',
    'robots.txt',
    'sitemap.xml',
    'workspace',
]);
/** @type {Record<string, string>} */
const CHROME_LOCALE_BY_APP_LOCALE = {
    'de': 'de',
    'en': 'en',
    'es': 'es',
    'fr': 'fr',
    'it': 'it',
    'nl': 'nl',
    'pt': 'pt_PT',
    'pt-BR': 'pt_BR',
    'ru': 'ru',
};
const MAX_DESCRIPTION_LENGTH = 132;
const INLINE_SCRIPT_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script>/giu;
const NON_EXECUTABLE_SCRIPT_TYPE = /\btype\s*=\s*["']?application\/(?:ld\+)?json\b/iu;

/** @param {string} command @param {string[]} args @param {{cwd?: string, env?: NodeJS.ProcessEnv}} [options] */
function run(command, args, {
    cwd = projectRoot, env = process.env, 
} = {}) {
    const result = spawnSync(command, args, {
        cwd,
        env,
        stdio: 'inherit',
    });
    if (result.error) {
        throw new Error(`${command} could not run${'code' in result.error && result.error.code === 'ENOENT' ? ': it is not installed' : ''}`, { cause: result.error });
    }
    if (result.status !== 0) {
        throw new Error(`${path.basename(command)} ${args.join(' ')} exited with ${String(result.status)}`);
    }
}

function buildWorkspace() {
    run(process.execPath, ['scripts/ensure-wasm-artifacts.mjs']);
    run(process.execPath, [
        '--import',
        'tsx',
        'scripts/generateBuildArtifacts.ts',
    ]);
    run(process.execPath, [
        path.join(projectRoot, 'node_modules/nuxt/bin/nuxt.mjs'),
        'generate',
    ], {env: {
        ...process.env,
        EVB_BROWSER_EXTENSION_BUILD: '1',
        EVB_NUXT_BUILD_DIR: path.join(cacheRoot, 'nuxt-build'),
        EVB_NUXT_OUTPUT_DIR: nuxtOutputRoot,
        EVB_NUXT_VITE_CACHE_DIR: path.join(cacheRoot, 'vite'),
    }});
    // `nuxi generate` links dist/ to the static output it wrote.
    const distLink = path.join(projectRoot, 'dist');
    if (existsSync(distLink) && lstatSync(distLink).isSymbolicLink()
        && path.resolve(projectRoot, readlinkSync(distLink)) === nuxtPublicRoot) {
        rmSync(distLink);
    }
}

/** @param {string} name */
function isPackagedName(name) {
    return !name.startsWith('.');
}

/**
 * An extension page runs only its own script files, so each inline script becomes one.
 * @param {string} htmlPath
 */
function externalizeInlineScripts(htmlPath) {
    const html = readFileSync(htmlPath, 'utf8');
    const rewritten = html.replace(INLINE_SCRIPT_PATTERN, (/** @type {string} */ tag, /** @type {string} */ attributes, /** @type {string} */ source) => {
        if (/\bsrc\s*=/iu.test(attributes) || NON_EXECUTABLE_SCRIPT_TYPE.test(attributes)) {
            return tag;
        }
        if (/\btype\s*=\s*["']?importmap\b/iu.test(attributes)) {
            throw new Error(`${path.relative(unpackedRoot, htmlPath)} has an inline import map, which an extension page cannot run`);
        }
        const fileName = `inline-${createHash('sha256').update(source).digest('hex').slice(0, 16)}.js`;
        writeFileSync(path.join(unpackedRoot, 'assets', fileName), source);
        return `<script${attributes} src="/assets/${fileName}"></script>`;
    });
    writeFileSync(htmlPath, rewritten);
}

/** @typedef {{extensionName: string, extensionDescription: string, openViewer: string}} IExtensionLocaleStrings */

/** @returns {Promise<Record<string, IExtensionLocaleStrings>>} */
async function readLocaleStrings() {
    const { tsImport } = await import('tsx/esm/api');
    /** @type {{LOCALE_DEFINITIONS: ReadonlyArray<{code: string, file: string}>}} */
    const { LOCALE_DEFINITIONS } = await tsImport('../packages/i18n-core/localeDefinitions.ts', import.meta.url);
    /** @type {Record<string, IExtensionLocaleStrings>} */
    const locales = {};
    for (const {
        code, file, 
    } of LOCALE_DEFINITIONS) {
        const chromeLocale = CHROME_LOCALE_BY_APP_LOCALE[code];
        if (!chromeLocale) {
            throw new Error(`No Chrome locale for the app locale ${code}`);
        }
        /** @type {{default: {app: {title: unknown}, browserExtension: {description: unknown, openViewer: unknown}}}} */
        const { default: messages } = await tsImport(`../packages/i18n-app/messages/${file}`, import.meta.url);
        const strings = {
            extensionName: messages.app.title,
            extensionDescription: messages.browserExtension.description,
            openViewer: messages.browserExtension.openViewer,
        };
        for (const [
            key,
            value,
        ] of Object.entries(strings)) {
            if (typeof value !== 'string' || !value) {
                throw new Error(`The ${code} messages have no ${key} for the extension`);
            }
        }
        const checked = /** @type {IExtensionLocaleStrings} */ (strings);
        if (checked.extensionDescription.length > MAX_DESCRIPTION_LENGTH) {
            throw new Error(`The ${code} extension description is longer than Chrome's ${String(MAX_DESCRIPTION_LENGTH)} characters`);
        }
        locales[chromeLocale] = checked;
    }
    return locales;
}

/** Chrome takes up to four dot-separated integers; a prerelease tag goes in version_name. */
function createManifest() {
    const manifest = JSON.parse(readFileSync(path.join(extensionSourceRoot, 'manifest.json'), 'utf8'));
    const { version } = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    const release = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
    if (!release || release.slice(1).some(part => Number(part) > 65_535)) {
        throw new Error(`package.json version ${version} cannot be a Chrome extension version`);
    }
    manifest.version = release.slice(1).join('.');
    if (manifest.version !== version) {
        manifest.version_name = version;
    }
    return manifest;
}

async function bundleExtensionScripts() {
    await esbuild.build({
        absWorkingDir: projectRoot,
        bundle: true,
        entryPoints: {
            'open': path.join(extensionSourceRoot, 'src/openPage.ts'),
            'service-worker': path.join(extensionSourceRoot, 'src/serviceWorker.ts'),
        },
        format: 'esm',
        legalComments: 'none',
        logLevel: 'warning',
        minify: true,
        outdir: unpackedRoot,
        target: 'chrome128',
        tsconfig: path.join(extensionSourceRoot, 'tsconfig.json'),
    });
}

/**
 * Chrome refuses an extension whose root holds a name starting with "_" other than _locales.
 * @param {string} root
 */
function assertLoadableNames(root) {
    const reserved = readdirSync(root).filter(name => name.startsWith('_') && name !== '_locales');
    if (reserved.length > 0) {
        throw new Error(`Chrome reserves root names that start with "_": ${reserved.join(', ')}`);
    }
}

/** @param {string} root */
function directorySize(root) {
    return readdirSync(root, { recursive: true })
        .map(entry => path.join(root, String(entry)))
        .filter(entry => statSync(entry).isFile())
        .reduce((total, entry) => total + statSync(entry).size, 0);
}

async function main() {
    if (!process.argv.includes('--skip-app-build')) {
        buildWorkspace();
    }
    if (!existsSync(path.join(nuxtPublicRoot, 'index.html'))) {
        throw new Error(`No workspace build at ${path.relative(projectRoot, nuxtPublicRoot)}; run without --skip-app-build`);
    }

    rmSync(outputRoot, {
        force: true,
        recursive: true, 
    });
    mkdirSync(unpackedRoot, { recursive: true });
    cpSync(nuxtPublicRoot, unpackedRoot, {
        recursive: true,
        filter: source => {
            const relative = path.relative(nuxtPublicRoot, source);
            return relative === ''
                || (isPackagedName(path.basename(source)) && !EXCLUDED_WORKSPACE_ENTRIES.has(relative));
        },
    });
    externalizeInlineScripts(path.join(unpackedRoot, 'index.html'));

    cpSync(path.join(extensionSourceRoot, 'static'), unpackedRoot, { recursive: true });
    cpSync(path.join(extensionSourceRoot, 'icons'), path.join(unpackedRoot, 'icons'), { recursive: true });
    await bundleExtensionScripts();
    for (const [
        locale,
        strings,
    ] of Object.entries(await readLocaleStrings())) {
        const localeRoot = path.join(unpackedRoot, '_locales', locale);
        mkdirSync(localeRoot, { recursive: true });
        writeFileSync(path.join(localeRoot, 'messages.json'), `${JSON.stringify(
            Object.fromEntries(Object.entries(strings).map(([
                key,
                message,
            ]) => [
                key,
                { message },
            ])),
            null,
            4,
        )}\n`);
    }
    const manifest = createManifest();
    writeFileSync(path.join(unpackedRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 4)}\n`);
    assertLoadableNames(unpackedRoot);

    const zipPath = path.join(outputRoot, `evb-viewer-chrome-${manifest.version_name ?? manifest.version}.zip`);
    run('zip', [
        '-q',
        '-r',
        '-X',
        zipPath,
        '.',
    ], { cwd: unpackedRoot });
    console.log(`Chrome extension ${manifest.version}: ${path.relative(projectRoot, unpackedRoot)} (${(directorySize(unpackedRoot) / 1_048_576).toFixed(1)} MiB), ${path.relative(projectRoot, zipPath)} (${(statSync(zipPath).size / 1_048_576).toFixed(1)} MiB)`);
}

await main();
