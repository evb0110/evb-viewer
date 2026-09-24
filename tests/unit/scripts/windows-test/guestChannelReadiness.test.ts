import {
    mkdtemp,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    expect,
    it,
    vi,
} from 'vitest';
import { windowsTestGuestLayout } from '@scripts/windows-test/contracts/windowsTestPaths';
import { createUtmctlGuestChannel } from '@scripts/windows-test/host/guestChannel';
import { createUtmctlClient } from '@scripts/windows-test/host/utmctlClient';

it.each([
    false,
    true,
])('uses read-only file transfer for readiness, failure=%s', async (transferFails) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'evb-qga-ready-'));
    try {
        const runner = { run: vi.fn(() => { throw new Error('Unexpected guest execution'); }) };
        const client = createUtmctlClient({
            runner,
            utmctlPath: 'utmctl',
        });
        const pull = vi.fn(async (_vmId: string, guestPath: string, hostPath: string) => {
            expect(guestPath).toBe(windowsTestGuestLayout.markerFile);
            if (transferFails) {
                await writeFile(hostPath, 'partial transfer');
                throw new Error('Guest agent is unavailable');
            }
            await writeFile(hostPath, JSON.stringify({
                imageId: 'lab',
                guestTestMarker: 'marker',
            }));
        });
        client.pullFile = pull;
        const guest = createUtmctlGuestChannel({
            client,
            temporaryFilePath: label => path.join(directory, label),
        });

        await expect(guest.ping('test-vm', 1_000)).resolves.toBe(!transferFails);
        expect(pull).toHaveBeenCalledOnce();
        expect(runner.run).not.toHaveBeenCalled();
        expect(await readdir(directory)).toEqual([]);
    } finally {
        await rm(directory, {
            recursive: true,
            force: true,
        });
    }
});
