// Owner process for a real E2E session. It starts the session through the same
// detached path as startElectronE2ESession, reports readiness, and then stays
// alive until a test ends it, so the test can observe what the session does
// when its owner dies without stopping it.
import { buildElectronE2EAutomationEnv } from '@scripts/electron-run/electronRunLaunchConfig';
import { assertE2ESessionName } from '@scripts/electron-run/electronRunE2ESessionPrune';
import { buildStrictE2ERunEnv } from '@scripts/electron-run/electronRunRunId';
import { setCurrentSessionName } from '@scripts/electron-run/electronRunSessionPaths';
import { startSessionDetached } from '@scripts/electron-run/startSessionDetached';

setCurrentSessionName(assertE2ESessionName(process.argv[2] ?? ''));
await startSessionDetached({
    env: {
        ...buildElectronE2EAutomationEnv(process.env),
        ...buildStrictE2ERunEnv(process.env),
    },
    owner: 'e2e',
});
process.stdout.write('ready\n');
setInterval(() => {}, 60_000);
