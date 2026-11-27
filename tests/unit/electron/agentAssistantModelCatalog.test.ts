import {readFileSync} from 'node:fs';
import {describe, expect, it, vi} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {requireTabId} from '@contracts/windowTabs';
import type {ICodexThreadListener} from '@electron/features/agent/codexInstanceRuntime';
import {normalizeCodexAssistantModelFromCatalog, normalizeCodexModelListResponse, resolveCodexModelStatus} from '@electron/features/agent/assistantModelCatalog';
import {createAssistantErrorEnvelope, sanitizeAssistantProviderText} from '@electron/features/agent/assistantErrorEnvelope';

describe('agent assistant model catalog', () => {
    it('keeps every reported generation and family in provider order', () => {
        const models = normalizeCodexModelListResponse({data: [
            {model: 'gpt-6-astra', isDefault: true},
            {model: 'gpt-6-sol'},
            {model: 'gpt-6-luna'},
            {model: 'gpt-6.1-sol'},
            {model: 'gpt-5.6-terra'},
        ]}) ?? [];
        expect(models.map(model => model.id)).toEqual(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-5.6-terra']);
        expect(resolveCodexModelStatus(models, 'absent-model')).toMatchObject({defaultModel: 'gpt-6-astra', activeModel: 'gpt-6-astra'});
    });

    it('does not fabricate the unsupported Sol 6.1 on the real older runtime catalog', () => {
        const response: unknown = JSON.parse(readFileSync('tests/fixtures/electron/codex-app-server-model-list-0.157.1.json', 'utf8'));
        const models = normalizeCodexModelListResponse(response) ?? [];
        expect(models.map(model => model.id)).toEqual(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']);
        expect(normalizeCodexAssistantModelFromCatalog(models, 'gpt-6.1-sol')).toBe('gpt-6-astra');
        expect(normalizeCodexAssistantModelFromCatalog(models, null)).toBe('gpt-6-astra');
    });

    it('deduplicates visible models, ignores hidden/blank records and never injects an absent model', () => {
        expect(normalizeCodexModelListResponse({data: [
            {model: 'gpt-6-sol'}, {id: 'gpt-6-sol', displayName: 'Duplicate'},
            {model: 'gpt-6.1-sol', hidden: true}, {model: '   '}, null,
            {id: 'custom', displayName: 'Custom model'},
        ]})).toEqual([{id: 'gpt-6-sol', label: 'gpt-6-sol', isLegacy: true}, {id: 'custom', label: 'Custom model'}]);
        expect(normalizeCodexModelListResponse({data: 'bad'})).toBeNull();
    });

    it('uses a reported default, otherwise the first row, including custom and older models', () => {
        const models = normalizeCodexModelListResponse({data: [{model: 'custom'}, {model: 'older', isDefault: true}]}) ?? [];
        expect(resolveCodexModelStatus(models, 'absent')).toMatchObject({defaultModel: 'older', activeModel: 'older'});
        expect(resolveCodexModelStatus(models, 'custom').activeModel).toBe('custom');
        expect(resolveCodexModelStatus(models.slice(0, 1), null).defaultModel).toBe('custom');
        expect(normalizeCodexAssistantModelFromCatalog([], 'gpt-6.1-sol')).toBe('');
    });

    it('preserves reported reasoning and speed options without adding universal capabilities', () => {
        const models = normalizeCodexModelListResponse({data: [{
            model: 'custom', displayName: 'Custom Runtime Model', defaultReasoningEffort: 'super-high',
            supportedReasoningEfforts: [{reasoningEffort: 'super-high', description: 'Maximum reasoning'}, {reasoningEffort: 'minimal'}],
            defaultServiceTier: 'priority', serviceTiers: [{id: 'priority', name: 'Fast', description: 'Lower latency'}, {id: 'standard', name: 'Standard'}],
        }, {model: 'simple'}, {model: 'legacy-speed', additionalSpeedTiers: ['fast']} ]});
        expect(models).toEqual([
            {id: 'custom', label: 'Custom Runtime Model', defaultReasoningEffort: 'super-high', reasoningEfforts: [
                {id: 'super-high', label: 'Super High', description: 'Maximum reasoning', isDefault: true}, {id: 'minimal', label: 'Minimal'},
            ], defaultServiceTier: 'priority', serviceTiers: [{id: 'priority', label: 'Fast', description: 'Lower latency'}, {id: 'standard', label: 'Standard'}]},
            {id: 'simple', label: 'simple'}, {id: 'legacy-speed', label: 'legacy-speed', serviceTiers: [{id: 'fast', label: 'Fast'}]},
        ]);
    });

    it('keeps independently reported setup catalogs separate', () => {
        const standard = normalizeCodexModelListResponse({data: [{model: 'standard', isDefault: true}]}) ?? [];
        const proxy = normalizeCodexModelListResponse({data: [{model: 'proxy-only', isDefault: true}]}) ?? [];
        expect(resolveCodexModelStatus(standard, 'proxy-only').activeModel).toBe('standard');
        expect(resolveCodexModelStatus(proxy, 'standard').activeModel).toBe('proxy-only');
    });
});

describe('readable provider failures', () => {
    it('unwraps the owner nested provider error and marks the permanent model error non-retryable', () => {
        const envelope = createAssistantErrorEnvelope(JSON.stringify({type: 'error', status: 400, error: {type: 'invalid_request_error', message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.", code: 'model_not_found'}}));
        expect(envelope).toMatchObject({code: 'MODEL_UNAVAILABLE', class: 'provider_error', providerCode: 'model_not_found', retryable: false, message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."});
    });
    it('offers Retry after a Codex app-server exit, but not for missing installs or unsupported models', () => {
        expect(createAssistantErrorEnvelope(new Error('Codex app-server exited.'))).toMatchObject({
            code: 'RUNTIME_UNAVAILABLE', class: 'transport_error', retryable: true,
            message: 'Codex app-server exited.',
        });
        expect(createAssistantErrorEnvelope(new Error('Codex executable not found.'))).toMatchObject({code: 'INSTALL_MISSING', retryable: false});
        expect(createAssistantErrorEnvelope(new Error('Model not supported.'))).toMatchObject({code: 'MODEL_UNAVAILABLE', retryable: false});
    });
    it('keeps a readable causal timeout while classifying the underlying failure', () => {
        expect(createAssistantErrorEnvelope(new Error('Codex did not start within 10 seconds.', {cause: new Error('initialize timed out after 10000ms.')}))).toMatchObject({
            message: 'Codex did not start within 10 seconds.', retryable: true, class: 'transport_error',
        });
    });
    it('retains structured transient classification, native code and retryability', () => {
        expect(createAssistantErrorEnvelope(new Error(JSON.stringify({status: 429, error: {code: 'rate_limit_error', message: 'Please try again later.'}})))).toMatchObject({code: 'PROVIDER_RATE_LIMITED', class: 'usage_limit', providerCode: 'rate_limit_error', retryable: true, message: 'Please try again later.'});
        expect(createAssistantErrorEnvelope({status: 529, message: 'Overloaded'})).toMatchObject({retryable: true, class: 'transport_error'});
        expect(createAssistantErrorEnvelope({status: 401, message: 'Credentials expired'})).toMatchObject({code: 'AUTH_REQUIRED', retryable: false});
    });
    it('removes credentials, URLs, hosts and unsafe control characters before bounding text', () => {
        const message = sanitizeAssistantProviderText('Failed https://user:password@gateway.example.test/v1?token=secret\u0000 Bearer fixture-token api_key=fixture-key gateway.example.test:8080 127.0.0.1:3000 [2001:db8::1]:8080');
        expect(message).not.toMatch(/gateway|fixture|password|secret|127\.0\.0\.1|2001:|https:/);
        expect(message).toContain('[redacted endpoint]');
        expect(sanitizeAssistantProviderText('x'.repeat(5000))).toHaveLength(4096);
        expect(sanitizeAssistantProviderText(JSON.stringify({password: 'https://credential.invalid/first"remaining-part', token: 'first\\remaining-part'}))).not.toMatch(/first|remaining-part/);
        for (const scheme of ['Bearer', 'Basic']) {
            expect(sanitizeAssistantProviderText(`Authorization: ${scheme} fixture-credential`)).not.toContain('fixture-credential');
        }
    });
});


describe('catalog recovery on an explicit send', () => {
    it('keeps failed discovery passive and recovers a reported model on the next send', async () => {
        const root = await mkdtemp(join(tmpdir(), 'assistant-catalog-recovery-'));
        let available = false;
        let listener: ICodexThreadListener;
        const config = {id: 'codex', driver: 'codex', displayName: 'Codex', enabled: true};
        vi.resetModules();
        vi.doMock('electron', () => ({default: {app: {getPath: () => root}}, app: {getPath: () => root, getVersion: () => 'test'}}));
        vi.doMock('@electron/settings', () => ({loadSettings: async () => ({assistantPanelEnabled: true})}));
        vi.doMock('@electron/window/registry', () => ({getAllRegisteredAppWindows: () => []}));
        vi.doMock('@electron/features/agent/assistantInstances', () => ({
            assistantInstanceLabel: () => 'Codex',
            getAssistantInstanceConfigs: async () => [config],
            getAssistantInstanceFingerprints: async () => new Map([['codex', 'fixture']]),
            onAssistantInstancesChanged: () => undefined,
            refreshAssistantLocalSetups: () => undefined,
            resolveAssistantLaunchContext: async () => ({binaryPath: '/fixture/codex', env: {}}),
        }));
        vi.doMock('@electron/features/agent/assistantLocalSetups', () => ({identifyAssistantExecutable: async () => '0.169.0'}));
        vi.doMock('@electron/features/agent/mcpServer', () => ({
            abortActiveEmbeddedMcpRequests: () => undefined,
            shutdownEmbeddedMcpServer: async () => undefined,
        }));
        vi.doMock('@electron/features/agent/codexInstanceRuntime', () => ({CodexInstanceRuntime: class {
            isLoginPending() { return false; }
            async shutdown() {}
            async probe() {
                if (!available) {throw new Error('Provider temporarily unavailable');}
                return {auth: 'authenticated', account: null, models: [{id: 'recovered', label: 'Recovered', isDefault: true}]};
            }
            async openThread(_previous: unknown, _model: string, notifications: ICodexThreadListener) {
                listener = notifications;
                return {threadId: 'fixture-thread', resumed: false};
            }
            async startTurn(input: {model: string}) {
                if (input.model !== 'recovered') {throw new Error('Model unavailable');}
                setImmediate(() => {
                    listener.onNotification('item/completed', {turnId: 'fixture-turn', item: {id: 'reply', type: 'agentMessage', text: 'Recovered reply'}});
                    listener.onNotification('turn/completed', {turn: {id: 'fixture-turn', status: 'completed'}});
                });
                return 'fixture-turn';
            }
        }}));
        const service = await import('@electron/features/agent/assistantService');
        try {
            await service.getAgentAssistantState({probe: true});
            await vi.waitFor(async () => expect((await service.getAgentAssistantState()).instances[0]).toMatchObject({state: 'error', models: []}));
            available = true;
            // Reading cached state must not silently retry failed discovery.
            expect((await service.getAgentAssistantState()).instances[0]).toMatchObject({state: 'error', models: []});
            const scope = {kind: 'document' as const, key: 'recovery-document', title: 'fixture.pdf', tabId: requireTabId('recovery-tab')};
            const result = await service.sendAgentAssistantMessage({scope, text: 'Try now', selection: {instanceId: 'codex', model: 'unavailable-stored', effort: 'high', speedMode: 'standard'}}, {windowId: 1});
            expect(result).toMatchObject({ok: true, state: {selection: {model: 'recovered'}}});
            await vi.waitFor(async () => expect((await service.getAgentAssistantState({scope})).chat?.items).toContainEqual(expect.objectContaining({kind: 'assistant', text: 'Recovered reply'})));
        } finally {
            await service.shutdownAgentAssistant();
            await service.preserveAssistantStateForShutdown();
            for (const module of ['electron', '@electron/settings', '@electron/window/registry', '@electron/features/agent/assistantInstances', '@electron/features/agent/assistantLocalSetups', '@electron/features/agent/mcpServer', '@electron/features/agent/codexInstanceRuntime']) {vi.doUnmock(module);}
            vi.resetModules();
            await rm(root, {recursive: true, force: true});
        }
    });
});
