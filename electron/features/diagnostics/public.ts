export {
    captureMainFailure,
    type IMainFailureInput,
} from '@electron/utils/captureMainFailure';
export {
    consumeStartupCrashMarker,
    getMainDiagnosticsPreference,
    installStartupCrashMarker,
    setMainDiagnosticsPreference,
} from '@electron/features/diagnostics/sentry';
export { readDiagnosticsPreferenceSync } from '@electron/features/diagnostics/readDiagnosticsPreferenceSync';
