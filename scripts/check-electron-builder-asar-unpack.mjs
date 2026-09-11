import { getCliErrorMessage } from './lib/cli-error.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKER_BUNDLES } from '../packages/electron-worker-bundles/electronWorkerBundles.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builderConfigPath = path.join(projectRoot, 'electron-builder.yml');
const requiredNonWorkerUnpackEntries = [
    'dist-electron/package.json',
    'dist-electron/pdf.worker.mjs',
    'dist-electron/runtime/@napi-rs/canvas/*.node',
];

export function parseAsarUnpackEntries(source) {
    const lines = source.split(/\r?\n/u);
    const start = lines.findIndex(line => line.trim() === 'asarUnpack:');
    if (start === -1) {
        throw new Error('electron-builder.yml is missing asarUnpack');
    }

    const entries = [];
    for (const line of lines.slice(start + 1)) {
        if (/^\S/u.test(line)) {
            break;
        }

        const match = line.match(/^\s*-\s+(.+?)\s*$/u);
        if (match?.[1]) {
            entries.push(match[1]);
        }
    }

    return entries;
}

export function getExpectedAsarUnpackEntries() {
    return [
        ...requiredNonWorkerUnpackEntries,
        ...WORKER_BUNDLES
            .filter(bundle => bundle.unpacked)
            .map(bundle => `dist-electron/${bundle.fileName}`),
    ].sort();
}

export function assertAsarUnpackMatchesWorkerBundles(source) {
    const actual = parseAsarUnpackEntries(source).sort();
    const expected = getExpectedAsarUnpackEntries();
    const missing = expected.filter(entry => !actual.includes(entry));
    const extra = actual.filter(entry => !expected.includes(entry));

    if (missing.length > 0 || extra.length > 0) {
        throw new Error([
            'electron-builder.yml asarUnpack is out of sync with WORKER_BUNDLES.',
            `Missing: ${missing.length > 0 ? missing.join(', ') : '(none)'}`,
            `Extra: ${extra.length > 0 ? extra.join(', ') : '(none)'}`,
        ].join('\n'));
    }
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    try {
        assertAsarUnpackMatchesWorkerBundles(readFileSync(builderConfigPath, 'utf8'));
        console.log('electron-builder.yml asarUnpack matches WORKER_BUNDLES.');
    } catch (error) {
        console.error(getCliErrorMessage(error));
        process.exit(1);
    }
}
