// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createApp, defineComponent, h, nextTick, reactive, ref, type Component} from 'vue';
import type {IAssistantChat, IAssistantEvent, IAssistantItem, IAssistantSelection, IAssistantState} from '@contracts/assistant';
import type {IAgentAssistantChatScope, IAgentAssistantErrorEnvelope} from '@contracts/agent';
import {requireIsoTimestamp, requireEpochMs} from '@contracts/timestamps';
import {requireTabId} from '@contracts/windowTabs';
import {createAssistantInstance, createAssistantState} from '@tests/helpers/createAgentAssistantStatus';
import AgentAssistantPanel from '@app/modules/agent-panel/components/AgentAssistantPanel.vue';
import AssistantComposer from '@app/modules/agent-panel/components/AssistantComposer.vue';
import AssistantTimeline from '@app/modules/agent-panel/components/AssistantTimeline.vue';
import AssistantProviderModelPicker from '@app/modules/agent-panel/components/AssistantProviderModelPicker.vue';
import {STORAGE_KEYS} from '@app/constants/storageKeys';

const api = vi.hoisted(() => ({
    getAssistantState: vi.fn(),
    sendAssistantMessage: vi.fn(),
    startAssistantLogin: vi.fn(),
    cancelAssistantLogin: vi.fn(),
    interruptAssistant: vi.fn(),
    resetAssistantChat: vi.fn(),
    onAssistantEvent: vi.fn(),
    reportRuntimeError: vi.fn(),
}));
vi.mock('@app/utils/getAgentCapability', () => ({getAgentCapability: () => api}));
vi.mock('@app/composables/useRuntimeErrorReports', () => ({useRuntimeErrorReports: () => ({reportRuntimeError: api.reportRuntimeError})}));
vi.mock('@app/composables/useTypedI18n', () => ({
    useTypedI18n: () => ({t: (key: string, params?: Record<string, string | number>) => key + (params ? JSON.stringify(params) : '')}),
}));
const scope: IAgentAssistantChatScope = {
    kind: 'document',
    key: 'a',
    title: 'A.pdf',
    tabId: requireTabId('tab-a'),
};
const selection = {
    instanceId: 'codex',
    model: 'gpt',
    effort: 'high',
    speedMode: 'standard',
} as const;
function item(id: string, kind: IAssistantItem['kind'], text: string, extra: Partial<IAssistantItem> = {}): IAssistantItem {
    return {
        id,
        kind,
        text,
        turnId: 'turn',
        status: 'completed',
        createdAt: requireIsoTimestamp('2026-11-12T00:00:00.000Z'),
        ...extra,
    };
}
function chat(items: IAssistantItem[] = []): IAssistantChat {
    return {
        sessionKey: 'codex:a',
        scope,
        instanceId: 'codex',
        model: 'gpt',
        items,
        turn: null,
    };
}
function envelope(
    message: string,
    retryable: boolean,
    code: IAgentAssistantErrorEnvelope['code'] = 'INTERNAL',
): IAgentAssistantErrorEnvelope {
    return {
        code,
        message,
        retryable,
        details: {timestamp: requireEpochMs(Date.now())},
    };
}
let current: IAssistantState;
let listener: (event: IAssistantEvent) => void;
const dispose = vi.fn();
const unmounts: Array<() => void> = [];
const Button = defineComponent({
    inheritAttrs: false,
    props: {
        label: String,
        disabled: Boolean,
        type: {
            type: String,
            default: 'button',
        },
    },
    setup:
        (props, {attrs, slots}) =>
        () =>
            h(
                'button',
                {
                    ...attrs,
                    type: props.type,
                    disabled: props.disabled,
                },
                [slots.leading?.(), props.label, slots.default?.()],
            ),
});
const Slot = defineComponent({
    props: {open: Boolean},
    setup:
        (props, {slots}) =>
        () =>
            h('div', {'data-open': String(props.open)}, [slots.default?.(), slots.content?.()]),
});
const Input = defineComponent({
    inheritAttrs: false,
    props: {modelValue: String},
    emits: ['update:modelValue'],
    setup: (props, {attrs, emit, expose}) => {
        const inputRef = ref<HTMLInputElement | null>(null);
        expose({inputRef});
        return () =>
            h('input', {
                ...attrs,
                ref: inputRef,
                value: props.modelValue,
                onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value),
            });
    },
});
function mount(
    component: Component = AgentAssistantPanel,
    props: Record<string, unknown> = {
        chatScope: scope,
        activeDocumentName: 'A.pdf',
    },
) {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(component, props)}));
    app.component('UButton', Button);
    app.component('UIcon', defineComponent({setup: () => () => h('span')}));
    app.component('AppTooltip', Slot);
    app.component('UPopover', Slot);
    app.component('UInput', Input);
    app.mount(host);
    unmounts.push(() => {
        app.unmount();
        host.remove();
    });
    return host;
}
async function settle() {
    for (let index = 0; index < 6; index++) {
        await nextTick();
    }
}
function button(host: HTMLElement, label: string) {
    const found = [...host.querySelectorAll('button')].find(
        (node) => node.textContent === label || node.getAttribute('aria-label') === label,
    );
    if (!found) {
        throw new Error('Missing button ' + label);
    }
    return found;
}
// The picker lists the open provider's models as options; a provider is chosen in its rail first.
async function pickModel(host: HTMLElement, label: string, instanceLabel?: string) {
    if (instanceLabel) {
        button(host, instanceLabel).click();
        await settle();
    }
    const row = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (node) => node.querySelector('.row-name')?.firstChild?.textContent === label,
    );
    if (!row) {
        throw new Error('Missing model ' + label);
    }
    row.click();
    await settle();
}
function radio(host: HTMLElement, label: string) {
    const found = [...host.querySelectorAll<HTMLButtonElement>('button[role="radio"]')].find((node) => node.textContent?.trim() === label);
    if (!found) {
        throw new Error('Missing choice ' + label);
    }
    return found;
}
async function draft(host: HTMLElement, text: string) {
    const input = host.querySelector('textarea');
    if (!input) {
        throw new Error('Missing composer');
    }
    input.value = text;
    input.dispatchEvent(new Event('input', {bubbles: true}));
    await settle();
}
beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    current = createAssistantState({chat: chat()});
    api.getAssistantState.mockImplementation(async () => current);
    api.sendAssistantMessage.mockImplementation(async () => ({
        ok: true,
        state: current,
    }));
    api.interruptAssistant.mockImplementation(async () => current);
    api.resetAssistantChat.mockImplementation(async () => current);
    api.startAssistantLogin.mockImplementation(async () => ({
        ok: true,
        state: current,
    }));
    api.onAssistantEvent.mockImplementation((callback: typeof listener) => {
        listener = callback;
        return dispose;
    });
});
afterEach(() => {
    unmounts.splice(0).forEach((unmount) => unmount());
});

describe('assistant renderer on instance contract', () => {
    it.each(['checking', 'warning', 'error'] as const)('keeps history and sending visible for a selected %s instance', async (state) => {
        current = createAssistantState({
            instances: [
                createAssistantInstance({
                    state,
                    message: 'initialize failed: actual network detail',
                }),
                createAssistantInstance({
                    id: 'other',
                    label: 'Other',
                    state: 'error',
                    message: 'OTHER FAILURE',
                }),
            ],
            chat: chat([item('answer', 'assistant', 'Existing **answer**')]),
        });
        const host = mount();
        await settle();
        expect(host.textContent).toContain('Existing');
        expect(host.querySelector('.provider-banner')?.textContent).not.toContain('OTHER FAILURE');
        if (state !== 'checking') {
            expect(host.querySelector('.provider-banner')?.textContent).toContain('initialize failed: actual network detail');
        }
        await draft(host, 'next message');
        const send = host.querySelector<HTMLButtonElement>('.composer-send');
        expect(send?.disabled).toBe(false);
        send?.click();
        await settle();
        expect(api.sendAssistantMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                text: 'next message',
                scope,
                selection,
            }),
        );
    });

    it('offers no sign-in for a failure that did not establish a missing login', async () => {
        current.instances[0] = createAssistantInstance({
            state: 'error',
            auth: 'unknown',
            message: 'Codex did not start within 10 seconds.',
            canSignIn: true,
        });
        const host = mount();
        await settle();
        expect(host.textContent).toContain('Codex did not start within 10 seconds.');
        expect([...host.querySelectorAll('button')].some((candidate) => candidate.textContent?.includes('assistant.signIn'))).toBe(false);
    });

    it('refreshes the selected instance and exposes device-code sign-in', async () => {
        current.instances[0] = createAssistantInstance({
            state: 'error',
            auth: 'unauthenticated',
            message: 'EXACT transport\nfailed',
            canSignIn: true,
        });
        const host = mount();
        await settle();
        button(host, 'assistant.refresh').click();
        await settle();
        expect(api.getAssistantState).toHaveBeenLastCalledWith({
            scope,
            selection,
            probe: true,
        });
        expect(host.querySelector('.provider-message')?.textContent).toContain('EXACT transport\nfailed');
        button(host, 'assistant.signInDeviceCode').click();
        await settle();
        expect(api.startAssistantLogin).toHaveBeenCalledWith({
            instanceId: 'codex',
            mode: 'device-code',
        });
    });

    it('applies current-session upserts/deltas/turns and ignores other keys', async () => {
        const host = mount();
        await settle();
        listener({
            type: 'item',
            sessionKey: 'other:a',
            item: item('other', 'assistant', 'WRONG'),
        });
        listener({
            type: 'item',
            sessionKey: 'codex:a',
            item: item('answer', 'assistant', 'Hello'),
        });
        listener({
            type: 'item-delta',
            sessionKey: 'codex:a',
            itemId: 'answer',
            delta: ' world',
        });
        await settle();
        expect(host.textContent).toContain('Hello world');
        listener({
            type: 'item',
            sessionKey: 'codex:a',
            item: item('answer', 'assistant', 'Replaced answer'),
        });
        listener({
            type: 'turn',
            sessionKey: 'codex:a',
            turn: {
                id: 'turn',
                phase: 'thinking',
                startedAtMs: Date.now() - 4000,
                usage: null,
            },
        });
        await settle();
        expect(host.textContent).toContain('Replaced answer');
        expect(host.textContent).not.toContain('WRONG');
        expect(host.querySelectorAll('.assistant-message')).toHaveLength(1);
        expect(host.textContent).toContain('assistant.workingFor');
        listener({
            type: 'turn',
            sessionKey: 'other:a',
            turn: null,
        });
        await settle();
        expect(host.querySelector('.timeline-working')).not.toBeNull();
        unmounts.pop()?.();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it('sends a draft as a steer while running and shows Stop only for an empty composer', async () => {
        current.chat = {
            ...chat(),
            turn: {
                id: 'turn',
                phase: 'streaming',
                startedAtMs: Date.now(),
                usage: null,
            },
        };
        const host = mount();
        await settle();
        button(host, 'assistant.stop').click();
        await settle();
        expect(api.interruptAssistant).toHaveBeenCalledWith({
            scope,
            instanceId: 'codex',
        });
        await draft(host, 'Use page 2');
        button(host, 'assistant.sendSteer').click();
        await settle();
        expect(api.sendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({text: 'Use page 2'}));
    });

    it('retries the failed turn with its own message and keeps the draft being typed', async () => {
        current.chat = chat([
            item('first', 'user', 'First question', {turnId: 'turn-1'}),
            item('first-failure', 'system', 'First failed', {
                turnId: 'turn-1',
                status: 'failed',
                errorEnvelope: envelope('First failed', true),
            }),
            item('second', 'user', 'Second question', {turnId: 'turn-2'}),
            item('second-reply', 'assistant', 'Answer', {turnId: 'turn-2'}),
        ]);
        const host = mount();
        await settle();
        await draft(host, 'Half-typed follow-up');
        button(host, 'assistant.turnRetry').click();
        await settle();
        expect(api.sendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({text: 'First question'}));
        expect((host.querySelector('.composer-input') as HTMLTextAreaElement).value).toBe('Half-typed follow-up');
    });

    it('does not retry another turn when the failed turn has no message left', async () => {
        current.chat = chat([
            item('orphan-failure', 'system', 'Old failure', {
                turnId: 'trimmed-turn',
                status: 'failed',
                errorEnvelope: envelope('Old failure', true),
            }),
            item('newer', 'user', 'Newer question', {turnId: 'turn-2'}),
        ]);
        const host = mount();
        await settle();
        button(host, 'assistant.turnRetry').click();
        await settle();
        expect(api.sendAssistantMessage).not.toHaveBeenCalled();
    });

    it('shows a failed reply once in the timeline and never also toasts it', async () => {
        const host = mount();
        await settle();
        api.sendAssistantMessage.mockImplementation(async () => ({
            ok: false,
            state: {
                ...current,
                chat: chat([
                    item('failure', 'system', 'Fallback', {
                        status: 'failed',
                        errorEnvelope: envelope('Exact provider failure', true),
                    }),
                ]),
            },
            error: envelope('Exact provider failure', true),
        }));
        await draft(host, 'Try this');
        button(host, 'assistant.send').click();
        await settle();
        expect(host.querySelectorAll('.timeline-error')).toHaveLength(1);
        expect(host.querySelector('.timeline-error')?.textContent).toContain('Exact provider failure');
        expect(api.reportRuntimeError).not.toHaveBeenCalled();
    });

    it('retains a pushed failure when the returned snapshot predates it', async () => {
        const host = mount();
        await settle();
        api.sendAssistantMessage.mockImplementation(async () => {
            const old = createAssistantState({chat: chat()});
            listener({
                type: 'item',
                sessionKey: 'codex:a',
                item: item('pushed-error', 'system', '', {
                    status: 'failed',
                    errorEnvelope: envelope('Pushed provider failure', true),
                }),
            });
            return {
                ok: false,
                state: old,
                error: envelope('Pushed provider failure', true),
            };
        });
        await draft(host, 'Try this');
        button(host, 'assistant.send').click();
        await settle();
        expect(host.querySelectorAll('.timeline-error')).toHaveLength(1);
        expect(host.querySelector('.timeline-error')?.textContent).toContain('Pushed provider failure');
        expect(api.reportRuntimeError).not.toHaveBeenCalled();
    });

    it('toasts refused sends only when there is no new system reply', async () => {
        api.sendAssistantMessage.mockResolvedValue({
            ok: false,
            state: current,
            error: envelope('Another document is busy', false),
        });
        const host = mount();
        await settle();
        await draft(host, 'Try this');
        button(host, 'assistant.send').click();
        await settle();
        expect(host.querySelector('.timeline-error')).toBeNull();
        expect(api.reportRuntimeError).toHaveBeenCalledOnce();
        expect(api.reportRuntimeError).toHaveBeenCalledWith(expect.objectContaining({description: 'Another document is busy'}));
        expect(host.querySelector('textarea')?.value).toBe('Try this');
    });

    it('retries only retryable errors with the last user text and original images, and treats completed system rows as notices', async () => {
        const attachments = [
            {
                type: 'image' as const,
                id: 'image',
                name: 'page.png',
                mimeType: 'image/png' as const,
                sizeBytes: 1,
                dataUrl: 'data:image/png;base64,AA==',
            },
        ];
        current.chat = chat([
            item('user', 'user', 'Read this', {attachments}),
            item('error', 'system', 'Fallback', {
                status: 'failed',
                errorEnvelope: envelope('Retry this failure', true),
            }),
            item('notice', 'system', 'Starts with a fresh context'),
        ]);
        const host = mount();
        await settle();
        expect(host.querySelectorAll('.timeline-error button')).toHaveLength(1);
        expect(host.querySelector('.timeline-notice')?.textContent).toContain('Starts with a fresh context');
        button(host, 'assistant.turnRetry').click();
        await settle();
        expect(api.sendAssistantMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                text: 'Read this',
                attachments,
            }),
        );
    });

    it('migrates the old selection and persists model/effort/speed under v2', async () => {
        localStorage.setItem(
            STORAGE_KEYS.ASSISTANT_SELECTION_LEGACY,
            JSON.stringify({
                provider: 'claude',
                model: 'sonnet',
            }),
        );
        current = createAssistantState({
            instances: [
                createAssistantInstance({
                    id: 'claude',
                    driver: 'claude',
                    defaultModel: 'sonnet',
                    models: [
                        {
                            id: 'sonnet',
                            label: 'Sonnet',
                        },
                    ],
                }),
            ],
            selection: null,
        });
        const host = mount();
        await settle();
        expect(host.querySelector('.picker-trigger')?.textContent).toContain('Sonnet');
        expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.ASSISTANT_SELECTION) ?? 'null')).toMatchObject({
            instanceId: 'claude',
            model: 'sonnet',
            speedMode: 'standard',
        });
    });

    it('falls back from a removed instance/model to the main selection and default model', async () => {
        localStorage.setItem(
            STORAGE_KEYS.ASSISTANT_SELECTION,
            JSON.stringify({
                ...selection,
                instanceId: 'removed',
                model: 'old',
            }),
        );
        const host = mount();
        await settle();
        expect(host.querySelector('.picker-trigger')?.textContent).toContain('GPT');
        expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.ASSISTANT_SELECTION) ?? 'null')).toEqual(selection);
    });

    it('shows auth reasons and hides disabled instances in the picker', async () => {
        current.instances[0] = createAssistantInstance({
            auth: 'unauthenticated',
            message: 'Real sign-in reason',
            canSignIn: true,
            state: 'warning',
        });
        current.instances.push(
            createAssistantInstance({
                id: 'disabled',
                label: 'HIDDEN',
                enabled: false,
                state: 'disabled',
            }),
        );
        const host = mount();
        await settle();
        await draft(host, 'hello');
        expect(host.querySelector('.composer-send')?.getAttribute('aria-label')).toBe('Real sign-in reason');
        expect(host.querySelector<HTMLButtonElement>('.composer-send')?.disabled).toBe(true);
        expect(host.querySelector('[data-model-picker]')?.textContent).not.toContain('HIDDEN');
    });

    it('switches instance/model/effort/speed atomically through the picker and sends its selection', async () => {
        current.instances.push(
            createAssistantInstance({
                id: 'codex-b',
                label: 'B',
                state: 'warning',
                message: 'B warning',
                models: [
                    {
                        id: 'gpt-b',
                        label: 'GPT B',
                        reasoningEfforts: [
                            {
                                id: 'low',
                                label: 'Low',
                            },
                            {
                                id: 'high',
                                label: 'High',
                            },
                        ],
                        defaultReasoningEffort: 'high',
                        serviceTiers: [
                            {
                                id: 'priority',
                                label: 'Fast',
                            },
                        ],
                    },
                ],
                defaultModel: 'gpt-b',
            }),
        );
        const host = mount();
        await settle();
        await pickModel(host, 'GPT B', 'B');
        radio(host, 'Low').click();
        await settle();
        radio(host, 'assistant.speedFast').click();
        await settle();
        expect(host.querySelector('.picker-trigger')?.getAttribute('aria-label')).toBe('B · GPT B · Low · assistant.speedFast');
        expect(host.querySelector('.trigger-model')?.textContent).toBe('GPT B');
        expect(host.querySelector('.trigger-effort')?.textContent).toBe('Low');
        expect(host.querySelector('.trigger-fast[name="i-ph-lightning-fill"]')).not.toBeNull();
        expect(host.querySelector('.provider-banner')?.textContent).toContain('B warning');
        await draft(host, 'Use B');
        button(host, 'assistant.send').click();
        await settle();
        expect(api.sendAssistantMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                selection: {
                    instanceId: 'codex-b',
                    model: 'gpt-b',
                    effort: 'low',
                    speedMode: 'fast',
                },
            }),
        );
    });

    it('keeps image-only retries and the image preview gallery', async () => {
        const attachments = ['one', 'two'].map((id) => ({
            type: 'image' as const,
            id,
            name: id + '.png',
            mimeType: 'image/png' as const,
            sizeBytes: 1,
            dataUrl: 'data:image/png;base64,AA==',
        }));
        current.chat = chat([
            item('user', 'user', '', {attachments}),
            item('error', 'system', 'Retry', {
                status: 'failed',
                errorEnvelope: envelope('Retry', true),
            }),
        ]);
        const host = mount();
        await settle();
        host.querySelector<HTMLButtonElement>('.message-images button')?.click();
        await settle();
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('one.png');
        window.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight'}));
        await settle();
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('two.png');
        window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
        await settle();
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        button(host, 'assistant.turnRetry').click();
        await settle();
        expect(api.sendAssistantMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                text: '',
                attachments,
            }),
        );
    });

    it('keeps typed text when the first selection arrives and clears it on later provider/document switches', async () => {
        const first = Promise.withResolvers<IAssistantState>();
        api.getAssistantState.mockReturnValueOnce(first.promise);
        current.instances.push(
            createAssistantInstance({
                id: 'codex-b',
                label: 'B',
                defaultModel: 'gpt-b',
                models: [{id: 'gpt-b', label: 'GPT B'}],
            }),
        );
        const props = reactive({chatScope: scope});
        const host = mount(AgentAssistantPanel, props);
        await draft(host, 'Typed before discovery finished');
        first.resolve(current);
        await settle();
        expect(host.querySelector('textarea')?.value).toBe('Typed before discovery finished');
        await pickModel(host, 'GPT B', 'B');
        expect(host.querySelector('textarea')?.value).toBe('');
        await draft(host, 'Draft for the first document');
        props.chatScope = {...scope, key: 'b'};
        await settle();
        expect(host.querySelector('textarea')?.value).toBe('');
    });

    it('retains the committed document and draft through a pending scope handoff', async () => {
        current.chat = chat([item('answer', 'assistant', 'Existing answer')]);
        const props = reactive({
            chatScope: scope,
            isChatScopePending: false,
        });
        const host = mount(AgentAssistantPanel, props);
        await settle();
        await draft(host, 'Keep this draft');
        props.isChatScopePending = true;
        await settle();
        expect(host.textContent).toContain('Existing answer');
        expect(host.querySelector('textarea')?.value).toBe('Keep this draft');
        expect(host.querySelector('.composer-send')?.getAttribute('aria-label')).toBe('assistant.documentPending');
        props.isChatScopePending = false;
        await settle();
        expect(host.querySelector('textarea')?.value).toBe('Keep this draft');
    });

    it('drops stale snapshots after switching scope', async () => {
        const first = Promise.withResolvers<IAssistantState>();
        api.getAssistantState.mockReturnValueOnce(first.promise);
        const props = reactive({chatScope: scope});
        const host = mount(AgentAssistantPanel, props);
        props.chatScope = {
            ...scope,
            key: 'b',
        };
        current.chat = {
            ...chat([item('b', 'assistant', 'New document')]),
            scope: props.chatScope,
            sessionKey: 'codex:b',
        };
        await settle();
        first.resolve(createAssistantState({chat: chat([item('a', 'assistant', 'STALE')])}));
        await settle();
        expect(host.textContent).not.toContain('STALE');
        expect(host.textContent).toContain('New document');
    });
});

describe('composer keyboard and picker', () => {
    it('handles IME, Shift+Enter and ordinary Enter without disabling draft editing during work', async () => {
        const submit = vi.fn();
        const host = mount(AssistantComposer, {
            modelValue: 'Hello',
            images: [],
            instances: current.instances,
            selection,
            sendDisabledReason: '',
            running: true,
            interrupting: false,
            hasDocument: true,
            error: '',
            onSubmit: submit,
        });
        const input = host.querySelector('textarea');
        input?.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                isComposing: true,
            }),
        );
        input?.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                shiftKey: true,
            }),
        );
        input?.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                keyCode: 229,
            }),
        );
        expect(submit).not.toHaveBeenCalled();
        input?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter'}));
        expect(submit).toHaveBeenCalledOnce();
        expect(input?.disabled).toBe(false);
    });
});

describe('timeline presentation and following', () => {
    it('groups only contiguous work within one turn and preserves interrupted text', async () => {
        const items = [
            item('user', 'user', 'Question'),
            item('think', 'reasoning', 'Reasoning'),
            item('tool', 'tool', '', {
                toolName: 'read_page',
                toolDetail: 'Page two',
            }),
            item('answer', 'assistant', '**Partial**', {status: 'interrupted'}),
            item('tool2', 'tool', '', {toolName: 'search'}),
        ];
        const host = mount(AssistantTimeline, {
            sessionKey: 'codex:a',
            items,
            turn: null,
            running: false,
            hasDocument: true,
            error: '',
            retryable: false,
            copyIcon: () => 'i-ph-copy',
            copyLabel: () => 'Copy',
        });
        expect(host.querySelectorAll('.work-group')).toHaveLength(2);
        expect(host.querySelector('strong')?.textContent).toBe('Partial');
        expect(host.textContent).toContain('assistant.interrupted');
        expect(host.querySelector('.work-group')?.hasAttribute('open')).toBe(false);
        expect(host.textContent).toContain('Page two');
    });

    it('releases follow on scroll and exposes a scroll-to-end action without jumping on new text', async () => {
        const props = reactive({
            sessionKey: 'codex:a',
            items: [item('answer', 'assistant', 'Answer')],
            turn: null,
            running: false,
            hasDocument: true,
            error: '',
            retryable: false,
            copyIcon: () => 'i-ph-copy',
            copyLabel: () => 'Copy',
        });
        const host = mount(AssistantTimeline, props);
        await settle();
        const viewport = host.querySelector<HTMLElement>('.assistant-timeline');
        if (!viewport) {
            throw new Error('Missing viewport');
        }
        Object.defineProperties(viewport, {
            scrollHeight: {
                configurable: true,
                value: 1200,
            },
            clientHeight: {
                configurable: true,
                value: 400,
            },
        });
        // The reader starts at the end and moves up.
        for (const top of [800, 100]) {
            viewport.scrollTop = top;
            viewport.dispatchEvent(new Event('scroll'));
        }
        await settle();
        props.items.push(item('next', 'assistant', 'More text'));
        await settle();
        expect(viewport.scrollTop).toBe(100);
        button(host, 'assistant.scrollToEnd').click();
        expect(viewport.scrollTop).toBe(1200);
    });
});

it('#1608 reports a failed assistant preference write after a model choice', async () => {
    const messages: string[] = [];
    api.reportRuntimeError.mockImplementation((presentation: {title: string; description?: string}) => {
        messages.push([presentation.title, presentation.description].filter(Boolean).join(' '));
    });
    current.instances[0] = createAssistantInstance({
        models: [
            {id: 'gpt', label: 'GPT'},
            {id: 'other', label: 'Other model'},
        ],
        defaultModel: 'gpt',
    });
    const host = mount();
    await settle();
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('Assistant preference quota exceeded', 'QuotaExceededError');
    });
    try {
        await pickModel(host, 'Other model');
        expect(host.querySelector('.picker-trigger')?.textContent).toContain('Other model');
        expect(messages.join(' ')).toMatch(/preference|saved|storage|quota/i);
    } finally {
        write.mockRestore();
    }
});

function timelineProps(items: IAssistantItem[], extra: Record<string, unknown> = {}) {
    return reactive({
        sessionKey: 'codex:a',
        items,
        turn: null,
        running: false,
        hasDocument: true,
        copyIcon: () => 'i-ph-copy',
        copyLabel: () => 'Copy',
        ...extra,
    });
}
function texts(host: HTMLElement, selector: string) {
    return [...host.querySelectorAll(selector)].map((node) => node.textContent ?? '');
}

describe('work rows name actions and show one state', () => {
    it('labels EVB tools in words, with icon and verb from the same item state', async () => {
        const host = mount(
            AssistantTimeline,
            timelineProps(
                [
                    item('user', 'user', 'Add bookmarks'),
                    item('snapshot', 'tool', '', {toolName: 'evb_workspace_snapshot'}),
                    item('pages', 'tool', '', {
                        toolName: 'mcp__evb__evb_read_document_pages',
                        status: 'streaming',
                    }),
                ],
                {
                    running: true,
                    turn: {
                        id: 'turn',
                        phase: 'tool-running',
                        startedAtMs: Date.now(),
                        usage: null,
                    },
                },
            ),
        );
        await settle();
        const summary = host.querySelector<HTMLElement>('.work-summary');
        expect(summary?.textContent).toBe('assistant.work.readActiveassistant.work.steps{"count":2}');
        expect(summary?.querySelector('[name="i-ph-circle-notch"]')).not.toBeNull();
        expect(texts(host, '.work-entry summary')).toEqual(['assistant.work.workspaceDone', 'assistant.work.readActive']);
        const icons = [...host.querySelectorAll('.work-entry summary')].map((row) => row.querySelector('.work-icon')?.getAttribute('name'));
        expect(icons).toEqual(['i-ph-check', 'i-ph-circle-notch']);
        expect(texts(host, '.work-tool-name')).toEqual(['evb_workspace_snapshot', 'mcp__evb__evb_read_document_pages']);
    });

    it('never pairs a check mark with a running label in an earlier group of a running turn', async () => {
        const host = mount(
            AssistantTimeline,
            timelineProps(
                [
                    item('user', 'user', 'Add bookmarks'),
                    item('snapshot', 'tool', '', {toolName: 'evb_workspace_snapshot'}),
                    item('progress', 'assistant', 'Small document. Reading all pages.', {status: 'streaming'}),
                    item('describe', 'tool', '', {
                        toolName: 'evb_describe_capability',
                        status: 'streaming',
                    }),
                ],
                {
                    running: true,
                    turn: {
                        id: 'turn',
                        phase: 'tool-running',
                        startedAtMs: Date.now(),
                        usage: null,
                    },
                },
            ),
        );
        await settle();
        const [earlier, live] = [...host.querySelectorAll<HTMLElement>('.work-summary')];
        expect(earlier?.textContent).toBe('assistant.work.workspaceDone');
        expect(earlier?.querySelector('.work-icon')?.getAttribute('name')).toBe('i-ph-check');
        expect(live?.textContent).toBe('assistant.work.capabilitiesActive');
        expect(live?.querySelector('.work-icon')?.getAttribute('name')).toBe('i-ph-circle-notch');
    });

    it('names a finished group by its most telling action and marks a failed one', async () => {
        const host = mount(
            AssistantTimeline,
            timelineProps([
                item('user-1', 'user', 'Add bookmarks', {turnId: 'turn-1'}),
                ...['evb_workspace_snapshot', 'evb_search_document', 'evb_run_action', 'some_other_tool'].map((toolName) =>
                    item(toolName, 'tool', '', {
                        toolName,
                        turnId: 'turn-1',
                    }),
                ),
                item('answer', 'assistant', 'Done', {turnId: 'turn-1'}),
                item('user-2', 'user', 'Again', {turnId: 'turn-2'}),
                item('think', 'reasoning', 'Considering', {turnId: 'turn-2'}),
                item('read', 'tool', '', {
                    toolName: 'evb_read_document_pages',
                    status: 'failed',
                    turnId: 'turn-2',
                }),
            ]),
        );
        await settle();
        const [finished, failed] = [...host.querySelectorAll<HTMLElement>('.work-summary')];
        expect(finished?.textContent).toBe('assistant.work.actionDoneassistant.work.steps{"count":4}');
        expect(failed?.textContent).toBe('assistant.work.readDoneassistant.toolPhaseFailedassistant.work.steps{"count":2}');
        expect(failed?.querySelector('.work-icon')?.getAttribute('name')).toBe('i-ph-warning-circle');
        expect(texts(host, '.work-entry summary')).toContain('assistant.work.toolDone');
        expect(texts(host, '.work-summary').join(' ')).not.toMatch(/evb_|some_other_tool/u);
    });
});

describe('failed replies, provider status and presets', () => {
    it('offers Change model instead of Retry when the model cannot run, and opens the picker', async () => {
        current.chat = chat([
            item('user', 'user', 'Add bookmarks'),
            item('failure', 'system', '', {
                status: 'failed',
                errorEnvelope: envelope('The model is not supported with this account.', false, 'MODEL_UNAVAILABLE'),
            }),
        ]);
        const host = mount();
        await settle();
        expect(host.querySelector('.timeline-error')?.textContent).toContain('The model is not supported with this account.');
        expect(host.querySelector('.timeline-error')?.textContent).not.toContain('{');
        expect(texts(host, '.timeline-error button')).toEqual(['assistant.changeModel']);
        const popover = host.querySelector('.picker-trigger')?.parentElement;
        expect(popover?.getAttribute('data-open')).toBe('false');
        button(host, 'assistant.changeModel').click();
        await settle();
        expect(popover?.getAttribute('data-open')).toBe('true');
        expect(api.sendAssistantMessage).not.toHaveBeenCalled();
    });

    it('offers Retry for a transient failure only', async () => {
        current.chat = chat([
            item('user', 'user', 'Add bookmarks'),
            item('failure', 'system', '', {
                status: 'failed',
                errorEnvelope: envelope('Codex app-server exited.', true, 'RUNTIME_UNAVAILABLE'),
            }),
        ]);
        const host = mount();
        await settle();
        expect(texts(host, '.timeline-error button')).toEqual(['assistant.turnRetry']);
    });

    it('reserves layout space for provider status instead of covering the conversation', async () => {
        current.instances[0] = createAssistantInstance({
            state: 'error',
            message: 'Codex app-server exited.',
        });
        current.chat = chat([item('user', 'user', 'Add bookmarks')]);
        const host = mount();
        await settle();
        const banner = host.querySelector('.provider-banner');
        expect(banner?.parentElement?.classList.contains('agent-assistant-panel')).toBe(true);
        expect(host.querySelector('.timeline-shell')?.contains(banner ?? null)).toBe(false);
        expect(banner?.nextElementSibling?.classList.contains('timeline-shell')).toBe(true);
    });

    it('renders preset chips the same way in the empty state and above the composer', async () => {
        const host = mount();
        await settle();
        const empty = [...host.querySelectorAll('.timeline-empty .assistant-presets button')].map((node) => node.outerHTML);
        expect(empty).toHaveLength(3);
        expect(empty.every((html) => /icon="i-ph-/u.test(html))).toBe(true);
        listener({
            type: 'item',
            sessionKey: 'codex:a',
            item: item('user', 'user', 'Hello'),
        });
        await settle();
        expect(host.querySelector('.timeline-empty')).toBeNull();
        expect([...host.querySelectorAll('.assistant-presets-footer .assistant-presets button')].map((node) => node.outerHTML)).toEqual(
            empty,
        );
    });
});

describe('model picker keyboard', () => {
    it('moves between effort rows and models with arrow keys and keeps one effort tab stop', async () => {
        const props = reactive({
            instances: [
                createAssistantInstance({
                    models: [
                        {
                            id: 'gpt',
                            label: 'GPT',
                            reasoningEfforts: ['low', 'medium', 'high'].map((id) => ({
                                id,
                                label: id,
                                isDefault: id === 'medium',
                            })),
                            defaultReasoningEffort: 'medium',
                        },
                        {
                            id: 'other',
                            label: 'Other model',
                        },
                    ],
                    defaultModel: 'gpt',
                }),
            ],
            selection: {...selection} as IAssistantSelection,
            onSelect: (next: IAssistantSelection) => {
                props.selection = next;
            },
        });
        const host = mount(AssistantProviderModelPicker, props);
        await settle();
        const efforts = [...host.querySelectorAll<HTMLButtonElement>('[data-effort-level]')];
        expect(efforts.map((row) => row.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);
        expect(efforts.map((row) => row.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
        expect(efforts[1]?.textContent).toBe('mediumassistant.effortDefault');
        efforts[2]?.focus();
        efforts[2]?.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'ArrowUp',
                bubbles: true,
            }),
        );
        expect(document.activeElement).toBe(efforts[1]);
        await settle();
        expect(efforts.map((row) => row.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
        expect(efforts.map((row) => row.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
        efforts[1]?.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'ArrowLeft',
                bubbles: true,
            }),
        );
        const search = host.querySelector<HTMLInputElement>('.search-input');
        expect(document.activeElement).toBe(search);
        const models = [...host.querySelectorAll<HTMLElement>('[role="option"]')];
        search?.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'ArrowDown',
                bubbles: true,
            }),
        );
        await settle();
        expect(search?.getAttribute('aria-activedescendant')).toBe(models[1]?.id);
        search?.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
            }),
        );
        await settle();
        expect(host.querySelector('.picker-trigger')?.textContent).toBe('Other model');
        expect(host.querySelector('[data-effort-level]')).toBeNull();
    });
});

describe('timeline viewport', () => {
    function geometry(viewport: HTMLElement, scrollHeight: number, clientHeight: number) {
        Object.defineProperties(viewport, {
            scrollHeight: {
                configurable: true,
                value: scrollHeight,
            },
            clientHeight: {
                configurable: true,
                value: clientHeight,
            },
        });
    }

    it('lets the reader scroll away and follows again when a new message is sent', async () => {
        const props = timelineProps([item('answer', 'assistant', 'Answer')]);
        const host = mount(AssistantTimeline, props);
        await settle();
        const viewport = host.querySelector<HTMLElement>('.assistant-timeline');
        if (!viewport) {
            throw new Error('Missing viewport');
        }
        geometry(viewport, 1200, 400);
        for (const top of [800, 100]) {
            viewport.scrollTop = top;
            viewport.dispatchEvent(new Event('scroll'));
        }
        await settle();
        expect(host.querySelector('.scroll-to-end')).not.toBeNull();
        props.items.push(item('next-user', 'user', 'Next question', {turnId: 'turn-2'}));
        await settle();
        expect(host.querySelector('.scroll-to-end')).toBeNull();
        expect(viewport.scrollTop).toBe(1200);
    });

    it('keeps following when a taller viewport pulls the view back to the end', async () => {
        const host = mount(AssistantTimeline, timelineProps([item('answer', 'assistant', 'Answer')]));
        await settle();
        const viewport = host.querySelector<HTMLElement>('.assistant-timeline');
        if (!viewport) {
            throw new Error('Missing viewport');
        }
        geometry(viewport, 1200, 400);
        viewport.scrollTop = 800;
        viewport.dispatchEvent(new Event('scroll'));
        // The provider banner collapses: the viewport grows and the browser clamps scrollTop.
        geometry(viewport, 1200, 444);
        viewport.scrollTop = 756;
        viewport.dispatchEvent(new Event('scroll'));
        await settle();
        expect(host.querySelector('.scroll-to-end')).toBeNull();
        viewport.scrollTop = 740;
        viewport.dispatchEvent(new Event('scroll'));
        await settle();
        expect(host.querySelector('.scroll-to-end'), 'A short move up off the end still releases following').not.toBeNull();
    });

    it('reserves space below a newly sent message so it starts near the top', async () => {
        const props = timelineProps([item('answer', 'assistant', 'Earlier answer')]);
        const host = mount(AssistantTimeline, props);
        await settle();
        const viewport = host.querySelector<HTMLElement>('.assistant-timeline');
        const content = host.querySelector<HTMLElement>('.timeline-content');
        if (!viewport || !content) {
            throw new Error('Missing timeline');
        }
        geometry(viewport, 700, 400);
        Object.defineProperty(content, 'offsetHeight', {
            configurable: true,
            value: 300,
        });
        const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            return DOMRect.fromRect({
                y: this.dataset.rowId === 'sent' ? 200 : 0,
                height: 0,
            });
        });
        try {
            props.items.push(item('sent', 'user', 'Add bookmarks', {turnId: 'turn-2'}));
            await settle();
            expect(host.querySelector<HTMLElement>('.timeline-anchor-space')?.style.height).toBe('300px');
        } finally {
            rect.mockRestore();
        }
    });
});
