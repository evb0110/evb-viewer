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

export function getStrictBuildScriptName(argv = process.argv.slice(2), env = process.env) {
    return argv.includes('--skip-wasm-check') || env.EVB_STRICT_BUILD_SKIP_WASM_CHECK === '1'
        ? 'build:desktop:no-wasm-check'
        : 'build:desktop';
}

const COLLAPSED_WARNING_PATTERNS = [/\b(?:WARN|\[warn\])\s+\[plugin @tailwindcss\/vite:generate:build\] Sourcemap is likely to be incorrect: a plugin \(@tailwindcss\/vite:generate:build\) was used to transform files, but didn't generate a sourcemap for the transformation\. Consult the plugin documentation for help(?: \(x\d+\))?$/u];

function isCollapsedWarning(line) {
    return COLLAPSED_WARNING_PATTERNS.some(pattern => pattern.test(line.trim()));
}

function createLineFilter(write) {
    let buffered = '';
    let collapsedWarningCount = 0;
    let lastCollapsedWarning = false;
    let pendingBlankLines = '';

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

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        child.stdout.on('data', (chunk) => {
            output += chunk;
            stdoutFilter.push(chunk);
        });
        child.stderr.on('data', (chunk) => {
            output += chunk;
            stderrFilter.push(chunk);
        });

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

            const error = new Error(
                signal
                    ? `${command} ${args.join(' ')} exited after signal ${signal}`
                    : `${command} ${args.join(' ')} exited with status ${code ?? 1}`,
            );
            error.output = output;
            error.preserveExistingBuildLog = preserveExistingBuildLog;
            reject(error);
        });
    });
}

export function shouldWriteErrorOutputToBuildLog(error) {
    return Boolean(
        error
        && typeof error === 'object'
        && 'output' in error
        && typeof error.output === 'string'
        && error.output.length > 0
        && !error.preserveExistingBuildLog,
    );
}

async function main() {
    mkdirSync(path.dirname(buildLogPath), { recursive: true });
    const buildInvocation = getPnpmInvocation([
        'run',
        getStrictBuildScriptName(),
    ]);
    const output = await run(buildInvocation.command, buildInvocation.args, { env: getStrictBuildEnv() });
    writeFileSync(buildLogPath, output);
    await run('node', [
        'scripts/check-build-warnings.mjs',
        '.tmp/build.log',
    ], { preserveExistingBuildLog: true });
    const markerPath = await writeValidationBuildMarker({buildScriptName: getStrictBuildScriptName()});
    if (markerPath) {
        process.stdout.write(`Recorded fresh strict-build marker at ${markerPath}.\n`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        if (shouldWriteErrorOutputToBuildLog(error)) {
            mkdirSync(path.dirname(buildLogPath), { recursive: true });
            writeFileSync(buildLogPath, error.output);
        }

        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}
