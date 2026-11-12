import type * as ChildProcessModule from 'child_process';
import {
    afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import {
    mkdtemp, rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {requireTabId} from '@contracts/windowTabs';

const boundary = vi.hoisted(() => ({
    root: '',
    spawn: vi.fn(() => {throw new Error('Unexpected provider process');}),
    execFile: vi.fn(() => {throw new Error('Unexpected provider command');}),
    query: vi.fn(() => {throw new Error('Unexpected Claude SDK query');}),
}));
vi.mock('@electron/te', async () => {
    const {default: en} = await import('@i18n-app/messages/en');
    return {te: (key: string, params: Record<string, unknown> = {}) => {
        const text: unknown = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en);
        return String(text).replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name]));
    }};
});
vi.mock('electron', () => ({
    default: {app: {
        getPath: () => boundary.root,
        getVersion: () => 'test',
    }},
    app: {
        getPath: () => boundary.root,
        getVersion: () => 'test',
        getName: () => 'EVB Viewer',
        isPackaged: false,
    },
    shell: {openExternal: vi.fn()},
    BrowserWindow: {getFocusedWindow: () => null},
}));
vi.mock('child_process', async importOriginal => ({
    ...(await importOriginal<typeof ChildProcessModule>()),
    spawn: boundary.spawn,
    execFile: boundary.execFile,
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({query: boundary.query}));
vi.mock('@electron/settings', () => ({loadSettings: async () => ({assistantPanelEnabled: false})}));
vi.mock('@electron/window/registry', () => ({getAllRegisteredAppWindows: () => []}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    boundary.root = await mkdtemp(join(tmpdir(), 'assistant-opt-in-'));
});
afterEach(async () => {await rm(boundary.root, {
    recursive: true,
    force: true,
});});

describe('assistant opt-in at the service boundary', () => {
    it('returns disabled state without starting either provider', async () => {
        const {getAgentAssistantState} = await import('@electron/features/agent/assistantService');
        expect(await getAgentAssistantState({probe: true})).toMatchObject({
            supported: true,
            enabled: false,
            instances: [],
            selection: null,
            chat: null,
        });
        expect(boundary.spawn).not.toHaveBeenCalled();
        expect(boundary.execFile).not.toHaveBeenCalled();
        expect(boundary.query).not.toHaveBeenCalled();
    });
    it('refuses a send while disabled and starts no provider process', async () => {
        const {sendAgentAssistantMessage} = await import('@electron/features/agent/assistantService');
        expect(await sendAgentAssistantMessage({
            text: 'Inspect this page',
            scope: {
                kind: 'document',
                key: 'document:a',
                title: 'a.pdf',
                tabId: requireTabId('tab-a'),
            },
            selection: {
                instanceId: 'codex',
                model: 'gpt-5.4',
                effort: 'high',
                speedMode: 'standard',
            },
        }, {windowId: 1})).toMatchObject({
            ok: false,
            state: {enabled: false},
            error: {message: 'Enable EVB Assistant in Settings to use assistant chat.'},
        });
        expect(boundary.spawn).not.toHaveBeenCalled();
        expect(boundary.execFile).not.toHaveBeenCalled();
        expect(boundary.query).not.toHaveBeenCalled();
    });
});
