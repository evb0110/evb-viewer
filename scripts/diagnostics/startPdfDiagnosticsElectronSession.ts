import {
    type IElectronE2ESession,
    startElectronE2ESession,
    startHostVisibleElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';

export type {IElectronE2ESession};

export async function startPdfDiagnosticsElectronSession(scenarioName: string): Promise<IElectronE2ESession> {
    return startElectronE2ESession(`diagnostics-${scenarioName}-${Date.now()}`);
}

/**
 * Starts a real host-visible window for operator-run viewport diagnostics.
 * Vitest suites must use their hidden fixture or the isolated lifecycle lane.
 */
export async function startHostVisiblePdfDiagnosticsElectronSession(scenarioName: string): Promise<IElectronE2ESession> {
    return startHostVisibleElectronE2ESession(`diagnostics-visible-${scenarioName}-${Date.now()}`);
}
