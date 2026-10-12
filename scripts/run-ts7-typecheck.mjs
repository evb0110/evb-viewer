#!/usr/bin/env node

import { getCliErrorMessage } from './lib/cli-error.mjs';
import {
    spawn,
    spawnSync,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** @returns {{packageJsonPath: string, tscPath: string}} */
function readTs7Package() {
    const packageJsonPath = require.resolve('typescript7/package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const declaredBin = typeof packageJson.bin === 'string'
        ? packageJson.bin
        : packageJson.bin?.tsc;

    if (typeof declaredBin !== 'string' || declaredBin.length === 0) {
        throw new Error(`typescript7 does not declare a tsc executable in ${packageJsonPath}.`);
    }

    return {
        packageJsonPath,
        tscPath: path.resolve(path.dirname(packageJsonPath), declaredBin),
    };
}

/** @returns {{tscPath: string, version: string}} */
function resolveTs7Compiler() {
    const {
        packageJsonPath,
        tscPath,
    } = readTs7Package();
    // The tsc entry is a Node script; Windows cannot execute it through its shebang.
    const result = spawnSync(process.execPath, [
        tscPath,
        '--version',
    ], {
        encoding: 'utf8',
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });

    if (result.error) {
        throw new Error(`Could not execute the typescript7 tsc binary at ${tscPath}.`, {cause: result.error});
    }
    if (result.status !== 0) {
        const detail = `${result.stdout}${result.stderr}`.trim();
        throw new Error(`typescript7 tsc --version failed with exit code ${result.status}${detail === '' ? '' : `: ${detail}`}`);
    }

    const output = `${result.stdout}${result.stderr}`.trim();
    const versionMatch = /\bVersion\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u.exec(output);
    const version = versionMatch?.[1];
    if (version === undefined || !version.startsWith('7.')) {
        throw new Error(`Expected typescript7 tsc to report a 7.x version, received ${JSON.stringify(output)} from ${packageJsonPath}.`);
    }

    return {
        tscPath,
        version,
    };
}

/** @param {string[]} args @returns {string[]} */
function parseProjectArguments(args) {
    const projects = [];
    for (let index = 0; index < args.length; index += 2) {
        const flag = args[index];
        const project = args[index + 1];
        if (flag !== '-p' || project === undefined) {
            throw new Error('Usage: node scripts/run-ts7-typecheck.mjs -p <tsconfig> [-p <tsconfig> ...]');
        }
        projects.push(project);
    }

    if (projects.length === 0) {
        throw new Error('At least one -p <tsconfig> project argument is required.');
    }

    return projects;
}

/** @param {string} project @param {string} version @returns {string} */
function getBuildInfoPath(project, version) {
    const fingerprint = createHash('sha256')
        .update(project)
        .update('\0')
        .update(version)
        .update('\0')
        .update(readFileSync(path.resolve(project)))
        .digest('hex')
        .slice(0, 20);
    const cacheDir = path.resolve('.devkit', 'cache', 'typecheck', 'ts7');
    mkdirSync(cacheDir, {recursive: true});
    return path.join(cacheDir, `${fingerprint}.tsbuildinfo`);
}

/** @param {string[]} protectedPaths */
function pruneBuildInfoCache(protectedPaths) {
    const cacheDir = path.resolve('.devkit', 'cache', 'typecheck', 'ts7');
    const protectedNames = new Set(protectedPaths.map(filePath => path.basename(filePath)));
    const candidates = readdirSync(cacheDir)
        .filter(name => name.endsWith('.tsbuildinfo') && !protectedNames.has(name))
        .map(name => ({
            modifiedAtMs: statSync(path.join(cacheDir, name)).mtimeMs,
            name,
        }))
        .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
    const cutoffMs = Date.now() - 60 * 60_000;
    for (const candidate of candidates.slice(50)) {
        if (candidate.modifiedAtMs < cutoffMs) {
            rmSync(path.join(cacheDir, candidate.name), {force: true});
        }
    }
}

/** @param {string} tscPath @param {string} version @param {string} project @param {string} buildInfoPath @param {{cold?: boolean}} options @returns {Promise<void>} */
function runProject(tscPath, version, project, buildInfoPath, {cold = false} = {}) {
    if (cold) {
        rmSync(buildInfoPath, {force: true});
    }
    /** @type {Promise<void>} */
    const result = new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
            tscPath,
            '-p',
            project,
            '--noEmit',
            '--incremental',
            '--tsBuildInfoFile',
            buildInfoPath,
        ], {stdio: 'inherit'});
        activeChildren.add(child);
        child.on('error', error => {
            activeChildren.delete(child);
            terminateActiveChildren(child);
            reject(new Error(
                `Could not typecheck ${project} with TypeScript ${version}.`,
                {cause: error},
            ));
        });
        child.on('close', (status, signal) => {
            activeChildren.delete(child);
            if (status === 0) {
                resolve();
                return;
            }
            terminateActiveChildren(child);
            reject(new Error(
                signal
                    ? `TypeScript ${version} typecheck for ${project} exited after signal ${signal}.`
                    : `TypeScript ${version} typecheck for ${project} failed with status ${status ?? 1}.`,
            ));
        });
    });
    return result;
}

/** @type {Set<import('node:child_process').ChildProcess>} */
const activeChildren = new Set();

/** @param {import('node:child_process').ChildProcess} except */
function terminateActiveChildren(except) {
    for (const child of activeChildren) {
        if (child !== except && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
        }
    }
}

/** @returns {Promise<void>} */
async function run() {
    const rawArgs = process.argv.slice(2);
    const cold = rawArgs.includes('--cold') || process.env.EVB_TYPECHECK_COLD === '1';
    const args = rawArgs.filter(argument => argument !== '--cold');
    const {
        tscPath,
        version,
    } = resolveTs7Compiler();
    console.log(`Using TypeScript ${version} native compiler at ${tscPath}`);

    if (args.length === 1 && args[0] === '--version-check') {
        return;
    }

    const projects = parseProjectArguments(args);
    const buildInfoPaths = projects.map(project => getBuildInfoPath(project, version));
    pruneBuildInfoCache(buildInfoPaths);
    const requestedWorkers = Number.parseInt(process.env.EVB_TYPECHECK_WORKERS ?? '2', 10);
    const workerCount = Number.isFinite(requestedWorkers) && requestedWorkers > 0
        ? Math.min(requestedWorkers, projects.length)
        : 1;
    let nextProjectIndex = 0;

    await Promise.all(Array.from({length: workerCount}, async () => {
        while (nextProjectIndex < projects.length) {
            const projectIndex = nextProjectIndex;
            nextProjectIndex += 1;
            const project = projects[projectIndex];
            const buildInfoPath = buildInfoPaths[projectIndex];
            if (!project || !buildInfoPath) {
                return;
            }
            await runProject(
                tscPath,
                version,
                project,
                buildInfoPath,
                {cold},
            );
        }
    }));
}

try {
    await run();
} catch (error) {
    console.error(getCliErrorMessage(error));
    process.exit(1);
}
