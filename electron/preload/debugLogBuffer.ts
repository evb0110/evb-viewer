import type {IDebugLogEntry} from '@contracts/electronApiCommon';

const MAX_DEBUG_LOG_ENTRIES = 2000;
const debugLogBuffer: IDebugLogEntry[] = [];
// Once the buffer is full, new entries overwrite the oldest slot instead of
// shifting every retained entry forward.
let oldestIndex = 0;

export function pushDebugLogMessage(message: IDebugLogEntry) {
    if (debugLogBuffer.length < MAX_DEBUG_LOG_ENTRIES) {
        debugLogBuffer.push(message);
        return;
    }

    debugLogBuffer[oldestIndex] = message;
    oldestIndex = (oldestIndex + 1) % MAX_DEBUG_LOG_ENTRIES;
}

export function getDebugLogMessages() {
    return debugLogBuffer.slice(oldestIndex).concat(debugLogBuffer.slice(0, oldestIndex));
}
