import type { IElectronAPI } from '@contracts/electronApi';
import type { IDiagnosticsRendererCapability } from '@contracts/diagnostics/diagnosticsPreference';
import {
    createPlatformApiFixture,
    type TDeepPartial,
    type TPlatformApiFixtureOverrides,
} from '@tests/helpers/createPlatformApiFixture';

export type TElectronPlatformApiFixtureOverrides = TPlatformApiFixtureOverrides & {diagnostics?: TDeepPartial<IDiagnosticsRendererCapability>;};

const DEFAULT_DIAGNOSTICS: IDiagnosticsRendererCapability = {
    startupPolicy: Object.freeze({mode: 'unknown'}),
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
            onDebugLog: diagnosticsOverrides?.onDebugLog ?? DEFAULT_DIAGNOSTICS.onDebugLog,
        },
        updates: platformApi.updates,
    };
    return electronApi as IElectronAPI & TOverrides;
}
