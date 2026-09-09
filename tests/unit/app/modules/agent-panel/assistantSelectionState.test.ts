import {
    describe,
    expect,
    it,
} from 'vitest';
import type {
    IAgentAssistantState,
    IAgentAssistantProviderStatus,
    IAgentAssistantStatus,
    TAgentAssistantProviderId,
} from '@contracts/agent';
import {cloneAssistantScope} from '@contracts/agent';
import {
    createSelectedAssistantStatus,
    getStateScopeFingerprint,
    modelForSelection,
    normalizeEffortValue,
    normalizeModelValue,
    normalizeProviderValue,
    normalizeSpeedModeValue,
    providerDefaultEffort,
    providerDefaultModel,
    providerDefaultSpeedMode,
    speedModesForProviderStatus,
} from '@app/modules/agent-panel/utils/assistantSelectionState';
import {requireDocumentInstanceId} from '@contracts/documentInstanceId';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireDocumentRef} from '@contracts/documentRef';
import {
    requireEpochMs,
    requireIsoTimestamp,
} from '@contracts/timestamps';
import {requireTabId} from '@contracts/windowTabs';

function createProviderStatus(
    id: TAgentAssistantProviderId,
    patch: Partial<IAgentAssistantProviderStatus> = {},
): IAgentAssistantProviderStatus {
    const label = id === 'claude' ? 'Claude' : 'Codex';

    return {
        id,
        label,
        installState: 'installed',
        authState: 'signed-in',
        runtimeState: 'ready',
        models: [
            {
                id: `${id}-default`,
                label: `${label} Default`,
            },
            {
                id: `${id}-second`,
                label: `${label} Second`,
            },
        ],
        defaultModel: `${id}-default`,
        activeModel: `${id}-default`,
        modelSwitchMode: 'in-session',
        availableEfforts: [
            'low',
            'medium',
            'high',
        ],
        defaultEffort: 'low',
        activeEffort: 'low',
        availableSpeedModes: [
            'fast',
            'standard',
        ],
        defaultSpeedMode: 'fast',
        activeSpeedMode: 'fast',
        path: `/bin/${id}`,
        version: '1.0.0',
        minimumVersion: id === 'codex' ? '0.133.0' : null,
        versionSupported: true,
        installUrl: `https://example.test/${id}`,
        account: null,
        ...patch,
    };
}

function createAssistantStatus(
    provider: TAgentAssistantProviderId = 'codex',
    patch: Partial<IAgentAssistantStatus> = {},
): IAgentAssistantStatus {
    const providers = [
        createProviderStatus('codex'),
        createProviderStatus('claude'),
    ];
    const activeProvider = providers.find(candidate => candidate.id === provider) ?? providers[0]!;

    return {
        supported: true,
        platform: 'darwin',
        provider: activeProvider.id,
        providerLabel: activeProvider.label,
        providers,
        model: activeProvider.activeModel,
        modelLabel: activeProvider.models[0]?.label ?? activeProvider.activeModel,
        models: activeProvider.models,
        modelSwitchMode: activeProvider.modelSwitchMode,
        effort: activeProvider.activeEffort,
        availableEfforts: activeProvider.availableEfforts,
        speedMode: activeProvider.activeSpeedMode,
        availableSpeedModes: activeProvider.availableSpeedModes,
        installState: activeProvider.installState,
        codexInstalled: true,
        codexPath: '/bin/codex',
        codexVersion: '1.0.0',
        minimumCodexVersion: '0.133.0',
        codexVersionSupported: true,
        installUrl: activeProvider.installUrl,
        installScriptUrl: 'https://example.test/install',
        managedInstallDir: '/tmp/assistant',
        authState: activeProvider.authState,
        account: null,
        runtimeState: activeProvider.runtimeState,
        mcp: {
            serverName: 'evb-viewer',
            serverUrl: 'http://127.0.0.1:1',
            serverRunning: true,
            toolCount: 1,
        },
        turn: {
            id: 'turn-1',
            phase: 'thinking',
            reasoning: '',
            toolActivity: [],
            lastEventAtMs: null,
            usage: null,
        },
        lastCheckedAt: requireIsoTimestamp('2026-01-01T00:00:00.000Z'),
        ...patch,
    };
}

describe('assistantSelectionState', () => {
    it('normalizes provider, model, and effort values from raw or option-like values', () => {
        expect(normalizeProviderValue('claude')).toBe('claude');
        expect(normalizeProviderValue({value: 'claude'})).toBe('claude');
        expect(normalizeProviderValue('unknown')).toBe('codex');

        expect(normalizeModelValue('gpt-test')).toBe('gpt-test');
        expect(normalizeModelValue({value: 'sonnet'})).toBe('sonnet');
        expect(normalizeModelValue({value: 5})).toBeNull();

        expect(normalizeEffortValue('xhigh')).toBe('xhigh');
        expect(normalizeEffortValue({value: 'max'})).toBe('max');
        expect(normalizeEffortValue('extreme')).toBe('extreme');
        expect(normalizeEffortValue('   ')).toBeNull();

        expect(normalizeSpeedModeValue('fast')).toBe('fast');
        expect(normalizeSpeedModeValue({value: 'standard'})).toBe('standard');
        expect(normalizeSpeedModeValue('turbo')).toBeNull();
    });

    it('resolves selected models with requested, default, first, and empty fallbacks', () => {
        const provider = createProviderStatus('codex');

        expect(modelForSelection(provider, 'codex-second')?.id).toBe('codex-second');
        expect(modelForSelection(provider, 'missing')?.id).toBe('codex-default');
        expect(modelForSelection({
            ...provider,
            defaultModel: 'missing',
        }, 'missing')?.id).toBe('codex-default');
        expect(modelForSelection({
            ...provider,
            defaultModel: 'missing',
            models: [],
        }, 'missing')).toBeNull();
    });

    it('preserves turn state when selecting the active provider', () => {
        const baseStatus = createAssistantStatus('codex');
        const providerStatus = baseStatus.providers.find(provider => provider.id === 'codex')!;

        const selectedStatus = createSelectedAssistantStatus(
            baseStatus,
            providerStatus,
            'codex-second',
            'medium',
            'standard',
        );

        expect(selectedStatus.provider).toBe('codex');
        expect(selectedStatus.model).toBe('codex-second');
        expect(selectedStatus.effort).toBe('medium');
        expect(selectedStatus.speedMode).toBe('standard');
        expect(selectedStatus.turn).toBe(baseStatus.turn);
    });

    it('uses selected model reasoning efforts for optimistic effort selection', () => {
        const baseStatus = createAssistantStatus('codex');
        const providerStatus = createProviderStatus('codex', {
            models: [
                {
                    id: 'codex-default',
                    label: 'Codex Default',
                    reasoningEfforts: [{
                        id: 'low',
                        label: 'Low',
                    }],
                    defaultReasoningEffort: 'low',
                },
                {
                    id: 'codex-deep',
                    label: 'Codex Deep',
                    reasoningEfforts: [
                        {
                            id: 'medium',
                            label: 'Medium',
                            isDefault: true,
                        },
                        {
                            id: 'xhigh',
                            label: 'Extra High',
                        },
                        {
                            id: 'super-high',
                            label: 'Super High',
                        },
                    ],
                    defaultReasoningEffort: 'medium',
                },
            ],
            availableEfforts: ['low'],
            defaultEffort: 'low',
            activeEffort: 'low',
        });

        const selectedStatus = createSelectedAssistantStatus(
            baseStatus,
            providerStatus,
            'codex-deep',
            'xhigh',
            'fast',
        );
        const fallbackStatus = createSelectedAssistantStatus(
            baseStatus,
            providerStatus,
            'codex-deep',
            'not-advertised',
            'fast',
        );

        expect(selectedStatus.availableEfforts).toEqual([
            'medium',
            'xhigh',
            'super-high',
        ]);
        expect(selectedStatus.effort).toBe('xhigh');
        expect(fallbackStatus.effort).toBe('medium');
    });

    it('resets turn state when switching providers', () => {
        const baseStatus = createAssistantStatus('codex');
        const providerStatus = baseStatus.providers.find(provider => provider.id === 'claude')!;

        const selectedStatus = createSelectedAssistantStatus(
            baseStatus,
            providerStatus,
            'claude-second',
            'max',
            'fast',
        );

        expect(selectedStatus.provider).toBe('claude');
        expect(selectedStatus.model).toBe('claude-second');
        expect(selectedStatus.effort).toBe('low');
        expect(selectedStatus.speedMode).toBe('fast');
        expect(selectedStatus.turn).toEqual({
            id: null,
            phase: 'idle',
            reasoning: '',
            toolActivity: [],
            lastEventAtMs: null,
            usage: null,
        });
    });

    it('clones assistant scopes without manufacturing nullable optional fields', () => {
        expect(cloneAssistantScope({
            kind: 'document',
            key: 'scope-1',
            title: 'Document',
            tabId: requireTabId('tab-1'),
            documentRef: requireDocumentRef('/tmp/document.pdf'),
        })).toEqual({
            kind: 'document',
            key: 'scope-1',
            title: 'Document',
            tabId: requireTabId('tab-1'),
            documentRef: requireDocumentRef('/tmp/document.pdf'),
        });

        expect(cloneAssistantScope({
            kind: 'document',
            key: 'scope-2',
            title: null,
            tabId: null,
            documentRef: null,
        })).toEqual({
            kind: 'document',
            key: 'scope-2',
            title: null,
        });
    });

    it('fingerprints assistant state by provider, logical session, instance, and revision', () => {
        const status = createAssistantStatus('codex');
        const baseState = {
            scope: {
                kind: 'document',
                key: 'document-session:logical-1',
                title: 'Document',
                tabId: requireTabId('tab-1'),
                documentSessionKey: 'logical-1',
                documentInstanceId: requireDocumentInstanceId('instance-a'),
                documentIdentity: {
                    version: 1,
                    authority: 'browser-document-store',
                    contentRevision: 1,
                    documentRef: requireDocumentRef('/tmp/document.pdf'),
                    mintedAt: requireEpochMs(1),
                    token: requireDocumentRevisionToken('revision-1'),
                },
            },
            status,
            messages: [],
        } satisfies IAgentAssistantState;

        expect(getStateScopeFingerprint({
            ...baseState,
            scope: {
                ...baseState.scope,
                documentInstanceId: requireDocumentInstanceId('instance-b'),
            },
        })).not.toBe(getStateScopeFingerprint(baseState));
        expect(getStateScopeFingerprint({
            ...baseState,
            status: createAssistantStatus('claude'),
        })).not.toBe(getStateScopeFingerprint(baseState));
        expect(getStateScopeFingerprint({
            ...baseState,
            scope: {
                ...baseState.scope,
                documentIdentity: {
                    ...baseState.scope.documentIdentity,
                    token: requireDocumentRevisionToken('revision-2'),
                },
            },
        })).not.toBe(getStateScopeFingerprint(baseState));
    });

    it('resolves provider default model and effort with stable fallbacks', () => {
        const providers = [createProviderStatus('codex', {
            activeModel: 'codex-active',
            defaultModel: 'codex-default',
            activeEffort: 'medium',
            defaultEffort: 'low',
            activeSpeedMode: 'standard',
            defaultSpeedMode: 'fast',
        })];

        expect(providerDefaultModel(providers, 'codex')).toBe('codex-active');
        expect(providerDefaultModel([{
            ...providers[0]!,
            activeModel: '',
        }], 'codex')).toBe('');
        expect(providerDefaultModel([], 'codex')).toBe('default');
        expect(providerDefaultEffort(providers, 'codex')).toBe('medium');
        expect(providerDefaultEffort([], 'codex')).toBe('low');
        expect(providerDefaultSpeedMode(providers, 'codex')).toBe('standard');
        expect(providerDefaultSpeedMode([], 'codex')).toBe('fast');
    });

    it('keeps Codex speed modes available when stale runtime status only reports standard speed', () => {
        const baseStatus = createAssistantStatus('codex');
        const staleProviderStatus = createProviderStatus('codex', {
            availableSpeedModes: ['standard'],
            defaultSpeedMode: 'standard',
            activeSpeedMode: 'standard',
        });

        const selectedStatus = createSelectedAssistantStatus(
            baseStatus,
            staleProviderStatus,
            'codex-default',
            'low',
            'fast',
        );

        expect(speedModesForProviderStatus(staleProviderStatus)).toEqual([
            'fast',
            'standard',
        ]);
        expect(providerDefaultSpeedMode([staleProviderStatus], 'codex')).toBe('fast');
        expect(selectedStatus.availableSpeedModes).toEqual([
            'fast',
            'standard',
        ]);
        expect(selectedStatus.speedMode).toBe('fast');
    });

    it('derives Claude speed modes from the selected model tiers', () => {
        const baseStatus = createAssistantStatus('claude');
        const providerStatus = createProviderStatus('claude', {
            models: [
                {
                    id: 'claude-opus',
                    label: 'Claude Opus',
                    serviceTiers: [
                        {
                            id: 'fast',
                            label: 'Fast',
                        },
                        {
                            id: 'standard',
                            label: 'Standard',
                        },
                    ],
                },
                {
                    id: 'claude-sonnet',
                    label: 'Claude Sonnet',
                    serviceTiers: [{
                        id: 'standard',
                        label: 'Standard',
                    }],
                },
            ],
            activeModel: 'claude-opus',
            availableSpeedModes: [
                'fast',
                'standard',
            ],
            defaultSpeedMode: 'fast',
        });

        expect(speedModesForProviderStatus(providerStatus, 'claude-opus')).toEqual([
            'fast',
            'standard',
        ]);
        expect(speedModesForProviderStatus(providerStatus, 'claude-sonnet')).toEqual(['standard']);
        expect(createSelectedAssistantStatus(
            baseStatus,
            providerStatus,
            'claude-sonnet',
            'low',
            'fast',
        ).speedMode).toBe('standard');
    });
});
