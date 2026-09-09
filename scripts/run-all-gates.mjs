#!/usr/bin/env node

import { getCliErrorMessage } from './lib/cli-error.mjs';
import {spawn} from 'node:child_process';
import {
    createWriteStream,
    mkdirSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {
    RELEASE_BUILD_RECEIPT_ENV_VAR,
    writeReleaseBuildReceipt,
} from './release/build-receipt.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function getAllGateDefinitions() {
    return [
        {
            args: [
                'scripts/validation-gates.mjs',
                'acceptance',
            ],
            command: 'node',
            description: 'Consolidated lint, types, unit and native tests, one strict build, and blocking Electron smoke',
            id: 'validate',
        },
        {
            args: [
                'run',
                'release:verify',
            ],
            command: 'pnpm',
            description: 'Unique release checks and local package verification using the validated build',
            id: 'release-verify',
        },
        {
            args: ['scripts/release/release-cut-preflight.mjs'],
            command: 'node',
            description: 'Clean worktree, upstream, GitHub auth, Node baseline, and next patch tag checks',
            id: 'release-cut-preflight',
        },
    ];
}

export function getAllGateEnvironment(gateId, {
    baseEnv = process.env,
    receiptReady = false,
    receiptPath,
} = {}) {
    const env = {
        ...baseEnv,
        FORCE_COLOR: baseEnv.FORCE_COLOR ?? '1',
    };
    if (gateId === 'validate') {
        return {
            ...env,
            EVB_VALIDATE_ALL_GATES: '1',
        };
    }
    if (gateId === 'release-verify' && receiptReady) {
        return {
            ...env,
            [RELEASE_BUILD_RECEIPT_ENV_VAR]: receiptPath,
            EVB_RELEASE_VERIFY_REUSE_BUILD_RECEIPT: '1',
        };
    }
    return env;
}

function usage() {
    return `Usage: node scripts/run-all-gates.mjs [options]

Runs each EVB Viewer validation and release guarantee once and writes logs under .devkit/gates/<timestamp>/.

Options:
  --list             Print available gates and exit
  --only <gate>      Run only one gate
  --from <gate>      Start at a specific gate and continue
  --skip <gate>      Skip a gate; may be repeated
  --help             Show this help
`;
}

function parseArgs(argv) {
    const options = {
        from: undefined,
        list: false,
        only: undefined,
        skip: new Set(),
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--help' || argument === '-h') {
            process.stdout.write(usage());
            return {
                ...options,
                help: true,
            };
        }
        if (argument === '--list') {
            options.list = true;
            continue;
        }
        if (argument === '--only' || argument === '--from' || argument === '--skip') {
            const value = argv[index + 1];
            if (!value) {
                throw new Error(`${argument} requires a gate id.`);
            }
            index += 1;
            if (argument === '--only') {
                options.only = value;
            } else if (argument === '--from') {
                options.from = value;
            } else {
                options.skip.add(value);
            }
            continue;
        }
        throw new Error(`Unknown argument: ${argument}`);
    }
    return options;
}

function selectGates(gates, options) {
    const knownIds = new Set(gates.map(gate => gate.id));
    for (const id of [
        options.only,
        options.from,
        ...options.skip,
    ]) {
        if (id != null && !knownIds.has(id)) {
            throw new Error(`Unknown gate "${id}". Use --list to see available gates.`);
        }
    }
    let selected = gates;
    if (options.only != null) {
        selected = gates.filter(gate => gate.id === options.only);
    } else if (options.from != null) {
        selected = gates.slice(gates.findIndex(gate => gate.id === options.from));
    }
    return selected.filter(gate => !options.skip.has(gate.id));
}

function commandText(gate) {
    return [
        gate.command,
        ...gate.args,
    ].join(' ');
}

function gateTimestamp() {
    return new Date().toISOString().replaceAll(':', '').replace(/\.\d{3}Z$/u, 'Z');
}

function runGate(gate, {
    env,
    index,
    logDirectory,
}) {
    return new Promise(resolve => {
        const logPath = path.join(logDirectory, `${String(index + 1).padStart(2, '0')}-${gate.id}.log`);
        const logStream = createWriteStream(logPath, {flags: 'w'});
        const startedAt = new Date();
        process.stdout.write(`\n[gate:${gate.id}] ${commandText(gate)}\n`);
        process.stdout.write(`[gate:${gate.id}] ${gate.description}\n`);
        process.stdout.write(`[gate:${gate.id}] log: ${logPath}\n`);
        logStream.write(`# ${gate.id}\n# command: ${commandText(gate)}\n# cwd: ${projectRoot}\n# started: ${startedAt.toISOString()}\n\n`);

        const child = spawn(gate.command, gate.args, {
            cwd: projectRoot,
            env,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        });
        const forwardSignal = signal => child.kill(signal);
        const forwardSigint = () => forwardSignal('SIGINT');
        const forwardSigterm = () => forwardSignal('SIGTERM');
        process.once('SIGINT', forwardSigint);
        process.once('SIGTERM', forwardSigterm);
        child.stdout.on('data', chunk => {
            process.stdout.write(chunk);
            logStream.write(chunk);
        });
        child.stderr.on('data', chunk => {
            process.stderr.write(chunk);
            logStream.write(chunk);
        });
        let finished = false;
        const finish = (code, signal, error) => {
            if (finished) {
                return;
            }
            finished = true;
            process.off('SIGINT', forwardSigint);
            process.off('SIGTERM', forwardSigterm);
            const stoppedAt = new Date();
            if (error) {
                logStream.write(`\n# spawn error: ${error.message}\n`);
            }
            logStream.write(`\n# stopped: ${stoppedAt.toISOString()}\n# exitCode: ${code ?? ''}\n# signal: ${signal ?? ''}\n`);
            logStream.end();
            resolve({
                code: code ?? (signal == null ? 0 : 1),
                gate,
                logPath,
                signal,
                startedAt,
                stoppedAt,
            });
        };
        child.once('error', error => finish(1, undefined, error));
        child.once('close', (code, signal) => finish(code, signal));
    });
}

function writeSummary(logDirectory, results) {
    writeFileSync(path.join(logDirectory, 'summary.json'), `${JSON.stringify({
        finishedAt: new Date().toISOString(),
        results: results.map(result => ({
            command: commandText(result.gate),
            exitCode: result.code,
            gate: result.gate.id,
            logPath: result.logPath,
            signal: result.signal,
            startedAt: result.startedAt.toISOString(),
            stoppedAt: result.stoppedAt.toISOString(),
        })),
    }, null, 2)}\n`);
}

export async function runAllGates(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        return;
    }
    const gates = getAllGateDefinitions();
    if (options.list) {
        for (const gate of gates) {
            process.stdout.write(`${gate.id}\t${commandText(gate)}\t${gate.description}\n`);
        }
        return;
    }
    const selectedGates = selectGates(gates, options);
    if (selectedGates.length === 0) {
        throw new Error('No gates selected.');
    }
    const logDirectory = path.join(projectRoot, '.devkit', 'gates', gateTimestamp());
    const receiptPath = path.join(logDirectory, 'release-build-receipt.json');
    mkdirSync(logDirectory, {recursive: true});
    process.stdout.write(`Gate logs: ${logDirectory}\n`);

    const results = [];
    let receiptReady = false;
    for (const gate of selectedGates) {
        const result = await runGate(gate, {
            env: getAllGateEnvironment(gate.id, {
                receiptPath,
                receiptReady,
            }),
            index: gates.findIndex(candidate => candidate.id === gate.id),
            logDirectory,
        });
        results.push(result);
        if (result.code === 0 && gate.id === 'validate') {
            writeReleaseBuildReceipt(receiptPath);
            receiptReady = true;
        }
        writeSummary(logDirectory, results);
        if (result.code !== 0) {
            process.stderr.write(`\nGate failed: ${gate.id}\nLog: ${result.logPath}\n`);
            process.exitCode = result.code;
            return;
        }
    }
    process.stdout.write(`\nAll selected gates passed.\nSummary: ${path.join(logDirectory, 'summary.json')}\n`);
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectCliRun) {
    runAllGates().catch(error => {
        process.stderr.write(`${getCliErrorMessage(error)}\n`);
        process.exitCode = 1;
    });
}
