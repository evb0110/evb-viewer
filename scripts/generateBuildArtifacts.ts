import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateElectronBuilderResources } from '@scripts/generateElectronBuilderResources';
import { generateReleaseTargetManifest } from '@scripts/generateReleaseTargetManifest';
import { generatePlatformApiArtifacts } from '@scripts/platform-api/generatePlatformApiArtifacts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function generateBuildArtifacts({
    env = process.env,
    projectRoot: targetRoot = projectRoot,
}: {
    env?: NodeJS.ProcessEnv;
    projectRoot?: string;
} = {}) {
    if (env.EVB_BUILD_ARTIFACTS_PREPARED === '1') {
        return false;
    }
    const isVercelBuild = env.VERCEL === '1' || env.NOW_BUILDER === '1';
    const changed = await Promise.all([
        ...isVercelBuild
            ? []
            : [
                generateElectronBuilderResources({projectRoot: targetRoot}),
                generateReleaseTargetManifest({projectRoot: targetRoot}),
            ],
        generatePlatformApiArtifacts({projectRoot: targetRoot}),
    ]);
    return changed.some(Boolean);
}

const isDirectCliRun = process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun && await generateBuildArtifacts()) {
    console.info('Generated build artifacts.');
}
