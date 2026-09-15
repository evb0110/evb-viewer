import { getErrorMessage } from '@contracts/getErrorMessage';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
    getNativeSourceMatrixCheckEntries,
    NATIVE_RESOURCE_PLATFORM_ARCHES,
    type INativeSourceMatrixCheckEntry,
} from '@scripts/nativeResourceManifest';

const requireScript = createRequire(import.meta.url);
const {renderPackagedEntries} = requireScript(
    './release/generated-release-targets.cjs',
) as {renderPackagedEntries: (tag: string) => string};

export function formatNativeSourceMatrixCliEntry(entry: INativeSourceMatrixCheckEntry) {
    return [
        entry.type,
        entry.path,
        entry.label,
    ].join('\t');
}

function usage() {
    return [
        'Usage: node --import tsx scripts/nativeResourceManifestCli.ts <command>',
        '',
        'Commands:',
        '  matrix-tags',
        '  source-matrix <platform-arch>',
        '  packaged-entries <platform-arch>',
    ].join('\n');
}

export function runNativeResourceManifestCli(argv: readonly string[]) {
    const command = argv[0];

    if (command === 'matrix-tags') {
        if (argv.length !== 1) {
            throw new Error(usage());
        }

        console.log(NATIVE_RESOURCE_PLATFORM_ARCHES.join('\n'));
        return;
    }

    if (command === 'source-matrix') {
        const tag = argv[1];
        if (argv.length !== 2 || !tag) {
            throw new Error(usage());
        }

        for (const entry of getNativeSourceMatrixCheckEntries(tag)) {
            console.log(formatNativeSourceMatrixCliEntry(entry));
        }
        return;
    }

    if (command === 'packaged-entries') {
        const tag = argv[1];
        if (argv.length !== 2 || !tag) {
            throw new Error(usage());
        }
        console.log(renderPackagedEntries(tag));
        return;
    }

    throw new Error(usage());
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    try {
        runNativeResourceManifestCli(process.argv.slice(2));
    } catch (error) {
        console.error(getErrorMessage(error));
        process.exit(1);
    }
}
