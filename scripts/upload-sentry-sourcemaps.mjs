// Adds Sentry Debug IDs to the built bundles, uploads their source maps, and
// deletes the maps so no release artifact or deployment serves them.
// sentry-cli reads SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT from the
// environment. Usage: node scripts/upload-sentry-sourcemaps.mjs [<dir>...]
// Without directories it handles the renderer output of the Nuxt build that just
// ran (`pnpm run build`, before pruning), and does nothing without a token.

import {spawnSync} from 'node:child_process';
import {
    readdirSync,
    rmSync,
} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {
    getExpectedWebDeployOutputRoots,
    isVercelBuildOutputEnv,
} from './check-web-deploy-assets.mjs';

let directories = process.argv.slice(2);
if (directories.length === 0) {
    if (!process.env.SENTRY_AUTH_TOKEN) {
        // A hosted build that reports to Sentry must carry Debug IDs, or its
        // stacks can never be symbolicated.
        if (isVercelBuildOutputEnv() && process.env.SENTRY_BROWSER_DSN?.trim()) {
            console.error('Refusing a hosted build with SENTRY_BROWSER_DSN but no SENTRY_AUTH_TOKEN: its stacks could not be symbolicated.');
            process.exit(1);
        }
        process.exit(0);
    }
    directories = getExpectedWebDeployOutputRoots();
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
