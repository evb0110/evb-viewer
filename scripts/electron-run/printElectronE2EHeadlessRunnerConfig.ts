import {resolveElectronE2EHeadlessRunnerConfig} from '@scripts/electron-run/electronRunLaunchConfig';

const platform = process.argv[2] as NodeJS.Platform | undefined;
if (!platform) {
    throw new Error('A Node.js platform name is required');
}

const config = resolveElectronE2EHeadlessRunnerConfig(platform);
process.stdout.write(
    [
        config.environment.EVB_AUTOMATION_NO_FOCUS,
        config.environment.EVB_AUTOMATION_HIDE_WINDOW,
        config.environment.EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE,
        config.hostDisplayIsolation,
    ].join('\t') + '\n',
);
