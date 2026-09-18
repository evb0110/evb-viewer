import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { isWindowsTestEvidenceManifest } from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    buildEvidenceManifest,
    createBoundedLog,
    evidenceManifestSha256,
    serializeEvidenceManifest,
} from '@scripts/windows-test/guest/guestEvidence';
import {
    createNodeGuestFileSystem,
    sha256HexOfText,
} from '@scripts/windows-test/guest/guestRuntime';

const fs = createNodeGuestFileSystem();
const runId = '20260904T120000Z-0123456789ab';

describe('guest evidence manifest', () => {
    it('hashes every collected file and stays stable across runs', async () => {
        const evidenceDir = await mkdtemp(path.join(tmpdir(), 'evb-guest-evidence-'));
        await fs.writeText(`${evidenceDir}/win-save-01/summary.json`, '{"ok":true}');
        await fs.writeText(`${evidenceDir}/screenshot.txt`, 'placeholder');

        const manifest = await buildEvidenceManifest({
            ...fs,
            readBytes: async () => { throw new Error('Evidence hashing must stream large videos'); },
        }, runId, evidenceDir, '/');
        expect(isWindowsTestEvidenceManifest(manifest)).toBe(true);
        expect(manifest.entries.map(entry => entry.relativePath)).toEqual([
            'screenshot.txt',
            'win-save-01/summary.json',
        ]);
        expect(manifest.entries[1]?.sha256).toBe(sha256HexOfText('{"ok":true}'));
        expect(evidenceManifestSha256(manifest)).toBe(sha256HexOfText(serializeEvidenceManifest(manifest)));
        expect(await buildEvidenceManifest(fs, runId, evidenceDir, '/')).toEqual(manifest);
    });

    it('produces an empty manifest for a run that collected nothing', async () => {
        const evidenceDir = await mkdtemp(path.join(tmpdir(), 'evb-guest-evidence-empty-'));
        const manifest = await buildEvidenceManifest(fs, runId, evidenceDir, '/');
        expect(manifest.entries).toEqual([]);
        expect(isWindowsTestEvidenceManifest(manifest)).toBe(true);
    });
});

describe('bounded worker log', () => {
    it('keeps every line while it fits', () => {
        const log = createBoundedLog(1_024);
        log.append('first');
        log.append('second');
        expect(log.text()).toBe('first\nsecond\n');
        expect(log.state().truncated).toBe(false);
    });

    it('stops writing and says so once the limit is reached', () => {
        const log = createBoundedLog(12);
        log.append('0123456789');
        log.append('this line does not fit');
        log.append('neither does this one');
        expect(log.state().truncated).toBe(true);
        expect(log.text()).toContain('[log truncated');
        expect(log.text().split('\n').filter(line => line.includes('neither'))).toHaveLength(0);
    });
});
