#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWorkspacePackageRoots } from './workspace-roots.mjs';
import { withTypecheckNodeHeap } from './typecheckNodeEnv.mjs';

/** @type {Record<string, string>} */
export const TYPECHECK_EXEMPT_WORKSPACE_PACKAGES = {
    'packages/electron-worker-bundles': 'JavaScript-only worker bundle manifest package with checked-in type declarations.',
    'packages/node-runtime': 'Node runtime helpers are typechecked through root TypeScript projects.',
};

/** @typedef {(command: string, args: string[], options?: import('node:child_process').ExecFileSyncOptions) => void} TRunCommand */
/** @typedef {{args: string[], command: string}} ITypecheckCommand */
/** @typedef {{packageRoot: string, reason: string}} ITypecheckSkip */

/** @param {string} command @param {string[]} args @param {import('node:child_process').ExecFileSyncOptions} [options] */
function defaultRun(command, args, options = {}) {
    execFileSync(command, args, {
        cwd: process.cwd(),
        stdio: 'inherit',
        ...options,
    });
}

/** @param {string} filePath @returns {string} */
function toPosixPath(filePath) {
    return filePath.split(path.sep).join('/');
}

/** @param {{cold?: boolean, projectRoot?: string, projects?: string[]}} options @returns {{command: ITypecheckCommand, skipped: ITypecheckSkip[]}} */
export function getWorkspacePackageTypecheckPlan({
    cold = false,
    projectRoot = process.cwd(),
    projects = [],
} = {}) {
    const effectiveCold = cold || process.env.EVB_GATE_NO_CACHE === '1';
    const args = [
        'scripts/run-ts7-typecheck.mjs',
        ...(effectiveCold ? ['--cold'] : []),
        ...projects.flatMap(project => [
            '-p',
            project,
        ]),
    ];
    /** @type {ITypecheckSkip[]} */
    const skipped = [];

    for (const packageRoot of getWorkspacePackageRoots({ projectRoot })) {
        const tsconfigPath = toPosixPath(path.join(packageRoot, 'tsconfig.json'));
        if (existsSync(path.join(projectRoot, tsconfigPath))) {
            args.push('-p', tsconfigPath);
            continue;
        }

        const reason = TYPECHECK_EXEMPT_WORKSPACE_PACKAGES[packageRoot];
        if (reason) {
            skipped.push({
                packageRoot,
                reason,
            });
            continue;
        }

        throw new Error(
            `Workspace package ${packageRoot} is missing tsconfig.json and has no typecheck exemption.`,
        );
    }

    return {
        command: {
            args,
            command: 'node',
        },
        skipped,
    };
}

/** @param {{cold?: boolean, projectRoot?: string, projects?: string[], runCommand?: TRunCommand, stdout?: NodeJS.WriteStream}} options */
export function runWorkspacePackageTypecheck({
    cold = false,
    projectRoot = process.cwd(),
    projects = [],
    runCommand = defaultRun,
    stdout = process.stdout,
} = {}) {
    const {
        command,
        skipped,
    } = getWorkspacePackageTypecheckPlan({
        cold: cold || process.env.EVB_GATE_NO_CACHE === '1',
        projectRoot,
        projects,
    });

    if (skipped.length > 0) {
        stdout.write(
            `${skipped.map(({
                packageRoot,
                reason,
            }) => (
                `Skipping workspace package typecheck for ${packageRoot}: ${reason}`
            )).join('\n')}\n`,
        );
    }

    runCommand(command.command, command.args, {
        cwd: projectRoot,
        env: withTypecheckNodeHeap(),
        stdio: 'inherit',
    });
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    const args = process.argv.slice(2);
    const cold = args.includes('--cold');
    const projectArgs = args.filter(argument => argument !== '--cold');
    const projects = [];
    for (let index = 0; index < projectArgs.length; index += 2) {
        const project = projectArgs[index + 1];
        if (projectArgs[index] !== '-p' || project === undefined) {
            throw new Error('Usage: node scripts/run-workspace-package-typecheck.mjs [--cold] [-p <tsconfig> ...]');
        }
        projects.push(project);
    }
    runWorkspacePackageTypecheck({
        cold,
        projects,
    });
}
