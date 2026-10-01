import { runtimeConfig } from '@electron/runtimeConfig';
import {
    encodeHostResourceProfileArgument,
    getHostResourceProfileSnapshot,
} from '@electron/resources/hostResourceProfile';
import { getMainDiagnosticsPreference } from '@electron/features/diagnostics/public';
import { encodeDiagnosticsPolicyArgument } from '@electron/platform-ipc/coreContract';
import { encodeHostEnvironmentArgument } from '@electron/hostEnvironment';
import { encodeUiScalePreferenceArgument } from '@electron/settings';

/**
 * What a window's preload must know before the renderer's first layout, which
 * an IPC round trip would answer too late. Passed as `additionalArguments`.
 */
export function createPreloadStartupArguments() {
    return [
        encodeHostResourceProfileArgument(getHostResourceProfileSnapshot()),
        encodeDiagnosticsPolicyArgument(getMainDiagnosticsPreference()),
        encodeHostEnvironmentArgument(),
        ...encodeUiScalePreferenceArgument(),
        ...(runtimeConfig.startupTrace ? ['--evb-startup-trace'] : []),
        ...(runtimeConfig.automationUserDataDir
            && runtimeConfig.automationSessionName
            && runtimeConfig.automationEnableRendererFileOpenHelper
            ? ['--evb-renderer-file-open-helper']
            : []),
    ];
}
