import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    isSentryDiagnosticsBuild,
    resolveSentryBuildIdentity,
    resolveSentryBuildTarget,
} from '../../packages/contracts/diagnostics/releaseIdentity.js';

async function loadStagePrivateSourcemaps() {
    const {stagePrivateSourcemaps} = await import('./stage-private-sourcemaps.mjs');
    return stagePrivateSourcemaps;
}

export async function stageDesktopRendererSourcemaps({
    environment = process.env,
    projectRoot = process.cwd(),
    stageSourcemaps = loadStagePrivateSourcemaps,
} = {}) {
    if (
        !isSentryDiagnosticsBuild(environment)
        || resolveSentryBuildTarget(environment) !== 'desktop'
    ) {
        return null;
    }

    const packageJson = JSON.parse(await readFile(
        path.join(projectRoot, 'package.json'),
        'utf8',
    ));
    const identity = resolveSentryBuildIdentity({
        target: 'desktop',
        version: packageJson.version,
        environment,
        platform: process.platform,
        architecture: process.arch,
    });
    const stage = await stageSourcemaps();
    return stage({
        identity,
        outputRoots: ['nuxt-output'],
        projectRoot,
        reset: true,
        includeNitro: false,
    });
}

function isDirectInvocation() {
    return process.argv[1]
        && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectInvocation()) {
    await stageDesktopRendererSourcemaps();
}
