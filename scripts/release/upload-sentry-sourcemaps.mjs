// Adds Sentry Debug IDs to the built bundles, uploads their source maps, and
// deletes the maps so no release artifact or deployment serves them.
// sentry-cli reads SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT from the
// environment. Usage: node scripts/release/upload-sentry-sourcemaps.mjs <dir>...

import {spawnSync} from 'node:child_process';
import {
    readdirSync,
    rmSync,
} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';

const directories = process.argv.slice(2);
if (directories.length === 0) {
    throw new Error('Pass the build output directories that contain source maps.');
}
const sentryCli = createRequire(import.meta.url).resolve('@sentry/cli/bin/sentry-cli');

for (const command of [
    'inject',
    'upload',
]) {
    const result = spawnSync(process.execPath, [
        sentryCli,
        'sourcemaps',
        command,
        ...directories,
    ], {stdio: 'inherit'});
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}
for (const directory of directories) {
    for (const entry of readdirSync(directory, {
        recursive: true,
        encoding: 'utf8',
    })) {
        if (entry.endsWith('.map')) {
            rmSync(join(directory, entry));
        }
    }
}
