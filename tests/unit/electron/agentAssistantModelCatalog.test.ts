import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
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
        ]})).toEqual([{id: 'gpt-6-sol', label: 'gpt-6-sol'}, {id: 'custom', label: 'Custom model'}]);
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
    it('retains structured transient classification, native code and retryability', () => {
        expect(createAssistantErrorEnvelope(new Error(JSON.stringify({status: 429, error: {code: 'rate_limit_error', message: 'Please try again later.'}})))).toMatchObject({code: 'PROVIDER_RATE_LIMITED', class: 'usage_limit', providerCode: 'rate_limit_error', retryable: true, message: 'Please try again later.'});
        expect(createAssistantErrorEnvelope({status: 529, message: 'Overloaded'})).toMatchObject({retryable: true, class: 'transport_error'});
        expect(createAssistantErrorEnvelope({status: 401, message: 'Credentials expired'})).toMatchObject({code: 'AUTH_REQUIRED', retryable: false});
    });
    it('removes credentials, URLs, hosts and unsafe control characters before bounding text', () => {
        const message = sanitizeAssistantProviderText('Failed https://user:password@gateway.example.test/v1?token=secret\u0000 Bearer fixture-token api_key=fixture-key gateway.example.test:8080 127.0.0.1:3000');
        expect(message).not.toMatch(/gateway|fixture|password|secret|127\.0\.0\.1|https:/);
        expect(message).toContain('[redacted endpoint]');
        expect(sanitizeAssistantProviderText('x'.repeat(5000))).toHaveLength(4096);
    });
});
