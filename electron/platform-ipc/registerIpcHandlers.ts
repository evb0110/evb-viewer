import { ipcMain } from 'electron';
import type { ICoreIpcHandlerOptions } from '@electron/platform-ipc/registerCoreIpcHandlers';
import { createAgentService } from '@electron/features/agent/createAgentService';
import { registerFeatureIpcAdapters } from '@electron/platform-ipc/featureIpcAdapters';

export { disposeScanCleanupMainBindingsIfLoaded } from '@electron/platform-ipc/featureIpcAdapters';

export { normalizeRendererLogEntry } from '@electron/platform-ipc/rendererLogBridge';

export function registerIpcHandlers(options: ICoreIpcHandlerOptions = {}) {
    const agentService = createAgentService();
    return registerFeatureIpcAdapters(ipcMain, {
        agentService,
        coreIpcOptions: options,
    });
}
