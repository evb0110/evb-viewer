import { getErrorMessage } from '@contracts/getErrorMessage';
import {
    spawn,
    type ChildProcess,
} from 'node:child_process';
import {
    DEV_OUTPUT_TEE_DIR_ENV,
    createDevServerOutputTee,
} from '@scripts/electron-run/devServerOutputTee';
import { projectRoot } from '@scripts/electron-run/projectRoot';

const PNPM_COMMAND = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const TSX_COMMAND = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';

interface ICommandStep {
    source: string;
    label: string;
    command: string;
    args: string[];
    stdio: 'pipe' | 'inherit';
}

const tee = createDevServerOutputTee({
    sessionName: 'default',
    metadataFileName: 'pnpm-dev-run.json',
    owner: 'pnpm dev',
});

let activeChild: ChildProcess | null = null;
let requestedSignal: NodeJS.Signals | null = null;

function signalExitCode(signal: NodeJS.Signals) {
    return signal === 'SIGINT' ? 130 : 143;
}

function writeWrapperLine(line: string) {
    process.stdout.write(`${line}\n`);
    tee.writeLine('pnpm-dev-wrapper', 'stdout', line);
}

function installSignalForwarding() {
    const signals = [
        'SIGINT',
        'SIGTERM',
    ] as const;
    for (const signal of signals) {
        process.once(signal, () => {
            requestedSignal = signal;
            if (activeChild?.pid) {
                activeChild.kill(signal);
            }
        });
    }
}

function createChildEnv() {
    return {
        ...process.env,
        [DEV_OUTPUT_TEE_DIR_ENV]: tee.runDir,
        EVB_GATE_QUIET: process.env.EVB_GATE_QUIET ?? '1',
    };
}

function runStep(step: ICommandStep): Promise<number> {
    writeWrapperLine(`[pnpm dev] ${step.label}`);

    return new Promise((resolve) => {
        const child = spawn(step.command, step.args, {
            cwd: projectRoot,
            shell: false,
            stdio: step.stdio === 'inherit'
                ? 'inherit'
                : [
                    'inherit',
                    'pipe',
                    'pipe',
                ],
            env: createChildEnv(),
        });
        activeChild = child;

        if (step.stdio === 'pipe') {
            child.stdout?.on('data', (chunk: Buffer) => {
                tee.write(step.source, 'stdout', chunk);
                process.stdout.write(chunk);
            });
            child.stderr?.on('data', (chunk: Buffer) => {
                tee.write(step.source, 'stderr', chunk);
                process.stderr.write(chunk);
            });
        }

        child.on('error', (error) => {
            tee.writeLine(step.source, 'stderr', getErrorMessage(error));
            resolve(1);
        });
        child.on('exit', (code, signal) => {
            activeChild = null;
            if (signal) {
                resolve(signalExitCode(signal));
                return;
            }
            resolve(code ?? 1);
        });
    });
}

async function main() {
    installSignalForwarding();
    writeWrapperLine(`[pnpm dev] Tee logs: ${tee.relativeRunDir}`);

    const steps: ICommandStep[] = [
        {
            source: 'pnpm-dev-stop-default-session',
            label: 'Stopping previous default session',
            command: PNPM_COMMAND,
            args: [
                '--silent',
                'electron:run',
                'stop',
                '--session=default',
            ],
            stdio: 'pipe',
        },
        {
            source: 'pnpm-dev-build-scan-cleanup',
            label: 'Building native scan-cleanup',
            command: PNPM_COMMAND,
            args: [
                '--silent',
                'run',
                'build:scan-cleanup',
            ],
            stdio: 'pipe',
        },
        // The PDF assemblers are part of the scan-cleanup engine contract:
        // new TS emitting extended manifests against a stale staged binary
        // fails every conversion, so dev keeps all three crates fresh.
        {
            source: 'pnpm-dev-build-pdf-image-combine',
            label: 'Building native pdf-image-combine',
            command: PNPM_COMMAND,
            args: [
                '--silent',
                'run',
                'build:pdf-image-combine',
            ],
            stdio: 'pipe',
        },
        {
            source: 'pnpm-dev-build-pdf-page-ops',
            label: 'Building native pdf-page-ops',
            command: PNPM_COMMAND,
            args: [
                '--silent',
                'run',
                'build:pdf-page-ops',
            ],
            stdio: 'pipe',
        },
        {
            source: 'pnpm-dev-build-electron',
            label: 'Building Electron main and preload',
            command: PNPM_COMMAND,
            args: [
                '--silent',
                'run',
                'build:electron',
            ],
            stdio: 'pipe',
        },
        {
            source: 'pnpm-dev-start-electron-session',
            label: 'Starting Electron session',
            command: TSX_COMMAND,
            args: [
                'scripts/electronRun.ts',
                'start',
            ],
            stdio: 'inherit',
        },
    ];

    for (const step of steps) {
        const exitCode = await runStep(step);
        if (exitCode !== 0) {
            const failure = `[pnpm dev] ${step.label} failed (exit ${exitCode}); run logs: ${tee.relativeRunDir}`;
            process.stderr.write(`${failure}\n`);
            tee.writeLine('pnpm-dev-wrapper', 'stderr', failure);
            tee.close();
            process.exit(exitCode);
        }
        if (requestedSignal) {
            tee.close();
            process.exit(signalExitCode(requestedSignal));
        }
    }

    tee.close();
}

void main().catch((error) => {
    tee.writeLine('pnpm-dev-wrapper', 'stderr', getErrorMessage(error));
    tee.close();
    console.error(error);
    process.exit(1);
});
