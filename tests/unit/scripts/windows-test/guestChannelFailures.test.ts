import {
    expect,
    it,
} from 'vitest';
import { createUtmctlGuestChannel } from '@scripts/windows-test/host/guestChannel';
import { createUtmctlClient } from '@scripts/windows-test/host/utmctlClient';
import type { IUtmctlExecOutcome } from '@scripts/windows-test/host/utmctlClient';

function channel(outcome: IUtmctlExecOutcome) {
    const client = createUtmctlClient({
        runner: {run: () => {
            throw new Error('Unexpected real transport call');
        }},
        utmctlPath: 'utmctl',
    });
    client.exec = () => Promise.resolve(outcome);
    client.pushFile = () => Promise.resolve();
    return createUtmctlGuestChannel({
        client,
        temporaryFilePath: () => '/unused-in-this-test',
    });
}

const timeout: IUtmctlExecOutcome = {
    exitCode: null,
    stdout: '',
    stderr: '',
    timedOut: true,
    signal: null,
    transportFailure: 'timeout',
};

it('reports a transport timeout even when the guest produced no stderr', async () => {
    await expect(channel(timeout).ensureDirectory('unused', 'C:\\EVBViewerTests\\staging', 120_000))
        .rejects.toThrow('transport timeout');
});

it('does not report a hash mismatch when the verifier never completed', async () => {
    await expect(channel(timeout).verifyStagedFileHash('unused', 'C:\\EVBViewerTests\\staging\\file', 'a'.repeat(64), 120_000))
        .rejects.toThrow('transport timeout');
});

it('preserves a completed hash mismatch as a failed verification', async () => {
    const guest = channel({
        ...timeout,
        exitCode: 3,
        stdout: `mismatch ${'b'.repeat(64)}`,
        timedOut: false,
        transportFailure: null,
    });
    await expect(guest.verifyStagedFileHash('unused', 'C:\\EVBViewerTests\\staging\\file', 'a'.repeat(64), 120_000))
        .resolves.toBe(false);
});
