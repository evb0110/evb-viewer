import {spawn} from 'node:child_process';
import {
    mkdirSync,
    rmSync,
} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {withTypecheckNodeHeap} from './typecheckNodeEnv.mjs';

/** @param {{argv?: string[], cwd?: string, env?: NodeJS.ProcessEnv}} options @returns {{cacheDir: string, cold: boolean, env: NodeJS.ProcessEnv, workspaceDir: string}} */
export function resolveNuxtTypecheckRun({
    argv = process.argv.slice(2),
    cwd = process.cwd(),
    env = process.env,
} = {}) {
    const cold = argv.includes('--cold')
        || env.EVB_TYPECHECK_COLD === '1'
        || env.EVB_GATE_NO_CACHE === '1';
    const workspaceArg = argv.find(argument => !argument.startsWith('-'));
    const workspaceDir = workspaceArg ? path.resolve(cwd, workspaceArg) : cwd;
    const childEnv = /** @type {NodeJS.ProcessEnv} */ (withTypecheckNodeHeap(env));

    // pnpm injects npm-specific config vars that newer npm versions warn about
    // when Nuxt shells out through npm internals during typecheck.
    for (const key of Object.keys(childEnv)) {
        if (key.startsWith('npm_config_') && key !== 'npm_config_user_agent') {
            delete childEnv[key];
        }
    }

    const cacheDir = path.resolve(workspaceDir, '.devkit', 'cache', 'typecheck');
    // `nuxi typecheck` prepares Nitro, which empties Nitro's output directory.
    // Keep that away from nuxt-output, the renderer build Electron E2E loads.
    childEnv.EVB_NUXT_OUTPUT_DIR ??= path.join(cacheDir, 'nuxt-output');

    return {
        cacheDir,
        cold,
        env: childEnv,
        workspaceDir,
    };
}

const isMain = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
    const require = createRequire(import.meta.url);

    // Keep vue-tsc pinned in the workspace so CI and local runs share the same
    // typecheck toolchain instead of npm fetching a newer transient version.
    require.resolve('vue-tsc/package.json');

    const {
        cacheDir,
        cold,
        env,
        workspaceDir,
    } = resolveNuxtTypecheckRun();
    mkdirSync(cacheDir, {recursive: true});
    if (cold) {
        rmSync(path.resolve(cacheDir, 'nuxt.tsbuildinfo'), {force: true});
    }

    const nuxtBin = path.resolve(path.dirname(require.resolve('nuxt/package.json')), 'bin/nuxt.mjs');
    const child = spawn(process.execPath, [
        nuxtBin,
        'typecheck',
    ], {
        cwd: workspaceDir,
        env,
        stdio: 'inherit',
    });

    child.on('exit', (code, signal) => {
        if (signal) {
            process.kill(process.pid, signal);
            return;
        }

        process.exit(code ?? 1);
    });
}
