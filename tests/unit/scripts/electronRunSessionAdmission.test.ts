import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    canProceedAfterStaleArtifactCleanup,
    type IStaleSessionArtifactsCleanupResult,
} from '@scripts/electron-run/electronRunSessionArtifacts';

function cleanupResult(
    kind: IStaleSessionArtifactsCleanupResult['kind'],
): IStaleSessionArtifactsCleanupResult {
    return {
        retained: kind !== 'clean',
        kind,
        reason: kind === 'preserved-recovery'
            ? 'workspace recovery evidence is present; retained for later recovery'
            : null,
    };
}

describe('stale session admission', () => {
    it('admits preserved recovery bytes after cleanup proves ownership is gone', () => {
        expect(canProceedAfterStaleArtifactCleanup(cleanupResult('preserved-recovery'))).toBe(true);
    });

    it('refuses live or ambiguous ownership retained by cleanup', () => {
        expect(canProceedAfterStaleArtifactCleanup(cleanupResult('retained-unsafe'))).toBe(false);
    });

    it('admits a clean session', () => {
        expect(canProceedAfterStaleArtifactCleanup(cleanupResult('clean'))).toBe(true);
    });
});
