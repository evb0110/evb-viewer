import {
    describe, expect, it,
} from 'vitest';
import * as v from 'valibot';
import {
    browserAgentCapability, createBrowserAgentMcpStatus, createBrowserAssistantState,
} from '@app/platform/browser-api/browserAgentCapability';
import { ASSISTANT_STATE_SCHEMA } from '@contracts/assistant';
import { requireRequestId } from '@contracts/shared';
import { requireTabId } from '@contracts/windowTabs';

describe('browserAgentCapability', () => {
    it('returns the unsupported state and empty provider instances on the new wire contract', async () => {
        expect(v.parse(ASSISTANT_STATE_SCHEMA, await browserAgentCapability.getAssistantState())).toEqual({
            supported: false,
            enabled: false,
            instances: [],
            selection: null,
            chat: null,
            installProgress: null,
        });
        expect(await browserAgentCapability.getAssistantInstances()).toEqual({
            ok: false,
            instances: [],
            notices: [],
        });
        expect(await browserAgentCapability.saveAssistantInstances([])).toEqual({
            ok: false,
            instances: [],
            notices: [],
        });
        expect(await browserAgentCapability.importAssistantInstancesFromT3()).toEqual({
            ok: false,
            instances: [],
            notices: [],
        });
    });
    it('does not accept browser assistant commands', async () => {
        await expect(browserAgentCapability.submitWorkspaceSnapshot({
            requestId: requireRequestId('snapshot-1'),
            ok: false,
        })).resolves.toEqual({
            accepted: false,
            reason: 'unknown-request',
        });
        await expect(browserAgentCapability.submitCommandResponse({
            requestId: requireRequestId('command-1'),
            ok: false,
        })).resolves.toEqual({
            accepted: false,
            reason: 'unknown-request',
        });
        const result = await browserAgentCapability.sendAssistantMessage({
            text: 'hello',
            scope: {
                kind: 'document',
                key: 'a',
                title: 'A',
                tabId: requireTabId('tab-a'),
            },
            selection: {
                instanceId: 'codex',
                model: 'gpt',
                effort: 'high',
                speedMode: 'standard',
            },
        });
        expect(result).toEqual({
            ok: false,
            state: createBrowserAssistantState(),
        });
    });
    it('preserves the browser MCP status', () => {
        expect(createBrowserAgentMcpStatus()).toMatchObject({
            enabled: false,
            serverName: 'evb_viewer',
            serverRunning: false,
            codexInstalled: false,
            codexConfigured: false,
        });
    });
});
