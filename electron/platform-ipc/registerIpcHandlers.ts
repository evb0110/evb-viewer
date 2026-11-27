import {ipcMain} from 'electron';
import type {ICoreIpcHandlerOptions} from '@electron/platform-ipc/registerCoreIpcHandlers';
import type {TLoadUpdatesModule, TLazyMainSubsystem} from '@electron/platform-ipc/featureRegistrationDescriptors';
import {registerFeatureIpcAdapters} from '@electron/platform-ipc/featureIpcAdapters';

export {normalizeRendererLogEntry} from '@electron/platform-ipc/rendererLogBridge';

export interface IRegisterIpcHandlersOptions extends ICoreIpcHandlerOptions {
    loadUpdatesModule?: TLoadUpdatesModule;
    onSubsystemLoaded?: (subsystem: TLazyMainSubsystem) => void;
    isSubsystemLoaded?: (subsystem: TLazyMainSubsystem) => boolean;
}

export function registerIpcHandlers(options: IRegisterIpcHandlersOptions = {}) {
    const {loadUpdatesModule, onSubsystemLoaded, isSubsystemLoaded, ...coreIpcOptions} = options;
    return registerFeatureIpcAdapters(ipcMain, {
        coreIpcOptions,
        ...(loadUpdatesModule ? {loadUpdatesModule} : {}),
        ...(onSubsystemLoaded ? {onSubsystemLoaded} : {}),
        ...(isSubsystemLoaded ? {isSubsystemLoaded} : {}),
    });
}
