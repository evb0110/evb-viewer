interface IDebugLogMessage {
    source: string;
    message: string;
    timestamp: string;
}

const MAX_DEBUG_LOG_ENTRIES = 2000;
const debugLogBuffer: IDebugLogMessage[] = [];

export function pushDebugLogMessage(message: IDebugLogMessage) {
    debugLogBuffer.push(message);

    if (debugLogBuffer.length <= MAX_DEBUG_LOG_ENTRIES) {
        return;
    }

    debugLogBuffer.splice(0, debugLogBuffer.length - MAX_DEBUG_LOG_ENTRIES);
}

export function getDebugLogMessages() {
    return debugLogBuffer.slice();
}
