import {
    readdirSync,
    statSync,
} from 'node:fs';
import { join } from 'node:path';
import { pruneStaleE2ESessions } from '@scripts/electron-run/electronRunE2ESessionPrune';
import { buildE2ERunEnv } from '@scripts/electron-run/electronRunRunId';
import { projectRoot } from '@scripts/electron-run/projectRoot';

const RENDERER_ENTRY = join(projectRoot, 'nuxt-output', 'public', 'electron', 'index.html');
const RENDERER_SOURCES = [
    'app',
    'packages',
    'nuxt.config.ts',
];

function findSourceNewerThan(path: string, builtAtMs: number): string | null {
    const stats = statSync(path);
    if (!stats.isDirectory()) {
        return stats.mtimeMs > builtAtMs ? path : null;
    }
    for (const entry of readdirSync(path)) {
        if (entry === 'node_modules') {
            continue;
        }
        const newer = findSourceNewerThan(join(path, entry), builtAtMs);
        if (newer) {
            return newer;
        }
    }
    return null;
}

/**
 * Electron E2E loads the production renderer from nuxt-output. A lane run
 * that reuses an older build after a source edit would test the old app, so
 * refuse it here. CI builds the renderer fresh for every run.
 */
function assertRendererBuildIsCurrent() {
    const builtAtMs = statSync(RENDERER_ENTRY, {throwIfNoEntry: false})?.mtimeMs;
    if (builtAtMs === undefined) {
        throw new Error(`Electron E2E runs against the built renderer, and ${RENDERER_ENTRY} is missing. Run pnpm build first.`);
    }
    if (process.env.CI === 'true') {
        return;
    }
    for (const source of RENDERER_SOURCES) {
        const newer = findSourceNewerThan(join(projectRoot, source), builtAtMs);
        if (newer) {
            throw new Error(`${newer} changed after the renderer was built. Run pnpm build first.`);
        }
    }
}

export default async function setup() {
    assertRendererBuildIsCurrent();
    Object.assign(process.env, buildE2ERunEnv(process.env));

    const result = await pruneStaleE2ESessions();
    if (result.stale.length === 0) {
        console.log('[E2E setup] No stale e2e sessions found.');
    } else {
        console.log([
            `[E2E setup] Stale e2e sessions: ${result.stale.length}`,
            `[E2E setup] Removed: ${result.removed.length > 0 ? result.removed.join(', ') : 'none'}`,
            `[E2E setup] Refused: ${result.refused.length > 0
                ? result.refused.map(entry => `${entry.name} (${entry.reason})`).join(', ')
                : 'none'}`,
        ].join('\n'));
    }
}
