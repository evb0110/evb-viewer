// @vitest-environment happy-dom

import {
    createApp,
    defineComponent,
    h,
    nextTick,
} from 'vue';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IAgentAssistantChatScope,
    IAgentAssistantEvent,
    IAgentAssistantInstallResult,
    IAgentAssistantState,
} from '@contracts/agent';
import {
    requireIsoTimestamp,
    requireEpochMs,
} from '@contracts/timestamps';
import {requireTabId} from '@contracts/windowTabs';
import { createEmptyAssistantState } from '@app/modules/agent-panel/utils/createEmptyAssistantState';
import { useAgentAssistantPanelController } from '@app/modules/agent-panel/composables/useAgentAssistantPanelController';
import { STORAGE_KEYS } from '@app/constants/storageKeys';

const mocks = vi.hoisted(() => ({
    eventSubscriber: null as ((event: IAgentAssistantEvent) => void) | null,
    getAssistantState: vi.fn(),
    installAssistantCodex: vi.fn(),
    sendAssistantMessage: vi.fn(),
    interruptAssistant: vi.fn(),
}));

vi.mock('@app/utils/getAgentCapability', () => ({getAgentCapability: () => ({
    getAssistantState: mocks.getAssistantState,
    sendAssistantMessage: mocks.sendAssistantMessage,
    interruptAssistant: mocks.interruptAssistant,
    resetAssistantChat: vi.fn(),
    installAssistantCodex: mocks.installAssistantCodex,
    startAssistantLogin: vi.fn(),
    cancelAssistantLogin: vi.fn(),
    onAssistantEvent: (subscriber: (event: IAgentAssistantEvent) => void) => {
        mocks.eventSubscriber = subscriber;
        return () => {
            mocks.eventSubscriber = null;
        };
    },
})}));
vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));
vi.mock('@app/composables/useRuntimeErrorReports', () => ({useRuntimeErrorReports: () => ({reportRuntimeError: vi.fn()})}));

const scope: IAgentAssistantChatScope = {
    kind: 'document',
    key: 'document-a',
    title: 'Document A',
    tabId: requireTabId('tab-a'),
};

const steerImage = {
    type: 'image' as const,
    id: 'steer-image',
    name: 'page.png',
    mimeType: 'image/png',
    sizeBytes: 100,
    dataUrl: 'data:image/png;base64,c3RlZXI=',
    previewDataUrl: 'data:image/png;base64,cHJldmlldw==',
};

function createReadyState(phase: IAgentAssistantState['status']['turn']['phase'] = 'streaming') {
    const state = createEmptyAssistantState({
        chatScope: scope,
        selectedProvider: 'codex',
        selectedModel: 'gpt-5.4',
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
            timestamp: requireEpochMs(Date.now()),
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

async function mountHarness(initialState: IAgentAssistantState | null) {
    if (initialState) {
        mocks.getAssistantState.mockResolvedValue(initialState);
    }
    mocks.interruptAssistant.mockResolvedValue(createReadyState('cancelled'));
    mocks.sendAssistantMessage.mockResolvedValue({
        ok: true,
        state: createReadyState('queued'),
    });
    const host = document.createElement('div');
    document.body.append(host);
    const Harness = defineComponent({setup() {
        const controller = useAgentAssistantPanelController({
            chatScope: scope,
            activeDocumentName: 'Document A',
            hasActiveDocument: true,
            hasAnyDocument: true,
        });
        return () => h('section', [
            h('output', {class: 'phase'}, controller.status.value.turn.phase),
            h('output', {class: 'reasoning'}, controller.turnReasoning.value),
            h('output', {class: 'panel-view'}, controller.panelView.value),
            h('output', {class: 'install-progress'}, controller.installProgress.value),
            h('output', {class: 'install-error'}, controller.status.value.error),
            h('output', {class: 'installing'}, String(controller.isInstalling.value)),
            h('output', {class: 'can-send'}, String(controller.canSend.value)),
            h('output', {class: 'model'}, controller.selectedModel.value),
            h('button', {
                class: 'set-draft',
                onClick: () => {
                    controller.draft.value = 'Continue';
                },
            }, 'Set draft'),
            h('button', {
                class: 'edit-draft',
                onClick: () => {
                    controller.draft.value = 'New draft';
                },
            }, 'Edit draft'),
            h('button', {
                class: 'set-image',
                onClick: () => {
                    controller.composerImages.value = [{...steerImage}];
                },
            }, 'Set image'),
            h('button', {
                class: 'remove-image',
                onClick: () => controller.removeComposerImage(steerImage.id),
            }, 'Remove image'),
            h('button', {
                class: 'send',
                onClick: controller.handleSendMessage,
            }, 'Send'),
            h('output', {class: 'draft'}, controller.draft.value),
            h('output', {class: 'queued'}, String(controller.hasQueuedSteer.value)),
            h('output', {class: 'image-count'}, String(controller.composerImages.value.length)),
            h('output', {class: 'state-error'}, controller.status.value.error ?? ''),
            h('output', {class: 'composer-error'}, controller.composerError.value),
            h('output', {class: 'failure'}, controller.assistantFailurePresentation.value?.description ?? ''),
            h('button', {
                class: 'set-retired-model',
                onClick: () => controller.updateModel('gpt-5.5'),
            }, 'Set retired model'),
            h('button', {
                class: 'install',
                onClick: controller.handleInstallCodex,
            }, 'Install'),
            h('div', {
                class: 'messages',
                ref: controller.messagesRef,
            }, controller.renderedMessages.value.map(
                ({message}) => h('p', {key: message.id}, message.text),
            )),
            controller.canRetryAssistantError.value
                ? h('button', {
                    class: 'retry',
                    onClick: controller.retryLastAssistantMessage,
                }, 'Retry')
                : null,
        ]);
    }});
    const app = createApp(Harness);
    app.mount(host);
    await nextTick();
    await nextTick();
    return {
        app,
        host,
        unmount() {
            app.unmount();
            host.remove();
        },
    };
}

describe('mounted assistant panel lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.eventSubscriber = null;
        window.localStorage.clear();
    });

    it('uses the current Codex fallback before the first backend state resolves', async () => {
        mocks.getAssistantState.mockReturnValueOnce(new Promise(() => undefined));
        const harness = await mountHarness(null);

        expect(harness.host.querySelector('.model')?.textContent).toBe('gpt-5.6-sol');
        harness.unmount();
    });

    it('replaces a persisted pre-5.6 Codex model before the first backend state resolves', async () => {
        window.localStorage.setItem(STORAGE_KEYS.ASSISTANT_SELECTION, JSON.stringify({
            provider: 'codex',
            modelsByProvider: {codex: 'gpt-5.4'},
        }));
        mocks.getAssistantState.mockReturnValueOnce(new Promise(() => undefined));
        const harness = await mountHarness(null);

        expect(harness.host.querySelector('.model')?.textContent).toBe('gpt-5.6-sol');
        harness.unmount();
    });

    it('replaces a persisted GPT-5.5 selection before the first backend state resolves', async () => {
        window.localStorage.setItem(STORAGE_KEYS.ASSISTANT_SELECTION, JSON.stringify({
            provider: 'codex',
            modelsByProvider: {codex: 'gpt-5.5'},
        }));
        mocks.getAssistantState.mockReturnValueOnce(new Promise(() => undefined));
        const harness = await mountHarness(null);

        expect(harness.host.querySelector('.model')?.textContent).toBe('gpt-5.6-sol');
        harness.unmount();
    });

    it('replaces a legacy persisted GPT-5.5 selection before the first backend state resolves', async () => {
        window.localStorage.setItem(STORAGE_KEYS.ASSISTANT_SELECTION, JSON.stringify({
            provider: 'codex',
            model: 'gpt-5.5',
        }));
        mocks.getAssistantState.mockReturnValueOnce(new Promise(() => undefined));
        const harness = await mountHarness(null);

        expect(harness.host.querySelector('.model')?.textContent).toBe('gpt-5.6-sol');
        harness.unmount();
    });

    it('ignores attempts to select the retired GPT-5.5 model', async () => {
        mocks.getAssistantState.mockReturnValueOnce(new Promise(() => undefined));
        const harness = await mountHarness(null);

        (harness.host.querySelector('.set-retired-model') as HTMLButtonElement).click();
        await nextTick();

        expect(harness.host.querySelector('.model')?.textContent).toBe('gpt-5.6-sol');
        expect(window.localStorage.getItem(STORAGE_KEYS.ASSISTANT_SELECTION)).toBeNull();
        harness.unmount();
    });

    it('allows another provider to use the same opaque model ID', async () => {
        window.localStorage.setItem(STORAGE_KEYS.ASSISTANT_SELECTION, JSON.stringify({
            provider: 'claude',
            modelsByProvider: {claude: 'claude-opus-4-6'},
        }));
        mocks.getAssistantState.mockReturnValueOnce(new Promise(() => undefined));
        const harness = await mountHarness(null);

        (harness.host.querySelector('.set-retired-model') as HTMLButtonElement).click();
        await nextTick();

        expect(harness.host.querySelector('.model')?.textContent).toBe('gpt-5.5');
        harness.unmount();
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
        harness.unmount();
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
        harness.unmount();
    });

    it('hides retry while a stalled turn has a queued steer', async () => {
        mocks.interruptAssistant.mockReturnValueOnce(new Promise(() => undefined));
        const harness = await mountHarness(createReadyState('stalled'));

        (harness.host.querySelector('.set-draft') as HTMLButtonElement).click();
        (harness.host.querySelector('.send') as HTMLButtonElement).click();
        await nextTick();

        expect(harness.host.querySelector('.queued')?.textContent).toBe('true');
        expect(harness.host.querySelector('.retry')).toBeNull();
        harness.unmount();
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
        harness.unmount();
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
        harness.unmount();
    });

    it('restores a resolved refusal as an editable ordinary draft with its image and error', async () => {
        const refusalState = createReadyState('idle');
        refusalState.status.runtimeState = 'error';
        refusalState.status.error = 'Assistant is unavailable.';
        refusalState.status.errorEnvelope = {
            code: 'INTERNAL',
            message: 'Assistant is unavailable.',
            retryable: false,
            timestamp: requireEpochMs(Date.now()),
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
        harness.unmount();
    });

    it('restores a resolved refusal for queued steering without retrying it', async () => {
        const refusalState = createReadyState('idle');
        refusalState.status.runtimeState = 'error';
        refusalState.status.error = 'Busy in another document.';
        refusalState.status.errorEnvelope = {
            code: 'INTERNAL',
            message: 'Busy in another document.',
            retryable: false,
            timestamp: requireEpochMs(Date.now()),
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
        harness.unmount();
    });

    it('does not restore a resolved recorded failure and retries its exact recorded turn', async () => {
        const recordedFailureState = createReadyState('stalled');
        recordedFailureState.messages = [
            ...recordedFailureState.messages,
            {
                id: 'recorded-user',
                role: 'user',
                text: 'Continue',
                attachments: [{
                    ...steerImage,
                    previewDataUrl: undefined,
                }],
                createdAt: requireIsoTimestamp(new Date(2).toISOString()),
            },
        ];
        recordedFailureState.status.error = 'Provider failed after recording the turn.';
        recordedFailureState.status.errorEnvelope = {
            code: 'INTERNAL',
            message: 'Provider failed after recording the turn.',
            retryable: true,
            timestamp: requireEpochMs(Date.now()),
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
        harness.unmount();
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
            timestamp: requireEpochMs(Date.now()),
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
        harness.unmount();
    });

    it('unlocks the composer when a terminal turn retains a stale busy runtime', async () => {
        const terminalState = createReadyState('done');
        terminalState.status.runtimeState = 'busy';
        terminalState.status.turn.id = null;
        const harness = await mountHarness(terminalState);

        (harness.host.querySelector('.set-draft') as HTMLButtonElement).click();
        await nextTick();

        expect(harness.host.querySelector('.can-send')?.textContent).toBe('true');
        harness.unmount();
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

        mocks.eventSubscriber?.({
            type: 'message-delta',
            state: createReadyState(),
            messageId: 'assistant-1',
            delta: ' streamed',
        });
        await nextTick();

        expect(messages.scrollTop).toBe(120);
        expect(harness.host.textContent).toContain('Initial streamed');
        harness.unmount();
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

        mocks.eventSubscriber?.({
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
        harness.unmount();
    });
});
