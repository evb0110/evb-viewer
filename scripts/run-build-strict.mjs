import { getCliErrorMessage } from './lib/cli-error.mjs';
import { spawn } from 'node:child_process';
import {
    mkdirSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
    fileURLToPath,
    pathToFileURL,
} from 'node:url';
import {writeValidationBuildMarker} from './validation-gates.mjs';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, '..');
const buildLogPath = path.join(projectRoot, '.tmp', 'build.log');
const STRICT_BUILD_NODE_OPTIONS = '--max-old-space-size=6144';
const strictBuildNuxtArtifactsDir = path.join(projectRoot, '.devkit', 'cache', 'strict-build');

/** @typedef {import('node:child_process').SpawnOptions & {preserveExistingBuildLog?: boolean}} IBuildSpawnOptions */
/** @typedef {Error & {output: string, preserveExistingBuildLog?: boolean}} IBuildError */

/** @param {string[]} args @param {NodeJS.Platform} [platform] */
export function getPnpmInvocation(args, platform = process.platform) {
    if (platform === 'win32') {
        return {
            command: 'cmd.exe',
            args: [
                '/d',
                '/s',
                '/c',
                'pnpm',
                ...args,
            ],
        };
    }

    return {
        command: 'pnpm',
        args,
    };
}

/** @param {NodeJS.ProcessEnv} [env] @returns {NodeJS.ProcessEnv} */
export function getStrictBuildEnv(env = process.env) {
    const nodeOptions = env.NODE_OPTIONS?.trim();
    const hasHeapLimit = nodeOptions
        ? /(?:^|\s)--max-old-space-size(?:=|\s)/u.test(nodeOptions)
        : false;

    return {
        ...env,
        NODE_OPTIONS: hasHeapLimit
            ? nodeOptions
            : [
                nodeOptions,
                STRICT_BUILD_NODE_OPTIONS,
            ].filter(Boolean).join(' '),
        EVB_NUXT_BUILD_DIR: env.EVB_NUXT_BUILD_DIR
            ?? path.join(strictBuildNuxtArtifactsDir, 'nuxt-build'),
        EVB_NUXT_VITE_CACHE_DIR: env.EVB_NUXT_VITE_CACHE_DIR
            ?? path.join(strictBuildNuxtArtifactsDir, 'vite-cache'),
    };
}

export const STRICT_BUILD_SCRIPT_NAME = 'build:desktop';

const COLLAPSED_WARNING_PATTERNS = [/\b(?:WARN|\[warn\])\s+\[plugin @tailwindcss\/vite:generate:build\] Sourcemap is likely to be incorrect: a plugin \(@tailwindcss\/vite:generate:build\) was used to transform files, but didn't generate a sourcemap for the transformation\. Consult the plugin documentation for help(?: \(x\d+\))?$/u];

/** @param {string} line @returns {boolean} */
function isCollapsedWarning(line) {
    return COLLAPSED_WARNING_PATTERNS.some(pattern => pattern.test(line.trim()));
}

/** @param {(chunk: string) => void} write */
function createLineFilter(write) {
    let buffered = '';
    let collapsedWarningCount = 0;
    let lastCollapsedWarning = false;
    let pendingBlankLines = '';

    /** @param {string} line */
    const flushLine = (line) => {
        if (line.trim().length === 0) {
            pendingBlankLines += line;
            return;
        }

        if (isCollapsedWarning(line)) {
            collapsedWarningCount += 1;
            lastCollapsedWarning = true;
            pendingBlankLines = '';
            return;
        }

        if (!lastCollapsedWarning) {
            write(pendingBlankLines);
        }
        pendingBlankLines = '';
        lastCollapsedWarning = false;
        write(line);
    };

    return {
        /** @param {string} chunk */
        push(chunk) {
            buffered += chunk;
            const lines = buffered.split(/\r?\n/u);
            buffered = lines.pop() ?? '';

            for (const line of lines) {
                flushLine(`${line}\n`);
            }
        },
        flush() {
            if (buffered.length > 0) {
                flushLine(buffered);
                buffered = '';
            }
            if (!lastCollapsedWarning) {
                write(pendingBlankLines);
            }
            pendingBlankLines = '';

            return collapsedWarningCount;
        },
    };
}

/** @param {string} command @param {string[]} args @param {IBuildSpawnOptions} options @returns {Promise<string>} */
function run(command, args, options = {}) {
    const {
        preserveExistingBuildLog = false,
        ...spawnOptions
    } = options;

    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: projectRoot,
            env: process.env,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
            ...spawnOptions,
        });

        let output = '';
        const stdoutFilter = createLineFilter(line => process.stdout.write(line));
        const stderrFilter = createLineFilter(line => process.stderr.write(line));

        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');

        /** @param {string} chunk */
        const handleStdout = chunk => {
            output += chunk;
            stdoutFilter.push(chunk);
        };
        /** @param {string} chunk */
        const handleStderr = chunk => {
            output += chunk;
            stderrFilter.push(chunk);
        };
        child.stdout?.on('data', handleStdout);
        child.stderr?.on('data', handleStderr);

        child.on('error', reject);
        child.on('close', (code, signal) => {
            const collapsedWarnings = stdoutFilter.flush() + stderrFilter.flush();
            if (collapsedWarnings > 0) {
                process.stderr.write(
                    `Collapsed ${collapsedWarnings} known Tailwind sourcemap warning(s); see .tmp/build.log for full build output.\n`,
                );
            }

            if (code === 0) {
                resolve(output);
                return;
            }

            const error = /** @type {IBuildError} */ (new Error(
                signal
                    ? `${command} ${args.join(' ')} exited after signal ${signal}`
                    : `${command} ${args.join(' ')} exited with status ${code ?? 1}`,
            ));
            error.output = output;
            error.preserveExistingBuildLog = preserveExistingBuildLog;
            reject(error);
        });
    });
}

/** @param {unknown} error @returns {error is IBuildError} */
function isBuildError(error) {
    return typeof error === 'object'
        && error !== null
        && 'output' in error
        && typeof error.output === 'string';
}

/** @param {unknown} error @returns {boolean} */
export function shouldWriteErrorOutputToBuildLog(error) {
    return isBuildError(error)
        && error.output.length > 0
        && !error.preserveExistingBuildLog;
}

/** @returns {Promise<void>} */
async function main() {
    mkdirSync(path.dirname(buildLogPath), { recursive: true });
    const buildInvocation = getPnpmInvocation([
        'run',
        STRICT_BUILD_SCRIPT_NAME,
    ]);
    const output = await run(buildInvocation.command, buildInvocation.args, { env: getStrictBuildEnv() });
    writeFileSync(buildLogPath, output);
    await run('node', [
        'scripts/check-build-warnings.mjs',
        '.tmp/build.log',
    ], { preserveExistingBuildLog: true });
    const markerPath = await writeValidationBuildMarker({buildScriptName: STRICT_BUILD_SCRIPT_NAME});
    if (markerPath) {
        process.stdout.write(`Recorded fresh strict-build marker at ${markerPath}.\n`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    /** @param {unknown} error */
    main().catch((error) => {
        if (shouldWriteErrorOutputToBuildLog(error)) {
            mkdirSync(path.dirname(buildLogPath), { recursive: true });
            writeFileSync(buildLogPath, error.output);
        }

        console.error(getCliErrorMessage(error));
        process.exit(1);
    });
}
