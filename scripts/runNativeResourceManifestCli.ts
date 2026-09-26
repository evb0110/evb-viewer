import { getErrorMessage } from '@contracts/getErrorMessage';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireScript = createRequire(import.meta.url);
const {renderPackagedEntries} = requireScript(
    './release/generated-release-targets.cjs',
) as {renderPackagedEntries: (tag: string) => string};

function usage() {
    return [
        'Usage: node --import tsx scripts/runNativeResourceManifestCli.ts <command>',
        '',
        'Commands:',
        '  packaged-entries <platform-arch>',
    ].join('\n');
}

export function runNativeResourceManifestCli(argv: readonly string[]) {
    const command = argv[0];

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
