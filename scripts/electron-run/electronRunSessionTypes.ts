import type { ChildProcess } from 'node:child_process';
import type { TSessionRecording } from '@scripts/electron-run/sessionRecording';
import type {
    Browser,
    ConsoleMessage,
    Page,
} from 'puppeteer-core';

export type TConsoleMessageType = ReturnType<ConsoleMessage['type']>;

export interface IConsoleMessage {
    type: TConsoleMessageType;
    text: string;
    timestamp: number;
}

interface IDevtoolsEventBase {timestamp: number;}

interface IConsoleDevtoolsEvent extends IDevtoolsEventBase {
    kind: 'console';
    level: TConsoleMessageType;
    text: string;
}

interface IRequestDevtoolsEvent extends IDevtoolsEventBase {
    kind: 'request';
    url: string;
    method: string;
    resourceType: string;
    isNavigationRequest: boolean;
}

interface IResponseDevtoolsEvent extends IDevtoolsEventBase {
    kind: 'response';
    url: string;
    status: number;
    ok: boolean;
    fromCache: boolean;
    fromServiceWorker: boolean;
    resourceType: string;
    method: string;
}

interface IRequestFailedDevtoolsEvent extends IDevtoolsEventBase {
    kind: 'requestfailed';
    url: string;
    method: string;
    resourceType: string;
    failureText: string;
}

interface IPageErrorDevtoolsEvent extends IDevtoolsEventBase {
    kind: 'pageerror';
    text: string;
}

interface IErrorDevtoolsEvent extends IDevtoolsEventBase {
    kind: 'error';
    text: string;
}

export type TDevtoolsEvent =
    | IConsoleDevtoolsEvent
    | IRequestDevtoolsEvent
    | IResponseDevtoolsEvent
    | IRequestFailedDevtoolsEvent
    | IPageErrorDevtoolsEvent
    | IErrorDevtoolsEvent;

export interface ISessionState {
    recording?: TSessionRecording;
    browser: Browser;
    page: Page;
    electronProcess: ChildProcess;
    nuxtProcess: ChildProcess | null;
    consoleMessages: IConsoleMessage[];
    devtoolsEvents: TDevtoolsEvent[];
}

export interface ISessionInfo {
    recording?: string;
    port: number;
    pid: number;
    cdpPort: number;
    electronPid: number | null;
    nuxtPid: number | null;
    nuxtPort: number;
    runId?: string | null;
    logs?: {
        manifestFile: string;
        sessionLogFile: string;
        runDir: string;
        relativeRunDir: string;
        runCombinedLogFile: string;
    };
}

export interface ISessionStartingInfo {
    pid: number;
    startedAt: number;
    electronPids: number[];
    cdpPorts: number[];
    electronUserDataDir: string | null;
    nuxtPid: number | null;
    nuxtPort: number | null;
    runId?: string | null;
}
