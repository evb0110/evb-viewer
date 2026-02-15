import { delay } from 'es-toolkit/promise';
import {
    COMMAND_REQUEST_TIMEOUT_MS,
    SESSION_WAIT_TIMEOUT_MS,
    getCurrentSessionName,
    getSessionInfo,
} from './shared';

export async function sendCommand(
    command: string,
    args: unknown[] = [],
    requestTimeoutMs = COMMAND_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
    const start = Date.now();
    let didPrintWaitMessage = false;

    while (Date.now() - start < SESSION_WAIT_TIMEOUT_MS) {
        const info = getSessionInfo();

        if (!info) {
            if (!didPrintWaitMessage && Date.now() - start > 2000) {
                didPrintWaitMessage = true;
                console.log(`[Session '${getCurrentSessionName()}'] Waiting for session to start...`);
            }
            await delay(250);
            continue;
        }

        let data: { success: boolean; result?: unknown; error?: string } | null = null;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

        try {
            const res = await fetch(`http://localhost:${info.port}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command, args }),
                signal: controller.signal,
            });
            data = (await res.json()) as { success: boolean; result?: unknown; error?: string };
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(`Command "${command}" timed out after ${Math.round(requestTimeoutMs / 1000)}s`);
            }
            if (!didPrintWaitMessage) {
                didPrintWaitMessage = true;
                console.log(`[Session '${getCurrentSessionName()}'] Waiting for session to become ready...`);
            }
            await delay(250);
            continue;
        } finally {
            clearTimeout(timeoutId);
        }

        if (!data.success) {
            throw new Error(data.error ?? 'Unknown error');
        }

        return data.result;
    }

    throw new Error(`Session '${getCurrentSessionName()}' not ready after ${Math.round(SESSION_WAIT_TIMEOUT_MS / 1000)}s. Start with: pnpm electron:run start --session=${getCurrentSessionName()}`);
}
