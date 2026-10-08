// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {
    createApp,
    defineComponent,
    h,
    nextTick,
    reactive,
} from 'vue';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IAgentAssistantChatScope,
    IAgentAssistantEvent,
    IAgentAssistantImageAttachment,
    IAgentAssistantInstallResult,
    IAgentAssistantState,
} from '@contracts/agent';
import {
    requireIsoTimestamp,
    requireEpochMs,
} from '@contracts/timestamps';
import {requireTabId} from '@contracts/windowTabs';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireSessionId} from '@contracts/shared';
import {requireDocumentInstanceId} from '@contracts/documentInstanceId';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import { createEmptyAssistantState } from '@app/modules/agent-panel/utils/createEmptyAssistantState';
import { useAgentAssistantPanelController } from '@app/modules/agent-panel/composables/useAgentAssistantPanelController';
import {buildAgentAssistantScopeFingerprint} from '@agent-core/assistantScope';
import { STORAGE_KEYS } from '@app/constants/storageKeys';
import { cast } from '@tests/helpers/cast';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import type { IPlatformApiFixtureEventMethod } from '@tests/helpers/createDefaultPlatformApiFixtureMethod';

const mocks = vi.hoisted(() => ({
    getAssistantState: vi.fn(),
    installAssistantCodex: vi.fn(),
    sendAssistantMessage: vi.fn(),
    interruptAssistant: vi.fn(),
}));

const platformApi = createElectronPlatformApiFixture({agent: {
    getAssistantState: mocks.getAssistantState,
    sendAssistantMessage: mocks.sendAssistantMessage,
    interruptAssistant: mocks.interruptAssistant,
    installAssistantCodex: mocks.installAssistantCodex,
}});
const assistantEvent = platformApi.agent.onAssistantEvent as typeof platformApi.agent.onAssistantEvent & IPlatformApiFixtureEventMethod<IAgentAssistantEvent>;
vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => platformApi}));
vi.stubGlobal('useToast', () => ({add: vi.fn()}));
vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));
vi.mock('@app/composables/useRuntimeErrorReports', () => ({useRuntimeErrorReports: () => ({reportRuntimeError: vi.fn()})}));

const scope: IAgentAssistantChatScope = {
    kind: 'document',
    key: 'document-a',
    title: 'Document A',
    tabId: requireTabId('tab-a'),
};
const secondScope: IAgentAssistantChatScope = {
    kind: 'document',
    key: 'document-b',
    title: 'Document B',
    tabId: requireTabId('tab-b'),
};

function revisionScope(revision: number): IAgentAssistantChatScope {
    const documentRef = requireDocumentRef('/documents/a.pdf');
    const token = requireDocumentRevisionToken(`revision-${revision}`);
    const documentInstanceId = requireDocumentInstanceId('instance-a');
    return {
        ...scope,
        documentSessionKey: 'session-a',
        documentInstanceId,
        documentRef,
        documentBackend: 'electron',
        documentIdentity: {
            version: 1,
            authority: 'electron-working-copy',
            contentRevision: revision,
            documentRef,
            mintedAt: requireEpochMs(revision),
            token,
        },
        commandTarget: {
            kind: 'revision',
            tabId: scope.tabId!,
            sessionId: requireSessionId('session-a'),
            sessionRevision: revision,
            documentRef,
            documentBackend: 'electron',
            documentInstanceId,
            documentRevisionToken: token,
        },
    };
}

const steerImage = {
    type: 'image' as const,
    id: 'steer-image',
    name: 'page.png',
    mimeType: 'image/png',
    sizeBytes: 100,
    dataUrl: 'data:image/png;base64,c3RlZXI=',
    previewDataUrl: 'data:image/png;base64,cHJldmlldw==',
};

function createReadyState(
    phase: IAgentAssistantState['status']['turn']['phase'] = 'streaming',
    stateScope: IAgentAssistantChatScope = scope,
) {
    const state = createEmptyAssistantState({
        chatScope: stateScope,
        selectedProvider: 'codex',
        selectedModel: 'gpt-6-astra',
        selectedEffort: 'medium',
        selectedSpeedMode: 'standard',
    });
    state.status.installState = 'installed';
    state.status.authState = 'signed-in';
    state.status.runtimeState = phase === 'stalled' ? 'error' : 'busy';
    state.status.turn = {
        ...state.status.turn,
        id: 'turn-1',
        phase,
        reasoning: 'Inspecting document',
        lastEventAtMs: Date.now(),
    };
    if (phase === 'stalled') {
        state.status.error = 'No assistant signal received.';
        state.status.errorEnvelope = {
            code: 'INTERNAL',
            message: 'No assistant signal received.',
            retryable: true,
            details: {timestamp: requireEpochMs(Date.now())},
        };
    }
    state.messages = [
        {
            id: 'user-1',
            role: 'user',
            text: 'Summarize this document',
            createdAt: requireIsoTimestamp(new Date(0).toISOString()),
        },
        {
            id: 'assistant-1',
            role: 'assistant',
            text: 'Initial',
            pending: phase !== 'stalled',
            createdAt: requireIsoTimestamp(new Date(1).toISOString()),
        },
    ];
    return state;
}

function createUpdateState() {
    const state = createReadyState('idle');
    state.status = {
        ...state.status,
        codexVersion: '0.132.0',
        codexVersionSupported: false,
        authState: 'unknown',
        runtimeState: 'stopped',
    };
    state.messages = [];
    return state;
}

let unmountHarness = () => {};
afterEach(() => unmountHarness());

async function mountHarness(initialState: IAgentAssistantState | null) {
    if (initialState) {
        mocks.getAssistantState.mockResolvedValue(initialState);
    }
    mocks.interruptAssistant.mockResolvedValue(createReadyState('cancelled'));
    mocks.sendAssistantMessage.mockResolvedValue({
        ok: true,
        state: createReadyState('queued'),
    });
    const panelProps = reactive({
        chatScope: initialState?.scope ?? scope,
        isChatScopePending: false,
        activeDocumentName: 'Document A',
        hasActiveDocument: true,
        hasAnyDocument: true,
    });
    const host = document.createElement('div');
    document.body.append(host);
    const Harness = defineComponent({setup() {
        const controller = useAgentAssistantPanelController(panelProps);
        const button = (className: string, label: string, onClick: () => unknown) => h('button', {
            class: className,
            onClick,
        }, label);
        return () => h('section', [
            h('output', {class: 'phase'}, controller.status.value.turn.phase),
            h('output', {class: 'tools'}, controller.turnToolActivity.value.map(tool => tool.name + ':' + tool.phase).join(',')),
            h('output', {class: 'reasoning'}, controller.turnReasoning.value),
            h('output', {class: 'panel-view'}, controller.panelView.value),
            h('output', {class: 'install-progress'}, controller.installProgress.value),
            h('output', {class: 'install-error'}, controller.status.value.error),
            h('output', {class: 'installing'}, String(controller.isInstalling.value)),
            h('output', {class: 'can-send'}, String(controller.canSend.value)),
            h('output', {class: 'is-refreshing'}, String(controller.isRefreshingScope.value)),
            h('output', {class: 'model'}, controller.status.value.model),
            button('set-draft', 'Set draft', () => {
                controller.draft.value = 'Continue';
            }),
            button('edit-draft', 'Edit draft', () => {
                controller.draft.value = 'New draft';
            }),
            button('set-image', 'Set image', () => {
                controller.composerImages.value = [{...steerImage}];
            }),
            button('remove-image', 'Remove image', () => controller.removeComposerImage(steerImage.id)),
            button('send', 'Send', controller.handleSendMessage),
            h('textarea', {
                class: 'composer',
                value: controller.draft.value,
                disabled: controller.hasQueuedSteer.value,
            }),
            button('switch-provider', 'Claude', () => controller.updateProvider('claude')),
            h('output', {class: 'draft'}, controller.draft.value),
            h('output', {class: 'queued'}, String(controller.hasQueuedSteer.value)),
            h('output', {class: 'image-count'}, String(controller.composerImages.value.length)),
            h('output', {class: 'state-error'}, controller.status.value.error ?? ''),
            h('output', {class: 'composer-error'}, controller.composerError.value),
            h('output', {class: 'failure'}, controller.assistantFailurePresentation.value?.description ?? ''),
            button('install', 'Install', controller.handleInstallCodex),
            h('div', {
                class: 'messages',
                ref: controller.messagesRef,
            }, controller.renderedMessages.value.map(
                ({message}) => h('p', {key: message.id}, message.text),
            )),
            controller.canRetryAssistantError.value
                ? button('retry', 'Retry', controller.retryLastAssistantMessage)
                : null,
        ]);
    }});
    const app = createApp(Harness);
    app.mount(host);
    await nextTick();
    await nextTick();
    unmountHarness = () => {
        app.unmount();
        host.remove();
    };
    return {
        host,
        setScope(nextScope: IAgentAssistantChatScope) {
            panelProps.chatScope = nextScope;
        },
        setScopePending(pending: boolean) {
            panelProps.isChatScopePending = pending;
        },
    };
}

describe('mounted assistant panel lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        assistantEvent.dispose();
        window.localStorage.clear();
    });

    it('renders progress-only tool updates once and rejects a late older-turn update', async () => {
        const harness = await mountHarness(createReadyState());
        const emitTool = (phase: 'running' | 'completed' | 'failed', turnGeneration = 8) => assistantEvent.emit({
            type: 'turn-progress',
            phase: phase === 'running' ? 'tool-running' : 'finalizing',
            toolActivity: {
                toolId: 'read-1',
                name: 'read_document',
                phase,
                startedAtMs: requireEpochMs(1),
            },
            binding: {
                scopeFingerprint: buildAgentAssistantScopeFingerprint('codex', scope),
                sessionKey: 'codex:document-a',
                turnGeneration,
                windowId: 1,
            },
        });
        for (const phase of [
            'running',
            'completed',
            'failed',
        ] as const) {
            emitTool(phase);
            await nextTick();
            expect(harness.host.querySelector('.tools')?.textContent).toBe('read_document:' + phase);
            expect(harness.host.querySelector('.phase')?.textContent).toBe(phase === 'running' ? 'tool-running' : 'finalizing');
        }
        emitTool('running', 7);
        await nextTick();
        expect(harness.host.querySelector('.tools')?.textContent).toBe('read_document:failed');
        expect(harness.host.querySelector('.messages')?.textContent).toContain('Initial');
    });

    it('preserves composed text and images when page-label Save commits a new revision', async () => {
        const harness = await mountHarness(createReadyState('idle', revisionScope(1)));
        (harness.host.querySelector('.set-draft') as HTMLButtonElement).click();
        (harness.host.querySelector('.set-image') as HTMLButtonElement).click();
        const savedScope = revisionScope(2);
        mocks.getAssistantState.mockResolvedValue(createReadyState('idle', savedScope));
        harness.setScope(savedScope);
        await nextTick();
        await nextTick();

        expect(harness.host.querySelector('.draft')?.textContent).toBe('Continue');
        expect(harness.host.querySelector('.image-count')?.textContent).toBe('1');
        await vi.waitFor(() => expect(harness.host.querySelector('.can-send')?.textContent).toBe('true'));
        expect(mocks.sendAssistantMessage).not.toHaveBeenCalled();
    });

    it('makes an interrupted queued correction editable after Save and rejects old turn completions', async () => {
        const oldScope = revisionScope(1);
        const savedScope = revisionScope(2);
        const harness = await mountHarness(createReadyState('streaming', oldScope));
        let resolveInterrupt: ((state: IAgentAssistantState) => void) | undefined;
        mocks.interruptAssistant.mockReturnValueOnce(new Promise(resolve => {resolveInterrupt = resolve;}));
        (harness.host.querySelector('.set-draft') as HTMLButtonElement).click();
        (harness.host.querySelector('.set-image') as HTMLButtonElement).click();
        (harness.host.querySelector('.send') as HTMLButtonElement).click();
        await nextTick();
        expect((harness.host.querySelector('.composer') as HTMLTextAreaElement).disabled).toBe(true);
        mocks.getAssistantState.mockResolvedValue(createReadyState('idle', savedScope));
        harness.setScope(savedScope);
        await nextTick();
        resolveInterrupt?.(createReadyState('cancelled', oldScope));
        assistantEvent.emit({
            type: 'state',
            state: createReadyState('streaming', oldScope),
        });
        await nextTick();
        await nextTick();

        expect(harness.host.querySelector('.phase')?.textContent).toBe('idle');
        expect(harness.host.querySelector('.queued')?.textContent).toBe('false');
        expect(harness.host.querySelector('.composer-error')?.textContent).toBe('assistant.steerDraftRestored');
        expect(harness.host.querySelector('.draft')?.textContent).toBe('Continue');
        expect(harness.host.querySelector('.image-count')?.textContent).toBe('1');
        expect((harness.host.querySelector('.composer') as HTMLTextAreaElement).disabled).toBe(false);
        expect(mocks.sendAssistantMessage).not.toHaveBeenCalled();
        // Cancellation targets the old revision; a later explicit Send uses the new one.
        expect(mocks.interruptAssistant).toHaveBeenCalledWith(expect.objectContaining({scope: oldScope}));
        (harness.host.querySelector('.send') as HTMLButtonElement).click();
        await nextTick();
        expect(mocks.sendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
            scope: savedScope,
            text: 'Continue',
            attachments: [steerImage],
        }));
    });

    it('does not let a stale queued send clear newer composed text or images', async () => {
        const oldScope = revisionScope(1);
        const savedScope = revisionScope(2);
        const harness = await mountHarness(createReadyState('streaming', oldScope));
        mocks.interruptAssistant.mockResolvedValue(createReadyState('cancelled', oldScope));
        let resolveSend: ((result: {
            ok: true;
            state: IAgentAssistantState
        }) => void) | undefined;
        mocks.sendAssistantMessage.mockReturnValueOnce(new Promise(resolve => {resolveSend = resolve;}));
        (harness.host.querySelector('.set-draft') as HTMLButtonElement).click();
        (harness.host.querySelector('.set-image') as HTMLButtonElement).click();
        (harness.host.querySelector('.send') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(mocks.sendAssistantMessage).toHaveBeenCalledOnce());
        mocks.getAssistantState.mockResolvedValue(createReadyState('idle', savedScope));
        harness.setScope(savedScope);
        await nextTick();
        (harness.host.querySelector('.edit-draft') as HTMLButtonElement).click();
        resolveSend?.({
            ok: true,
            state: createReadyState('queued', oldScope),
        });
        await nextTick();
        await nextTick();

        expect(harness.host.querySelector('.phase')?.textContent).toBe('idle');
        expect(harness.host.querySelector('.draft')?.textContent).toBe('New draft');
        expect(harness.host.querySelector('.image-count')?.textContent).toBe('1');
        expect(harness.host.querySelector('.queued')?.textContent).toBe('false');
        expect(harness.host.querySelector('.can-send')?.textContent).toBe('true');
    });

    it.each([
        [
            'another document',
            secondScope,
        ],
        [
            'another tab',
            {
                ...revisionScope(1),
                tabId: requireTabId('tab-linked'),
            },
        ],
        [
            'a reopened document',
            {
                ...revisionScope(1),
                documentSessionKey: 'session-reopened',
            },
        ],
        [
            'another document instance',
            {
                ...revisionScope(1),
                documentInstanceId: requireDocumentInstanceId('instance-b'),
            },
        ],
    ])('clears composed work on a deliberate switch to %s', async (_name, nextScope) => {
        const harness = await mountHarness(createReadyState('idle', revisionScope(1)));
        (harness.host.querySelector('.set-draft') as HTMLButtonElement).click();
        (harness.host.querySelector('.set-image') as HTMLButtonElement).click();
        mocks.getAssistantState.mockResolvedValue(createReadyState('idle', nextScope));
        harness.setScope(nextScope);
        await nextTick();
        await nextTick();
        expect(harness.host.querySelector('.draft')?.textContent).toBe('');
        expect(harness.host.querySelector('.image-count')?.textContent).toBe('0');
        harness.setScope(revisionScope(1));
        await nextTick();
        expect(harness.host.querySelector('.draft')?.textContent).toBe('');
    });

    it('clears composed work on a deliberate provider switch', async () => {
        const harness = await mountHarness(createReadyState('idle', revisionScope(1)));
        (harness.host.querySelector('.set-draft') as HTMLButtonElement).click();
        (harness.host.querySelector('.set-image') as HTMLButtonElement).click();
        (harness.host.querySelector('.switch-provider') as HTMLButtonElement).click();
        await nextTick();
        expect(harness.host.querySelector('.draft')?.textContent).toBe('');
        expect(harness.host.querySelector('.image-count')?.textContent).toBe('0');
    });

    it('uses the current Codex fallback before the first backend state resolves', async () => {
        mocks.getAssistantState.mockReturnValueOnce(new Promise(() => undefined));
        const harness = await mountHarness(null);

        expect(harness.host.querySelector('.model')?.textContent).toBe('gpt-6.1-sol');
    });

    it('keeps the rendered chat mounted while a tab scope refreshes', async () => {
        const initialState = createReadyState('idle');
        const nextState = createReadyState('idle', secondScope);
        nextState.messages[0]!.text = 'Document B response';
        const harness = await mountHarness(initialState);
        let resolveRefresh: ((state: IAgentAssistantState) => void) | undefined;
        mocks.getAssistantState.mockReturnValueOnce(new Promise(resolve => {
            resolveRefresh = resolve;
        }));

        harness.setScope(secondScope);
        await nextTick();

        expect(harness.host.querySelector('.messages')?.textContent).toContain('Initial');
        expect(harness.host.querySelector('.is-refreshing')?.textContent).toBe('true');

        resolveRefresh?.(nextState);
        await vi.waitFor(() => {
            expect(harness.host.querySelector('.messages')?.textContent).toContain('Document B response');
        });
        expect(harness.host.querySelector('.is-refreshing')?.textContent).toBe('false');
    });

    it('keeps the rendered chat mounted while the next document session is pending', async () => {
        const initialState = createReadyState('idle');
        const nextState = createReadyState('idle', secondScope);
        nextState.messages[0]!.text = 'Document B response';
        const harness = await mountHarness(initialState);
        mocks.getAssistantState.mockClear();
        let resolveRefresh: ((state: IAgentAssistantState) => void) | undefined;
        mocks.getAssistantState.mockReturnValueOnce(new Promise(resolve => {
            resolveRefresh = resolve;
        }));

        harness.setScopePending(true);
        harness.setScope(secondScope);
        await nextTick();

        expect(harness.host.querySelector('.messages')?.textContent).toContain('Initial');
        expect(harness.host.querySelector('.is-refreshing')?.textContent).toBe('false');
        expect(mocks.getAssistantState).not.toHaveBeenCalled();

        harness.setScopePending(false);
        await nextTick();
        expect(harness.host.querySelector('.is-refreshing')?.textContent).toBe('true');

        resolveRefresh?.(nextState);
        await vi.waitFor(() => {
            expect(harness.host.querySelector('.messages')?.textContent).toContain('Document B response');
        });
    });

    it('shows the current Codex fallback while an unavailable saved model waits for discovery', async () => {
        window.localStorage.setItem(STORAGE_KEYS.ASSISTANT_SELECTION, JSON.stringify({
            provider: 'codex',
            modelsByProvider: {codex: 'gpt-5.4'},
        }));
        mocks.getAssistantState.mockReturnValueOnce(new Promise(() => undefined));
        const harness = await mountHarness(null);

        expect(harness.host.querySelector('.model')?.textContent).toBe('gpt-6.1-sol');
    });

    it('renders a stalled turn and retries the last user message', async () => {
        const harness = await mountHarness(createReadyState('stalled'));
        expect(harness.host.querySelector('.phase')?.textContent).toBe('stalled');
        expect(harness.host.querySelector('.reasoning')?.textContent).toBe('Inspecting document');

        (harness.host.querySelector('.retry') as HTMLButtonElement).click();
        await nextTick();
        await nextTick();

        expect(mocks.sendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
            text: 'Summarize this document',
            scope,
        }));
    });

    it('interrupts once and sends one image-only steer after the turn stops', async () => {
        const harness = await mountHarness(createReadyState());
        const setImage = harness.host.querySelector('.set-image') as HTMLButtonElement;
        const send = harness.host.querySelector('.send') as HTMLButtonElement;

        setImage.click();
        await nextTick();
        send.click();
        send.click();

        await vi.waitFor(() => {
            expect(mocks.sendAssistantMessage).toHaveBeenCalledOnce();
        });

        expect(mocks.interruptAssistant).toHaveBeenCalledOnce();
        expect(mocks.sendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
            text: '',
            attachments: [steerImage],
            scope,
        }));
        expect(harness.host.querySelector('.queued')?.textContent).toBe('false');
        expect(harness.host.querySelector('.draft')?.textContent).toBe('');
        expect(harness.host.querySelector('.image-count')?.textContent).toBe('0');
    });

    it('hides retry while a stalled turn has a queued steer', async () => {
        mocks.interruptAssistant.mockReturnValueOnce(new Promise(() => undefined));
        const harness = await mountHarness(createReadyState('stalled'));

        (harness.host.querySelector('.set-draft') as HTMLButtonElement).click();
        (harness.host.querySelector('.send') as HTMLButtonElement).click();
        await nextTick();

        expect(harness.host.querySelector('.queued')?.textContent).toBe('true');
        expect(harness.host.querySelector('.retry')).toBeNull();
    });

    it('keeps a queued text-and-image steer visible and does not replace it', async () => {
        const harness = await mountHarness(createReadyState());
        const setImage = harness.host.querySelector('.set-image') as HTMLButtonElement;
        const setDraft = harness.host.querySelector('.set-draft') as HTMLButtonElement;
        const send = harness.host.querySelector('.send') as HTMLButtonElement;

        setImage.click();
        setDraft.click();
        await nextTick();
        send.click();
        await nextTick();

        expect(harness.host.querySelector('.queued')?.textContent).toBe('true');
        expect(harness.host.querySelector('.draft')?.textContent).toBe('Continue');
        expect(harness.host.querySelector('.image-count')?.textContent).toBe('1');
        send.click();
        expect(mocks.interruptAssistant).toHaveBeenCalledOnce();

        await vi.waitFor(() => {
            expect(mocks.sendAssistantMessage).toHaveBeenCalledOnce();
        });
        expect(mocks.sendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
            text: 'Continue',
            attachments: [steerImage],
        }));
    });

    it('restores a failed queued steer as an editable draft without retrying it', async () => {
        const harness = await mountHarness(createReadyState());
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        mocks.sendAssistantMessage.mockRejectedValueOnce(new Error('send failed'));

        (harness.host.querySelector('.set-image') as HTMLButtonElement).click();
        (harness.host.querySelector('.set-draft') as HTMLButtonElement).click();
        (harness.host.querySelector('.send') as HTMLButtonElement).click();

        await vi.waitFor(() => expect(mocks.sendAssistantMessage).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(harness.host.querySelector('.queued')?.textContent).toBe('false'));
        expect(harness.host.querySelector('.draft')?.textContent).toBe('Continue');
        expect(harness.host.querySelector('.image-count')?.textContent).toBe('1');

        await nextTick();
        await nextTick();
        expect(mocks.sendAssistantMessage).toHaveBeenCalledOnce();
    });

    it('restores a resolved refusal as an editable ordinary draft with its image and error', async () => {
        const refusalState = createReadyState('idle');
        refusalState.status.runtimeState = 'error';
        refusalState.status.error = 'Assistant is unavailable.';
        refusalState.status.errorEnvelope = {
            code: 'INTERNAL',
            message: 'Assistant is unavailable.',
            retryable: false,
            details: {timestamp: requireEpochMs(Date.now())},
        };
        mocks.sendAssistantMessage.mockResolvedValueOnce({
            ok: false,
            state: refusalState,
            error: 'Assistant is unavailable.',
            errorEnvelope: refusalState.status.errorEnvelope,
        });
        const harness = await mountHarness(createReadyState('idle'));

        (harness.host.querySelector('.set-image') as HTMLButtonElement).click();
        (harness.host.querySelector('.set-draft') as HTMLButtonElement).click();
        (harness.host.querySelector('.send') as HTMLButtonElement).click();

        await vi.waitFor(() => expect(mocks.sendAssistantMessage).toHaveBeenCalledOnce());
        await nextTick();
        expect(harness.host.querySelector('.draft')?.textContent).toBe('Continue');
        expect(harness.host.querySelector('.image-count')?.textContent).toBe('1');
        expect(harness.host.querySelector('.failure')?.textContent).toBe('Assistant is unavailable.');
        expect(harness.host.querySelector('.state-error')?.textContent).toBe('Assistant is unavailable.');
    });

    it('restores a resolved refusal for queued steering without retrying it', async () => {
        const refusalState = createReadyState('idle');
        refusalState.status.runtimeState = 'error';
        refusalState.status.error = 'Busy in another document.';
        refusalState.status.errorEnvelope = {
            code: 'INTERNAL',
            message: 'Busy in another document.',
            retryable: false,
            details: {timestamp: requireEpochMs(Date.now())},
        };
        mocks.sendAssistantMessage.mockResolvedValueOnce({
            ok: false,
            state: refusalState,
            error: 'Busy in another document.',
            errorEnvelope: refusalState.status.errorEnvelope,
        });
        const harness = await mountHarness(createReadyState());

        (harness.host.querySelector('.set-image') as HTMLButtonElement).click();
        (harness.host.querySelector('.set-draft') as HTMLButtonElement).click();
        (harness.host.querySelector('.send') as HTMLButtonElement).click();

        await vi.waitFor(() => expect(mocks.sendAssistantMessage).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(harness.host.querySelector('.queued')?.textContent).toBe('false'));
        expect(harness.host.querySelector('.draft')?.textContent).toBe('Continue');
        expect(harness.host.querySelector('.image-count')?.textContent).toBe('1');
        expect(harness.host.querySelector('.failure')?.textContent).toBe('Busy in another document.');
    });

    it('does not restore a resolved recorded failure and retries its exact recorded turn', async () => {
        const recordedFailureState = createReadyState('stalled');
        recordedFailureState.messages = [
            ...recordedFailureState.messages,
            {
                id: 'recorded-user',
                role: 'user',
                text: 'Continue',
                attachments: [cast<IAgentAssistantImageAttachment>({
                    ...steerImage,
                    previewDataUrl: undefined,
                })],
                createdAt: requireIsoTimestamp(new Date(2).toISOString()),
            },
        ];
        recordedFailureState.status.error = 'Provider failed after recording the turn.';
        recordedFailureState.status.errorEnvelope = {
            code: 'INTERNAL',
            message: 'Provider failed after recording the turn.',
            retryable: true,
            details: {timestamp: requireEpochMs(Date.now())},
        };
        mocks.sendAssistantMessage.mockResolvedValueOnce({
            ok: false,
            state: recordedFailureState,
            error: 'Provider failed after recording the turn.',
            errorEnvelope: recordedFailureState.status.errorEnvelope,
        });
        const harness = await mountHarness(createReadyState('idle'));

        (harness.host.querySelector('.set-image') as HTMLButtonElement).click();
        (harness.host.querySelector('.set-draft') as HTMLButtonElement).click();
        (harness.host.querySelector('.send') as HTMLButtonElement).click();

        await vi.waitFor(() => expect(mocks.sendAssistantMessage).toHaveBeenCalledOnce());
        await nextTick();
        expect(harness.host.querySelector('.draft')?.textContent).toBe('');
        expect(harness.host.querySelector('.image-count')?.textContent).toBe('0');
        expect(harness.host.querySelector('.retry')).not.toBeNull();

        (harness.host.querySelector('.retry') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(mocks.sendAssistantMessage).toHaveBeenCalledTimes(2));
        expect(mocks.sendAssistantMessage).toHaveBeenLastCalledWith(expect.objectContaining({
            text: 'Continue',
            attachments: [{
                ...steerImage,
                previewDataUrl: undefined,
            }],
            scope,
        }));
    });

    it('does not let a resolved refusal overwrite edits made while the send is pending', async () => {
        let resolveSend: ((result: {
            ok: false;
            state: IAgentAssistantState;
            error: string;
            errorEnvelope: NonNullable<IAgentAssistantState['status']['errorEnvelope']>;
        }) => void) | undefined;
        const refusalState = createReadyState('idle');
        refusalState.status.runtimeState = 'error';
        refusalState.status.error = 'Provider unavailable.';
        refusalState.status.errorEnvelope = {
            code: 'RUNTIME_UNAVAILABLE',
            message: 'Provider unavailable.',
            retryable: false,
            details: {timestamp: requireEpochMs(Date.now())},
        };
        mocks.sendAssistantMessage.mockReturnValueOnce(new Promise(resolve => {
            resolveSend = resolve;
        }));
        const harness = await mountHarness(createReadyState('idle'));

        (harness.host.querySelector('.set-image') as HTMLButtonElement).click();
        (harness.host.querySelector('.set-draft') as HTMLButtonElement).click();
        (harness.host.querySelector('.send') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(mocks.sendAssistantMessage).toHaveBeenCalledOnce());

        (harness.host.querySelector('.edit-draft') as HTMLButtonElement).click();
        (harness.host.querySelector('.remove-image') as HTMLButtonElement).click();
        resolveSend?.({
            ok: false,
            state: refusalState,
            error: 'Provider unavailable.',
            errorEnvelope: refusalState.status.errorEnvelope,
        });

        await vi.waitFor(() => expect(harness.host.querySelector('.state-error')?.textContent).toBe('Provider unavailable.'));
        expect(harness.host.querySelector('.draft')?.textContent).toBe('New draft');
        expect(harness.host.querySelector('.image-count')?.textContent).toBe('0');
    });

    it('unlocks the composer when a terminal turn retains a stale busy runtime', async () => {
        const terminalState = createReadyState('done');
        terminalState.status.runtimeState = 'busy';
        terminalState.status.turn.id = null;
        const harness = await mountHarness(terminalState);

        (harness.host.querySelector('.set-draft') as HTMLButtonElement).click();
        await nextTick();

        expect(harness.host.querySelector('.can-send')?.textContent).toBe('true');
    });

    it('keeps the reader position while streaming when the message list is not near the bottom', async () => {
        const harness = await mountHarness(createReadyState());
        const messages = harness.host.querySelector('.messages') as HTMLDivElement;
        Object.defineProperties(messages, {
            scrollHeight: {
                configurable: true,
                value: 1_000,
            },
            clientHeight: {
                configurable: true,
                value: 100,
            },
        });
        messages.scrollTop = 120;

        assistantEvent.emit({
            type: 'message-delta',
            state: createReadyState(),
            messageId: 'assistant-1',
            delta: ' streamed',
        });
        await nextTick();

        expect(messages.scrollTop).toBe(120);
        expect(harness.host.textContent).toContain('Initial streamed');
    });

    it('shows accepted install progress and returns a failed update to a retryable state', async () => {
        let resolveInstall: (result: IAgentAssistantInstallResult) => void = () => undefined;
        mocks.installAssistantCodex.mockReturnValue(new Promise<IAgentAssistantInstallResult>(resolve => {
            resolveInstall = resolve;
        }));
        const updateState = createUpdateState();
        const harness = await mountHarness(updateState);

        (harness.host.querySelector('.install') as HTMLButtonElement).click();
        await nextTick();
        expect(harness.host.querySelector('.installing')?.textContent).toBe('true');

        assistantEvent.emit({
            type: 'install-progress',
            progress: 'Downloading verified Codex.',
            state: updateState,
        });
        await nextTick();
        expect(harness.host.querySelector('.install-progress')?.textContent).toBe('Downloading verified Codex.');

        const failedUpdateState = createUpdateState();
        failedUpdateState.status.error = 'The Codex download timed out.';
        resolveInstall({
            ok: false,
            state: failedUpdateState,
            error: 'The Codex download timed out.',
        });
        await nextTick();
        await nextTick();

        expect(harness.host.querySelector('.panel-view')?.textContent).toBe('update');
        expect(harness.host.querySelector('.installing')?.textContent).toBe('false');
        expect(harness.host.querySelector('.install-error')?.textContent).toBe('The Codex download timed out.');
    });
});
