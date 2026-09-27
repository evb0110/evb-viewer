import {
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({userDataPath: ''}));
vi.mock('electron', () => ({app: {getPath: () => mocks.userDataPath}}));

describe('updateHealthMarker', () => {
    beforeEach(() => {
        mocks.userDataPath = mkdtempSync(join(tmpdir(), 'evb-update-health-'));
    });

    afterEach(() => {
        rmSync(mocks.userDataPath, {
            force: true,
            recursive: true,
        });
        vi.resetModules();
    });

    it('tracks failed startups until renderer readiness clears the pending marker', async () => {
        const marker = await import('@electron/updateHealthMarker');
        const markerPath = join(mocks.userDataPath, 'update-health.json');

        await marker.markUpdateInstallPending('2.0.0');
        await expect(marker.recordPendingUpdateStartup('2.0.0')).resolves.toMatchObject({startupAttempts: 1});
        await expect(marker.recordPendingUpdateStartup('2.0.0')).resolves.toMatchObject({startupAttempts: 2});
        await expect(marker.recordPendingUpdateStartup('2.0.0')).resolves.toMatchObject({startupAttempts: 3});
        expect(JSON.parse(readFileSync(markerPath, 'utf-8'))).toMatchObject({pendingVersion: '2.0.0'});
        await expect(marker.getSuppressedUpdateVersion('1.0.0')).resolves.toBe('2.0.0');
        await expect(marker.getSuppressedUpdateVersion('2.0.0')).resolves.toBeNull();

        await expect(marker.markPendingUpdateHealthy('1.0.0')).resolves.toBe(false);
        await expect(marker.markPendingUpdateHealthy(`2.0.0+${'a'.repeat(40)}`)).resolves.toBe(true);
        await expect(marker.recordPendingUpdateStartup('2.0.0')).resolves.toBeNull();
    });

    it('reads a persisted marker into the startup result and strips unknown fields', async () => {
        const markerPath = join(mocks.userDataPath, 'update-health.json');
        writeFileSync(markerPath, JSON.stringify({
            version: 1,
            pendingVersion: '2.0.0',
            installRequestedAt: 1234,
            startupAttempts: 2,
            futureField: 'ignored',
        }));
        const marker = await import('@electron/updateHealthMarker');

        await expect(marker.recordPendingUpdateStartup('1.0.0')).resolves.toEqual({
            version: 1,
            pendingVersion: '2.0.0',
            installRequestedAt: 1234,
            startupAttempts: 3,
            installationApplied: false,
        });
        expect(JSON.parse(readFileSync(markerPath, 'utf-8'))).toEqual({
            version: 1,
            pendingVersion: '2.0.0',
            installRequestedAt: 1234,
            startupAttempts: 3,
        });
    });

    it('ignores a malformed marker without quarantining it', async () => {
        const markerPath = join(mocks.userDataPath, 'update-health.json');
        writeFileSync(markerPath, '{malformed');
        const marker = await import('@electron/updateHealthMarker');

        await expect(marker.recordPendingUpdateStartup('1.0.0')).resolves.toBeNull();
        expect(readFileSync(markerPath, 'utf-8')).toBe('{malformed');
        expect(readdirSync(mocks.userDataPath)).toEqual(['update-health.json']);
    });

    it('counts relaunches of the old version when the installer failed to replace the app', async () => {
        const marker = await import('@electron/updateHealthMarker');

        await marker.markUpdateInstallPending('2.0.0');
        await expect(marker.recordPendingUpdateStartup('1.0.0')).resolves.toMatchObject({
            installationApplied: false,
            pendingVersion: '2.0.0',
            startupAttempts: 1,
        });
        await marker.recordPendingUpdateStartup('1.0.0');
        await marker.recordPendingUpdateStartup('1.0.0');

        await expect(marker.getSuppressedUpdateVersion('1.0.0')).resolves.toBe('2.0.0');
    });

    it('recognizes development build metadata as the pending installation', async () => {
        const marker = await import('@electron/updateHealthMarker');

        await marker.markUpdateInstallPending('2.0.0');
        await expect(marker.recordPendingUpdateStartup(`2.0.0+${'a'.repeat(40)}`)).resolves
            .toMatchObject({installationApplied: true});
    });

    it('does not suppress the running pending version when its marker uses a release tag', async () => {
        const marker = await import('@electron/updateHealthMarker');

        await marker.markUpdateInstallPending(`v2.0.0+${'a'.repeat(40)}`);
        await marker.recordPendingUpdateStartup('1.0.0');
        await marker.recordPendingUpdateStartup('1.0.0');
        await marker.recordPendingUpdateStartup('1.0.0');

        await expect(marker.getSuppressedUpdateVersion('2.0.0')).resolves.toBeNull();
    });

    it('expires suppression so a transient installer failure can be retried', async () => {
        const marker = await import('@electron/updateHealthMarker');
        const installedAt = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(installedAt);

        await marker.markUpdateInstallPending('2.0.0');
        await marker.recordPendingUpdateStartup('1.0.0');
        await marker.recordPendingUpdateStartup('1.0.0');
        await marker.recordPendingUpdateStartup('1.0.0');
        await expect(marker.getSuppressedUpdateVersion('1.0.0')).resolves.toBe('2.0.0');

        clock.mockReturnValue(installedAt + marker.UPDATE_SUPPRESSION_TTL_MS);
        await expect(marker.getSuppressedUpdateVersion('1.0.0')).resolves.toBeNull();
        await expect(marker.recordPendingUpdateStartup('1.0.0')).resolves.toBeNull();
        clock.mockRestore();
    });

    it('preserves failure history when the same downloaded version is retried', async () => {
        const marker = await import('@electron/updateHealthMarker');

        await marker.markUpdateInstallPending('2.0.0');
        await marker.recordPendingUpdateStartup('1.0.0');
        await marker.recordPendingUpdateStartup('1.0.0');
        await marker.markUpdateInstallPending('2.0.0');
        await expect(marker.recordPendingUpdateStartup('1.0.0')).resolves.toMatchObject({
            pendingVersion: '2.0.0',
            startupAttempts: 3,
        });
        await expect(marker.getSuppressedUpdateVersion('1.0.0')).resolves.toBe('2.0.0');

        await marker.markUpdateInstallPending('3.0.0');
        await expect(marker.recordPendingUpdateStartup('1.0.0')).resolves.toMatchObject({
            pendingVersion: '3.0.0',
            startupAttempts: 1,
        });
    });

    it('serializes startup accounting and renderer readiness without resurrecting a healthy marker', async () => {
        const marker = await import('@electron/updateHealthMarker');

        await marker.markUpdateInstallPending('2.0.0');
        const startup = marker.recordPendingUpdateStartup('2.0.0');
        const healthy = marker.markPendingUpdateHealthy('2.0.0');

        await expect(startup).resolves.toMatchObject({
            installationApplied: true,
            startupAttempts: 1,
        });
        await expect(healthy).resolves.toBe(true);
        await expect(marker.recordPendingUpdateStartup('2.0.0')).resolves.toBeNull();
    });
});
