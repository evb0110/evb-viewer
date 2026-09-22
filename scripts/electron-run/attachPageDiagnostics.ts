import { getErrorMessage } from '@contracts/getErrorMessage';
import type {
    ConsoleMessage,
    JSHandle,
    Page,
} from 'puppeteer-core';
import type { ISessionState } from '@scripts/electron-run/electronRunSessionTypes';
import { formatLogRecordLine } from '@contracts/logRecord';
import {
    consoleMessageToLogRecord,
    createLogRecord,
    printTerminalLogRecord,
    resolveTerminalLogLevel,
} from '@scripts/electron-run/terminalLog';

const MAX_CONSOLE_MESSAGES = 400;
const MAX_DEVTOOLS_EVENTS = 1200;

function pushBounded<T>(collection: T[], item: T, maxSize: number) {
    collection.push(item);
    if (collection.length > maxSize) {
        collection.splice(0, collection.length - maxSize);
    }
}

async function evaluateConsoleArg(arg: JSHandle) {
    try {
        return await arg.jsonValue();
    } catch {
        return undefined;
    }
}

/**
 * Turns one console call into a record. Arguments are evaluated once; the
 * message text never mixes CDP's `[object Object]` rendering with the data.
 */
async function toConsoleRecord(msg: ConsoleMessage) {
    const fallbackText = msg.text();
    try {
        const args = await Promise.all(msg.args().map(evaluateConsoleArg));
        const evaluated = args.every(value => value !== undefined) ? args : [];
        return consoleMessageToLogRecord(msg.type(), evaluated, fallbackText);
    } catch {
        return consoleMessageToLogRecord(msg.type(), [], fallbackText);
    }
}

export function attachPageDiagnostics(page: Page) {
    const consoleMessages: ISessionState['consoleMessages'] = [];
    const devtoolsEvents: ISessionState['devtoolsEvents'] = [];
    const pushConsoleMessage = (entry: ISessionState['consoleMessages'][number]) => {
        pushBounded(consoleMessages, entry, MAX_CONSOLE_MESSAGES);
        pushBounded(devtoolsEvents, {
            kind: 'console',
            timestamp: entry.timestamp,
            level: entry.type,
            text: entry.text,
        }, MAX_DEVTOOLS_EVENTS);
    };
    const pushDevtoolsEvent = (entry: ISessionState['devtoolsEvents'][number]) => {
        pushBounded(devtoolsEvents, entry, MAX_DEVTOOLS_EVENTS);
    };
    type TConsoleEntry = ISessionState['consoleMessages'][number];

    const terminalLevel = resolveTerminalLogLevel();
    page.on('console', (msg) => {
        void (async () => {
            const record = await toConsoleRecord(msg);
            pushConsoleMessage({
                type: msg.type(),
                text: formatLogRecordLine(record, {time: 'none'}),
                timestamp: Date.now(),
            });
            printTerminalLogRecord(record, terminalLevel);
        })();
    });
    page.on('request', (request) => {
        pushDevtoolsEvent({
            kind: 'request',
            timestamp: Date.now(),
            url: request.url(),
            method: request.method(),
            resourceType: request.resourceType(),
            isNavigationRequest: request.isNavigationRequest(),
        });
    });
    page.on('response', (response) => {
        pushDevtoolsEvent({
            kind: 'response',
            timestamp: Date.now(),
            url: response.url(),
            status: response.status(),
            ok: response.ok(),
            fromCache: response.fromCache(),
            fromServiceWorker: response.fromServiceWorker(),
            resourceType: response.request().resourceType(),
            method: response.request().method(),
        });
    });
    page.on('requestfailed', (request) => {
        pushDevtoolsEvent({
            kind: 'requestfailed',
            timestamp: Date.now(),
            url: request.url(),
            method: request.method(),
            resourceType: request.resourceType(),
            failureText: request.failure()?.errorText ?? 'unknown request failure',
        });
    });
    page.on('error', (error) => {
        const entry: TConsoleEntry = {
            type: 'error',
            text: `[PAGE ERROR] ${error.message}`,
            timestamp: Date.now(),
        };
        pushConsoleMessage(entry);
        pushDevtoolsEvent({
            kind: 'error',
            timestamp: entry.timestamp,
            text: entry.text,
        });
        printTerminalLogRecord(createLogRecord('error', 'renderer', 'page', 'Page error', {error}), terminalLevel);
    });
    page.on('pageerror', (error) => {
        const message = getErrorMessage(error);
        const entry: TConsoleEntry = {
            type: 'error',
            text: `[PAGE CRASH] ${message}`,
            timestamp: Date.now(),
        };
        pushConsoleMessage(entry);
        pushDevtoolsEvent({
            kind: 'pageerror',
            timestamp: entry.timestamp,
            text: message,
        });
        printTerminalLogRecord(createLogRecord('error', 'renderer', 'page', 'Uncaught page exception', {error}), terminalLevel);
    });

    return {
        consoleMessages,
        devtoolsEvents,
    };
}
