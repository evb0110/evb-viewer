import {
    chmod,
    mkdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
    NativeToolProtocolCapabilityError,
    NativeToolProtocolVersionError,
    runNativeToolCommand,
    verifyNativeToolProtocol,
} from '@electron/native-tools/runNativeToolCommand';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';

const probeRoots: string[] = [];
let activeController: AbortController | null = null;
let activeOperation: Promise<unknown> | null = null;
let activeChildPid: number | null = null;

afterEach(async () => {
    activeController?.abort(new Error('protocol handshake test cleanup'));
    await activeOperation?.catch(() => undefined);
    if (activeChildPid !== null) {
        try {
            process.kill(activeChildPid, 'SIGKILL');
        } catch {
            // The child already exited.
        }
    }
    activeController = null;
    activeOperation = null;
    activeChildPid = null;
    await Promise.all(probeRoots.splice(0).map(root => rm(root, {
        recursive: true,
        force: true,
    })));
});

describe('protocol handshake cancellation', () => {
    it('kills a sleeping --protocol-version helper before the caller rejects', async () => {
        const root = join(tmpdir(), `evb-protocol-cancel-${process.pid}-${Date.now()}`);
        const helper = join(root, 'evb-pdf-page-ops');
        const pidFile = join(root, 'child.pid');
        probeRoots.push(root);
        await mkdir(root, {recursive: true});
        await writeFile(helper, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
if (process.argv[2] === '--protocol-version') setTimeout(() => {}, 60_000);
else process.stdout.write('1\\n');
`);
        await chmod(helper, 0o755);

        const controller = new AbortController();
        const operation = runNativeToolCommand(helper, ['page-sizes'], {
            signal: controller.signal,
            timeoutMs: 60_000,
        });
        void operation.catch(() => undefined);
        activeController = controller;
        activeOperation = operation;
        let childPid: number | null = null;
        const readinessDeadline = Date.now() + 5_000;
        while (Date.now() < readinessDeadline) {
            try {
                childPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
                if (Number.isInteger(childPid) && childPid > 0) break;
            } catch {
                // The helper has not reached its handshake yet.
            }
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(childPid).toBeTypeOf('number');
        activeChildPid = childPid;
        controller.abort(new Error('acceptance cancellation'));

        const exitDeadline = Date.now() + 5_000;
        let aliveAtSettlement = true;
        while (Date.now() < exitDeadline) {
            try {
                process.kill(childPid!, 0);
            } catch {
                aliveAtSettlement = false;
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(aliveAtSettlement).toBe(false);
        await expect(operation).rejects.toThrow('acceptance cancellation');
    });

    it('negotiates the legacy integer handshake and gates optional warning events', async () => {
        const root = join(tmpdir(), `evb-protocol-capability-${process.pid}-${Date.now()}`);
        const helper = join(root, 'evb-scan-cleanup');
        probeRoots.push(root);
        await mkdir(root, {recursive: true});
        await writeFile(helper, `#!/usr/bin/env node
if (process.argv[2] === '--protocol-version') process.stdout.write('9\\n');
`);
        await chmod(helper, 0o755);

        await expect(verifyNativeToolProtocol(helper)).resolves.toEqual({
            protocolVersion: 9,
            capabilities: ['manifest-v3'],
        });
        await expect(runNativeToolCommand(helper, [], {requiredCapabilities: ['structured-warning-events']})).rejects.toBeInstanceOf(NativeToolProtocolCapabilityError);
    });

    it('rejects malformed structured capability fields with a typed error', async () => {
        const root = join(tmpdir(), `evb-protocol-malformed-${process.pid}-${Date.now()}`);
        const helper = join(root, 'evb-scan-cleanup');
        probeRoots.push(root);
        await mkdir(root, {recursive: true});
        await writeFile(helper, `#!/usr/bin/env node
if (process.argv[2] === '--protocol-version') process.stdout.write(JSON.stringify({protocolVersion: 10, capabilities: [7]}) + '\\n');
`);
        await chmod(helper, 0o755);

        await expect(verifyNativeToolProtocol(helper)).rejects.toBeInstanceOf(NativeToolProtocolCapabilityError);
        await expect(verifyNativeToolProtocol(helper)).rejects.not.toBeInstanceOf(NativeToolProtocolVersionError);
    });
});
