import { screen } from 'electron';
import { config } from '@electron/config';
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
 * Where a new window opens, and what its preload must know before the
 * renderer's first layout, which an IPC round trip would answer too late.
 * The window opens centred in the primary display's work area, where Electron
 * puts a window given no position. Giving the position explicitly lets the
 * startup arguments describe the display the window opens on.
 */
export function createWindowStartupOptions() {
    const {workArea} = screen.getPrimaryDisplay();
    const width = Math.min(config.window.width, workArea.width);
    const height = Math.min(config.window.height, workArea.height);
    const bounds = {
        x: workArea.x + Math.round((workArea.width - width) / 2),
        y: workArea.y + Math.round((workArea.height - height) / 2),
        width,
        height,
    };
    return {
        bounds,
        additionalArguments: [
            encodeHostResourceProfileArgument(getHostResourceProfileSnapshot()),
            encodeDiagnosticsPolicyArgument(getMainDiagnosticsPreference()),
            encodeHostEnvironmentArgument(bounds),
            ...encodeUiScalePreferenceArgument(),
            ...(runtimeConfig.startupTrace ? ['--evb-startup-trace'] : []),
            ...(runtimeConfig.automationRendererHooksEnabled ? ['--evb-renderer-file-open-helper'] : []),
        ],
    };
}
