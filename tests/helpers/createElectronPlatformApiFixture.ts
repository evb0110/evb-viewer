import { ELECTRON_PLATFORM_MANIFEST } from '@contracts/platformApi';
import type { IElectronAPI } from '@contracts/electronApi';
import type { IDiagnosticsRendererCapability } from '@contracts/diagnostics/diagnosticsCapability';
import {
    createPlatformApiFixture,
    type TDeepPartial,
    type TPlatformApiFixtureOverrides,
} from '@tests/helpers/createPlatformApiFixture';

export type TElectronPlatformApiFixtureOverrides = TPlatformApiFixtureOverrides & {diagnostics?: TDeepPartial<IDiagnosticsRendererCapability>;};

const DEFAULT_DIAGNOSTICS: IDiagnosticsRendererCapability = {
    startupPolicy: Object.freeze({mode: 'unknown'}),
    sendRecord: () => undefined,
    onDebugLog: () => () => undefined,
};

export function createElectronPlatformApiFixture<TOverrides extends TElectronPlatformApiFixtureOverrides = TElectronPlatformApiFixtureOverrides>(
    overrides: TOverrides = {} as TOverrides,
) {
    const diagnosticsOverrides = overrides.diagnostics;
    const platformOverrides = {...overrides};
    Reflect.deleteProperty(platformOverrides, 'diagnostics');
    const platformApi = createPlatformApiFixture({
        backend: 'electron',
        manifest: ELECTRON_PLATFORM_MANIFEST,
        overrides: platformOverrides,
    });
    if (platformApi.updates === undefined) {
        throw new TypeError('Missing Electron platform API capability updates');
    }
    const electronApi: IElectronAPI = {
        ...platformApi,
        diagnostics: {
            startupPolicy: {
                ...DEFAULT_DIAGNOSTICS.startupPolicy,
                ...diagnosticsOverrides?.startupPolicy,
            },
            sendRecord: diagnosticsOverrides?.sendRecord ?? DEFAULT_DIAGNOSTICS.sendRecord,
            onDebugLog: diagnosticsOverrides?.onDebugLog ?? DEFAULT_DIAGNOSTICS.onDebugLog,
        },
        updates: platformApi.updates,
    };
    return electronApi as IElectronAPI & TOverrides;
}
