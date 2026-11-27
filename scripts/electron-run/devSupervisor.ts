import {getCurrentSessionName} from '@scripts/electron-run/electronRunSessionPaths';
import {startControlledSession} from '@scripts/electron-run/sessionController';
export async function devSupervisor(forceClean = false) {
    if (getCurrentSessionName().startsWith('e2e-')) {
        throw new Error('The developer supervisor cannot own an ephemeral E2E session');
    }
    await startControlledSession(forceClean);
}
