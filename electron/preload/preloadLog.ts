import type { IpcRenderer } from 'electron';
import { CORE_IPC_SEND_CHANNELS } from '@electron/platform-ipc/coreContract';

type TPreloadLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type TTracePreload = (stage: string, details?: Record<string, unknown>) => void;
export type TForwardPreloadLogToMain = (
    level: TPreloadLogLevel,
    section: string,
    message: string,
    data?: Record<string, unknown>,
) => void;

const preloadScriptStartedAt = Date.now();
const STARTUP_TRACE_ENABLED = process.argv.includes('--evb-startup-trace');
const STARTUP_TRACE_ENABLED_KEY = '__EVB_STARTUP_TRACE__';

function stringifyDetails(details?: Record<string, unknown>) {
    if (!details) {
        return '';
    }

    try {
        return ` details=${JSON.stringify(details)}`;
    } catch {
        return ' details=<unserializable>';
    }
}

export function exposeStartupTraceFlag() {
    (window as Window & {[STARTUP_TRACE_ENABLED_KEY]?: boolean;})[STARTUP_TRACE_ENABLED_KEY] = STARTUP_TRACE_ENABLED;
}

export function tracePreload(stage: string, details?: Record<string, unknown>) {
    if (!STARTUP_TRACE_ENABLED) {
        return;
    }

    const now = Date.now();
    const iso = new Date(now).toISOString();
    console.info(
        `[${iso}] [startup][preload] ${stage} (+${now - preloadScriptStartedAt}ms from preload-script-start)`
        + stringifyDetails(details),
    );
}

export function createPreloadMainLogger(ipcRenderer: Pick<IpcRenderer, 'send'>): TForwardPreloadLogToMain {
    return (
        level: TPreloadLogLevel,
        section: string,
        message: string,
        data?: Record<string, unknown>,
    ) => {
        try {
            ipcRenderer.send(CORE_IPC_SEND_CHANNELS.rendererLog, {
                level,
                section,
                message,
                timestamp: new Date().toISOString(),
                data,
            });
        } catch {
            // Avoid crashing preload if IPC is not available yet
        }
    };
}
