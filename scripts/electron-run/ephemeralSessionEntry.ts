import { assertE2ESessionName } from '@scripts/electron-run/electronRunE2ESessionPrune';
import { setCurrentSessionName } from '@scripts/electron-run/electronRunSessionPaths';
import { startControlledSession } from '@scripts/electron-run/sessionController';
const sessionName = process.argv[2];
if (!sessionName) {
    throw new Error('Ephemeral session entry requires a generated E2E session name');
}
setCurrentSessionName(assertE2ESessionName(sessionName));
await startControlledSession(false, {ownerLease: process.stdin});
