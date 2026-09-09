#!/usr/bin/env node

import {spawn} from 'node:child_process';
import {
    closeSync,
    existsSync,
    openSync,
    readFileSync,
    readlinkSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import {
    basename, join, resolve,
} from 'node:path';

const fixtureScriptPath = resolve(process.argv[1]);
const fixtureTimeoutMs = 15_000;
const [
    role,
    rootArgument,
    token,
] = process.argv.slice(2);
const root = rootArgument ? resolve(rootArgument) : '';

function fail(message) {
    throw new Error(`[project8-process-proof] ${message}`);
}

if (!role || !root || !token) {
    fail('usage: <worker|native-parent|native-descendant> <root> <token>');
}

if (![
    'worker',
    'native-parent',
    'native-descendant',
].includes(role)) {
    fail(`unknown role ${role}`);
}

if (!/^evb-project8-process-proof-[A-Za-z0-9-]+$/u.test(basename(root))) {
    fail(`refusing fixture root outside the task-owned temp namespace: ${root}`);
}

if (!/^[A-Za-z0-9._-]+$/u.test(token)) {
    fail('fixture token contains unsafe characters');
}

if (process.env.EVB_PROJECT8_PROOF_TOKEN !== token) {
    fail('fixture token does not match its task-owned environment');
}

function markerPath(name) {
    if (!/^[a-z0-9-]+(?:\.json)?$/u.test(name)) {
        fail(`invalid marker name ${name}`);
    }
    return join(root, name);
}

function writeJson(name, value) {
    const destination = markerPath(name);
    const temporary = `${destination}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, 'utf8');
    renameSync(temporary, destination);
}

function hasMarker(name) {
    return existsSync(markerPath(name));
}

function readLinuxIdentity(currentRole) {
    const stat = readFileSync(`/proc/${String(process.pid)}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) {
        fail(`cannot parse /proc stat for ${currentRole}`);
    }
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/u);
    const command = readFileSync(`/proc/${String(process.pid)}/cmdline`, 'utf8')
        .split('\0')
        .filter(Boolean)
        .join(' ');
    return {
        command,
        executable: readlinkSync(`/proc/${String(process.pid)}/exe`),
        fixtureRoot: root,
        pgid: Number(fields[2]),
        pid: process.pid,
        ppid: Number(fields[1]),
        role: currentRole,
        startTime: fields[19],
        token,
    };
}

function startTimeout() {
    return setTimeout(() => {
        writeJson('fixture-timeout.json', {
            pid: process.pid,
            role,
            token,
        });
        process.exit(70);
    }, fixtureTimeoutMs);
}

function spawnFixtureProcess(childRole, detached) {
    const child = spawn(process.execPath, [
        fixtureScriptPath,
        childRole,
        root,
        token,
    ], {
        cwd: root,
        detached,
        env: {
            ...process.env,
            EVB_PROJECT8_PROOF_TOKEN: token,
        },
        stdio: 'ignore',
    });
    if (typeof child.pid !== 'number' || child.pid <= 0) {
        fail(`fixture ${childRole} did not receive a PID`);
    }
    child.on('error', error => {
        writeJson('fixture-error.json', {
            error: error instanceof Error ? error.message : String(error),
            pid: child.pid,
            role: childRole,
            token,
        });
        process.exitCode = 1;
    });
    child.unref();
    return child.pid;
}

function waitForJsonMarker(name, onReady) {
    const timer = setInterval(() => {
        if (!hasMarker(name)) {
            return;
        }
        clearInterval(timer);
        try {
            onReady(JSON.parse(readFileSync(markerPath(name), 'utf8')));
        } catch (error) {
            writeJson('fixture-error.json', {
                error: error instanceof Error ? error.message : String(error),
                marker: name,
                pid: process.pid,
                role,
                token,
            });
            process.exitCode = 1;
        }
    }, 25);
}

function waitForMarker(name, onReady) {
    const timer = setInterval(() => {
        if (!hasMarker(name)) {
            return;
        }
        clearInterval(timer);
        onReady();
    }, 25);
}

function runWorker() {
    const timeout = startTimeout();
    const nativePid = spawnFixtureProcess('native-parent', true);
    writeJson('native-parent-spawned.json', {
        pid: nativePid,
        role: 'native-parent',
        token,
    });
    waitForJsonMarker('native-ready.json', nativeReady => {
        writeJson('worker-ready.json', {
            native: nativeReady,
            worker: readLinuxIdentity('worker'),
            schemaVersion: 1,
            token,
        });
        waitForMarker('release-worker', () => {
            writeJson('worker-exiting.json', {
                pid: process.pid,
                role: 'worker',
                token,
            });
            clearTimeout(timeout);
            process.exit(0);
        });
    });
}

function runNativeParent() {
    const timeout = startTimeout();
    const parentIdentity = readLinuxIdentity('native-parent');
    if (parentIdentity.pgid !== parentIdentity.pid) {
        fail(`native parent was not started in its own process group: pgid=${String(parentIdentity.pgid)} pid=${String(parentIdentity.pid)}`);
    }
    writeJson('native-parent-started.json', {
        identity: parentIdentity,
        schemaVersion: 1,
        token,
    });
    const descendantPid = spawnFixtureProcess('native-descendant', false);
    waitForJsonMarker('descendant-ready.json', descendantReady => {
        writeJson('native-ready.json', {
            descendant: descendantReady,
            identity: parentIdentity,
            schemaVersion: 1,
            token,
        });
        waitForMarker('release-native-parent', () => {
            writeJson('native-parent-exiting.json', {
                descendantPid,
                identity: parentIdentity,
                token,
            });
            clearTimeout(timeout);
            process.exit(0);
        });
    });
}

function runNativeDescendant() {
    const timeout = startTimeout();
    const heldPath = join(root, 'held-native-resource.bin');
    writeFileSync(heldPath, `task-owned-${token}\n`, {flag: 'a'});
    const heldResource = openSync(heldPath, 'a');
    const identity = readLinuxIdentity('native-descendant');
    writeJson('descendant-ready.json', {
        heldPath,
        identity,
        schemaVersion: 1,
        token,
    });
    let stopped = false;
    const stop = reason => {
        if (stopped) {
            return;
        }
        stopped = true;
        writeJson('descendant-stop-requested.json', {
            identity: readLinuxIdentity('native-descendant'),
            reason,
            token,
        });
        closeSync(heldResource);
        writeJson('descendant-stopped.json', {
            pid: process.pid,
            reason,
            role: 'native-descendant',
            token,
        });
        clearTimeout(timeout);
        process.exit(0);
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
    waitForMarker('stop-descendant', () => stop('marker'));
}

try {
    if (role === 'worker') {
        runWorker();
    } else if (role === 'native-parent') {
        runNativeParent();
    } else {
        runNativeDescendant();
    }
} catch (error) {
    try {
        writeJson('fixture-error.json', {
            error: error instanceof Error ? error.message : String(error),
            pid: process.pid,
            role,
            token,
        });
    } finally {
        process.exitCode = 1;
    }
}
