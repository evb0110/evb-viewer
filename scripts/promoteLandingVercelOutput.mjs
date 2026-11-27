import {cpSync, existsSync, mkdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const defaultProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function promoteLandingVercelOutput(projectRoot = defaultProjectRoot) {
    const landingOutputRoot = path.join(projectRoot, 'landing', '.vercel', 'output');
    const landingConfigPath = path.join(landingOutputRoot, 'config.json');
    const rootOutputRoot = path.join(projectRoot, '.vercel', 'output');

    if (!existsSync(landingConfigPath)) {
        throw new Error(`Landing build did not produce ${landingConfigPath}.`);
    }

    rmSync(rootOutputRoot, {
        force: true,
        recursive: true,
    });
    mkdirSync(path.dirname(rootOutputRoot), {recursive: true});
    cpSync(landingOutputRoot, rootOutputRoot, {
        force: true,
        recursive: true,
        verbatimSymlinks: true,
    });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
    promoteLandingVercelOutput();
}
