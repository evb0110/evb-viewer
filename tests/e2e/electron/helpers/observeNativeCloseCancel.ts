import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {CORE_IPC_SEND_CHANNELS} from '@electron/platform-ipc/coreContract';
import {getSessionInfo} from '@scripts/electron-run/electronRunSessionArtifacts';
import {sessionLogFilePath} from '@scripts/electron-run/electronRunSessionPaths';
import type {IElectronE2ESession} from './startElectronE2ESession';

// Let Electron allocate a loopback port for this session alone.
export const NATIVE_CLOSE_OBSERVER_ENV = {EVB_AUTOMATION_EXTRA_CHROMIUM_SWITCHES: '--inspect=127.0.0.1:0'};

export async function waitForNativeCloseCancel(session: IElectronE2ESession, requestClose: () => Promise<void>) {
    const pid = getSessionInfo(session.name)?.electronPid;
    const log = await readFile(sessionLogFilePath(session.name), 'utf8');
    const endpoint = log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[\da-f-]+)/i)?.[1];
    if (!pid || !endpoint) {
        throw new Error('The session has no Electron main inspector');
    }

    const socket = new WebSocket(endpoint);
    let commandId = 0;
    const evaluate = async (expression: string) => {
        const id = ++commandId;
        const reply = once(socket, 'message', {signal: AbortSignal.timeout(5_000)});
        socket.send(JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: {
                expression,
                awaitPromise: true,
                returnByValue: true,
            },
        }));
        const [event] = await reply;
        const response = JSON.parse(String(event.data));
        if (response.id !== id || response.error || response.result?.exceptionDetails) {
            throw new Error(`Electron main inspector evaluation failed: ${JSON.stringify(response)}`);
        }
    };

    try {
        await once(socket, 'open', {signal: AbortSignal.timeout(5_000)});
        await evaluate(`(() => {
            if (process.pid !== ${pid}) throw new Error('Wrong Electron main process');
            const { BrowserWindow, ipcMain } = process.mainModule.require('electron');
            const [window, ...others] = BrowserWindow.getAllWindows();
            if (!window || others.length) throw new Error('Expected a single test window');
            const contents = window.webContents;
            const channel = ${JSON.stringify(CORE_IPC_SEND_CHANNELS.windowCloseResponse)};
            globalThis.__e2eNativeCloseCancel = new Promise(resolve => {
                const onResponse = (event, response) => {
                    if (event.sender !== contents || response?.decision !== 'cancel') return;
                    ipcMain.off(channel, onResponse);
                    resolve();
                };
                // App listeners are already registered and run synchronously before this one.
                ipcMain.on(channel, onResponse);
            });
        })()`);
        await requestClose();
        try {
            await evaluate('globalThis.__e2eNativeCloseCancel');
        } catch (cause) {
            throw new Error('Electron main did not process the first Quit Cancel', {cause});
        }
    } finally {
        socket.close();
    }
}
