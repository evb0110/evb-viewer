import type { IWindowsTestWorkerHeartbeat } from '@scripts/windows-test/contracts/windowsTestContracts';

export function isFreshInteractiveWorkerHeartbeat(
    bootIdText: string | null,
    heartbeat: IWindowsTestWorkerHeartbeat | null,
    startedAtMs: number,
): boolean {
    if (bootIdText === null || heartbeat === null) {
        return false;
    }
    const bootId = bootIdText.trim();
    const heartbeatUpdatedAtMs = Date.parse(heartbeat.updatedAt);
    return bootId.length > 0
        && heartbeat.bootId === bootId
        && heartbeat.guestTestMarker.length > 0
        && heartbeat.worker.interactive
        && heartbeat.worker.sessionId !== 0
        && heartbeat.worker.inputDesktop === 'Default'
        && !heartbeat.locked
        && Number.isFinite(startedAtMs)
        && Number.isFinite(heartbeatUpdatedAtMs)
        && heartbeatUpdatedAtMs >= startedAtMs;
}
