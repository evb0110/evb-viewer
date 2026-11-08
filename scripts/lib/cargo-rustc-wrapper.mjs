#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {fstatSync} from 'node:fs';

const [
    rustc,
    ...args
] = process.argv.slice(2);
if (!rustc) throw new Error('Cargo did not supply a compiler');
const flags = JSON.parse(process.env.EVB_CARGO_RUSTFLAGS || '[]');
const target = args.find(arg => arg.startsWith('--target='))?.slice(9)
    ?? (args.includes('--target') ? args[args.indexOf('--target') + 1] : undefined);
const wasm = target?.startsWith('wasm32') === true;
if (target === undefined || target.includes('apple-darwin')) flags.push(...JSON.parse(process.env.EVB_CARGO_APPLE_RUSTFLAGS || '[]'));
if (wasm) flags.push(...JSON.parse(process.env.EVB_CARGO_WASM_RUSTFLAGS || '[]'));
const inner = process.env.EVB_CARGO_INNER_WRAPPER;
/** @type {Array<number | import('node:child_process').IOType>} */
const stdio = [
    'inherit',
    'inherit',
    'inherit',
];
const jobserver = process.env.CARGO_MAKEFLAGS?.match(/--jobserver-(?:auth|fds)=(\d+),(\d+)/);
for (const fd of jobserver?.slice(1).map(Number) || []) {
    try {
        fstatSync(fd);
        while (stdio.length <= fd) stdio.push('ignore');
        stdio[fd] = fd;
    } catch {
        // Cargo may have closed a jobserver descriptor before starting the wrapper.
    }
}
const command = inner || rustc;
const commandArgs = inner ? [
    rustc,
    ...args,
    ...flags,
] : [
    ...args,
    ...flags,
];
const batch = process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command);
/** @param {string} value */
const quote = value => `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`;
const result = batch
    ? spawnSync(process.env.ComSpec || 'cmd.exe', [
        '/d',
        '/s',
        '/c',
        `"${[
            command,
            ...commandArgs,
        ].map(quote).join(' ')}"`,
    ], {
        stdio,
        windowsVerbatimArguments: true,
    })
    : spawnSync(command, commandArgs, {stdio});
if (result.error) console.error(result.error);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
