import {
    formatLauncherElapsed,
    logLauncher,
} from '@scripts/electron-run/terminalLog';

/**
 * Startup milestones share the launcher's process clock, so a session start
 * reads as one monotonic timeline across Nuxt, Electron and CDP attach.
 */
export function createStartupLogger(startedAt?: number) {
    return (message: string) => {
        logLauncher('info', 'startup', message, {elapsed: formatLauncherElapsed(startedAt)});
    };
}
