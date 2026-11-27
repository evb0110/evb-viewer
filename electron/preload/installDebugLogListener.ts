import type {IpcRenderer} from 'electron';
import {decodeDebugLogEntry} from '@contracts/electronApiCommon';
import {pushDebugLogMessage} from '@electron/preload/debugLogBuffer';
import {CORE_IPC_EVENT_CHANNELS} from '@electron/platform-ipc/coreContract';

const PRELOAD_DEBUG_LOG_LISTENER_FLAG = '__preloadDebugLogListenerInstalled';

export function installDebugLogListener(ipcRenderer: Pick<IpcRenderer, 'on'>) {
    const preloadState = globalThis as Record<string, unknown>;
    if (preloadState[PRELOAD_DEBUG_LOG_LISTENER_FLAG] === true) {
        return;
    }

    preloadState[PRELOAD_DEBUG_LOG_LISTENER_FLAG] = true;
    ipcRenderer.on(CORE_IPC_EVENT_CHANNELS.debugLog, (_event, data: unknown) => {
        const entry = decodeDebugLogEntry(data);
        if (!entry) {
            return;
        }

        pushDebugLogMessage(entry);

        const level = entry.level ?? 'WARN';
        if (level === 'ERROR') {
            const failureRef = entry.failureRef;
            const errorId = failureRef === undefined ? '' : ` Error ID: ${failureRef.eventId}`;
            console.error(`[${entry.timestamp}] [${entry.source}] ${entry.message}${errorId}`);
            return;
        }
        if (level === 'WARN') {
            console.warn(`[${entry.timestamp}] [${entry.source}] ${entry.message}`);
        }
    });
}
