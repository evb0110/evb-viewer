#!/usr/bin/env node

import {
    readdirSync,
    readFileSync,
    statSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    collectPublicArtifactContentViolations,
    isForbiddenPublicArtifactPath,
    shouldScanPublicArtifactContent,
} from '../check-build-artifacts-hygiene.mjs';

const { WORKER_BUNDLES } = await import(
    new URL('../../packages/electron-worker-bundles/electronWorkerBundles.js', import.meta.url).href
);

const RELEASE_DIR = path.resolve(process.cwd(), process.argv[2] ?? 'release');

export const REQUIRED_ASAR_ENTRIES = [
    '/package.json',
    '/dist-electron/main.js',
    '/dist-electron/preload.cjs',
    '/dist-electron/package.json',
    '/dist-electron/pdf.worker.mjs',
    ...WORKER_BUNDLES.map(bundle => `/dist-electron/${bundle.fileName}`),
    '/nuxt-output/public/electron/index.html',
    '/nuxt-output/public/index.html',
    '/nuxt-output/public/_nuxt',
];

export const REQUIRED_ASAR_PREFIXES = ['/dist-electron/main-chunk-'];

export const FORBIDDEN_EXACT_ENTRIES = [
    '/nuxt-output/public/evb-viewer-seo.png',
    '/nuxt-output/public/evb-viewer-preview-cropped.png',
    '/nuxt-output/public/evb-viewer-og.png',
    '/nuxt-output/public/robots.txt',
    '/nuxt-output/public/sitemap.xml',
];

export const FORBIDDEN_PREFIXES = [
    '/node_modules',
    '/vendor',
    '/nuxt-output/public/mobile-reader-proof',
];

export const EXPECTED_UNPACKED_DIST_ELECTRON = [
    ...WORKER_BUNDLES.map(bundle => bundle.fileName),
    'package.json',
    'pdf.worker.mjs',
].sort();

function findAsarArchives(rootDir) {
    const archives = [];
    const stack = [rootDir];

    while (stack.length > 0) {
        const current = stack.pop();
        let entries;
        try {
            entries = readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory() && entry.name !== 'app.asar.unpacked') {
                stack.push(entryPath);
                continue;
            }
            if (entry.isFile() && entry.name === 'app.asar') {
                archives.push(entryPath);
            }
        }
    }

    return archives;
}

export function normalizeAsarEntry(entry) {
    const normalizedEntry = entry.replaceAll('\\', '/');
    return normalizedEntry.startsWith('/') ? normalizedEntry : `/${normalizedEntry}`;
}

export function normalizeAsarEntries(entries) {
    return [...new Set(entries.map(normalizeAsarEntry))];
}

export function collectEntryViolations(entries) {
    const problems = [];
    const entrySet = new Set(entries);

    for (const required of REQUIRED_ASAR_ENTRIES) {
        if (!entrySet.has(required)) {
            problems.push(`missing required entry: ${required}`);
        }
    }
    for (const requiredPrefix of REQUIRED_ASAR_PREFIXES) {
        if (!entries.some(entry => entry.startsWith(requiredPrefix))) {
            problems.push(`missing required entry prefix: ${requiredPrefix}`);
        }
    }

    for (const entry of entries) {
        if (FORBIDDEN_EXACT_ENTRIES.includes(entry)) {
            problems.push(`forbidden entry present: ${entry}`);
            continue;
        }
        if (FORBIDDEN_PREFIXES.some(prefix => entry === prefix || entry.startsWith(`${prefix}/`))) {
            problems.push(`forbidden entry present: ${entry}`);
            continue;
        }
        if (entry.endsWith('.map')) {
            problems.push(`source map should not ship: ${entry}`);
            continue;
        }
        if (entry.endsWith('.d.ts') || entry.endsWith('.d.mts')) {
            problems.push(`PDF.js declaration should not ship: ${entry}`);
            continue;
        }
        if (isForbiddenPublicArtifactPath(entry.slice(1))) {
            problems.push(`private staging path should not ship: ${entry}`);
            continue;
        }
        if (entry.endsWith('.meta.json')) {
            problems.push(`bundle metafile should not ship: ${entry}`);
            continue;
        }
        if (entry.endsWith('.tgz') || entry.endsWith('.tar.gz')) {
            problems.push(`archive should not ship: ${entry}`);
            continue;
        }
        if (/\/(?:pdfjs-dist|pdfjs-dist-codex-preview)(?:\/|$)/u.test(entry)
            || /(?:^|\/)(?:pdf\.sandbox|pdf\.min)\.mjs$/u.test(entry)
            || /(?:^|\/)(?:pdf_viewer|pdf\.worker)\.mjs\.map$/u.test(entry)
            || /(?:^|\/)image_decoders\//u.test(entry)) {
            problems.push(`complete or alternate PDF.js package content should not ship: ${entry}`);
            continue;
        }
        if (entry.endsWith('.d.ts')
            || /\/pdfjs-dist[^/]*\.(?:md|map)$/u.test(entry)
            || /(?:^|\/)(?:patches?|[^/]+\.(?:patch|orig|rej|bak))(?:\/|$)/u.test(entry)) {
            problems.push(`PDF.js development artifact should not ship: ${entry}`);
            continue;
        }
        if (path.posix.basename(entry).startsWith('favicon-dev')) {
            problems.push(`dev favicon should not ship: ${entry}`);
        }
    }

    return problems;
}

export function collectUnpackedViolations(asarPath) {
    const unpackedDistElectron = path.join(`${asarPath}.unpacked`, 'dist-electron');
    let actual;
    try {
        actual = readdirSync(unpackedDistElectron).sort();
    } catch {
        return [`missing unpacked directory: ${unpackedDistElectron}`];
    }

    const problems = [];
    const expectedSet = new Set(EXPECTED_UNPACKED_DIST_ELECTRON);
    const actualSet = new Set(actual);

    for (const expected of EXPECTED_UNPACKED_DIST_ELECTRON) {
        if (!actualSet.has(expected)) {
            problems.push(`missing unpacked file: dist-electron/${expected}`);
        }
    }
    for (const present of actual) {
        if (!expectedSet.has(present)) {
            problems.push(`unexpected unpacked file: dist-electron/${present}`);
        }
        if (shouldScanPublicArtifactContent(present)) {
            const filePath = path.join(unpackedDistElectron, present);
            try {
                const content = readFileSync(filePath);
                for (const problem of collectPublicArtifactContentViolations(content, {target: 'desktop'})) {
                    problems.push(`forbidden unpacked content in dist-electron/${present}: ${problem}`);
                }
            } catch {
                // Missing expected files have their own stable error above.
            }
        }
    }

    const unpackedPackageJsonPath = path.join(unpackedDistElectron, 'package.json');
    try {
        const parsed = JSON.parse(readFileSync(unpackedPackageJsonPath, 'utf8'));
        if (parsed.type !== 'module') {
            problems.push('unpacked dist-electron/package.json must declare "type": "module"');
        }
    } catch {
        // Missing file already reported above.
    }

    return problems;
}

export async function main() {
    const { default: asar } = await import('@electron/asar');

    statSync(RELEASE_DIR);
    const archives = findAsarArchives(RELEASE_DIR);
    if (archives.length === 0) {
        throw new Error(`No app.asar found under ${RELEASE_DIR}`);
    }

    const failures = [];
    for (const asarPath of archives) {
        const entries = normalizeAsarEntries(asar.listPackage(asarPath));
        const contentProblems = [];
        for (const entry of entries) {
            if (!shouldScanPublicArtifactContent(entry)) {
                continue;
            }
            let content;
            try {
                content = asar.extractFile(asarPath, entry.slice(1));
            } catch {
                continue;
            }
            const target = entry.startsWith('/nuxt-output/public/')
                ? 'desktop-renderer'
                : 'desktop';
            for (const problem of collectPublicArtifactContentViolations(content, {target})) {
                contentProblems.push(`forbidden ASAR content in ${entry}: ${problem}`);
            }
        }
        const problems = [
            ...collectEntryViolations(entries),
            ...collectUnpackedViolations(asarPath),
            ...contentProblems,
        ];
        if (problems.length > 0) {
            failures.push({
                asarPath,
                problems,
            });
        } else {
            process.stdout.write(`Packaged app contents OK: ${asarPath} (${entries.length} entries)\n`);
        }
    }

    if (failures.length > 0) {
        for (const failure of failures) {
            process.stderr.write(`Packaged app contents check failed: ${failure.asarPath}\n`);
            for (const problem of failure.problems.slice(0, 50)) {
                process.stderr.write(`  - ${problem}\n`);
            }
            if (failure.problems.length > 50) {
                process.stderr.write(`  ... and ${failure.problems.length - 50} more\n`);
            }
        }
        process.exit(1);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
