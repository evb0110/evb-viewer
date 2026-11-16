import type * as FsPromises from 'node:fs/promises';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {IAssistantEvent} from '@contracts/assistant';
import {requireTabId} from '@contracts/windowTabs';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ClaudeAgentAssistantSession,
    normalizeClaudeSdkModelList,
    discoverClaudeAssistantModels,
    shouldRefuseClaudeContextContinuation,
} from '@electron/features/agent/claudeAgentSdkAssistant';
import {
    getClaudeAgentSdkInfo,
    resolveClaudeSdkExecutablePath,
} from '@electron/features/agent/claudeProviderMetadata';

const sdkMocks = vi.hoisted(() => ({
    readdir: vi.fn(),
    query: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({query: sdkMocks.query}));

vi.mock('node:fs/promises', async importOriginal => ({
    ...(await importOriginal<typeof FsPromises>()),
    readdir: sdkMocks.readdir,
}));

vi.mock('electron', () => ({ app: { getVersion: () => 'test' } }));

vi.mock('@electron/utils/createLogger', () => ({ createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}) }));

class FakeClaudeQuery {
    private readonly messages: unknown[] = [];
    private readonly resolvers: Array<(value: IteratorResult<unknown>) => void> = [];
    private closed = false;

    readonly accountInfo = vi.fn<() => Promise<unknown>>(async () => null);
    readonly initializationResult = async () => ({models: await this.supportedModels(), account: await this.accountInfo()});
    readonly supportedModels = vi.fn<() => Promise<unknown[]>>(async () => []);
    readonly setModel = vi.fn(async () => undefined);
    readonly interrupt = vi.fn(async () => undefined);
    readonly close = vi.fn(() => {
        this.closed = true;
        while (this.resolvers.length > 0) {
            const resolve = this.resolvers.shift();
            resolve?.({
                value: undefined,
                done: true,
            });
        }
    });

    push(message: unknown) {
        const resolver = this.resolvers.shift();
        if (resolver) {
            resolver({
                value: message,
                done: false,
            });
            return;
        }
        this.messages.push(message);
    }

    [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return {next: () => {
            if (this.closed) {
                return Promise.resolve({
                    value: undefined,
                    done: true,
                });
            }
            const message = this.messages.shift();
            if (message) {
                return Promise.resolve({
                    value: message,
                    done: false,
                });
            }
            return new Promise<IteratorResult<unknown>>(resolve => this.resolvers.push(resolve));
        }};
    }
}

async function settleAsyncTicks(count = 3) {
    for (let index = 0; index < count; index += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

describe('claudeAgentSdkAssistant', () => {
    it('keeps a Windows native wrapper identity and rejects named script wrappers readably', () => {
        vi.stubGlobal('process', {...process, platform: 'win32'});
        try {
            expect(resolveClaudeSdkExecutablePath('claude-proxy.exe')).toBe('claude-proxy.exe');
            for (const extension of ['cmd', 'bat', 'ps1']) {
                expect(() => resolveClaudeSdkExecutablePath(`claude-proxy.${extension}`)).toThrow('Select its native executable in Settings.');
            }
        } finally {
            vi.unstubAllGlobals();
        }
    });
    afterEach(() => vi.useRealTimers());
    beforeEach(() => {
        sdkMocks.readdir.mockReset();
        sdkMocks.readdir.mockImplementation(async (path: string) => path.endsWith('projects')
            ? ['fixture-project']
            : ['2c8c2b8a-6d31-4b77-a8c0-0aef9c8e2e5e.jsonl']);
        sdkMocks.query.mockReset();
    });

    it('keeps every reported family version in provider order', () => {
        expect(normalizeClaudeSdkModelList([
            {
                value: 'fable',
                resolvedModel: 'claude-fable-5-1',
                displayName: 'Fable',
            },
            {
                value: 'old-fable',
                resolvedModel: 'claude-fable-5',
                displayName: 'Fable',
            },
            {
                value: 'older-opus',
                resolvedModel: 'claude-opus-4-8',
                displayName: 'Opus',
            },
            {
                value: 'old-opus',
                resolvedModel: 'claude-opus-5-5',
                displayName: 'Opus',
            },
            {
                value: 'opus',
                resolvedModel: 'claude-opus-5-6',
                displayName: 'Opus',
            },
        ]).map(model => model.label)).toEqual([
            'Fable 5.1',
            'Fable 5',
            'Opus 4.8',
            'Opus 5.5',
            'Opus 5.6',
        ]);
    });

    it('labels every Claude row, including the reported default alias', () => {
        expect(normalizeClaudeSdkModelList([
            {
                value: 'default',
                resolvedModel: 'claude-opus-5-5[1m]',
                displayName: 'Default (recommended)',
            },
            {
                value: 'opus[1m]',
                resolvedModel: 'claude-opus-5-5[1m]',
                displayName: 'Opus (1M context)',
            },
            {
                value: 'fable',
                resolvedModel: 'claude-fable-5-1',
                displayName: 'Fable',
            },
            {
                value: 'opus',
                resolvedModel: 'claude-opus-5-5',
                displayName: 'Opus',
            },
            {
                value: 'custom',
                resolvedModel: 'vendor-model',
                displayName: 'Custom model',
            },
        ]).map(model => [
            model.id,
            model.label,
        ])).toEqual([
            ['default', 'Opus 5.5 (recommended)'],
            ['opus[1m]', 'Opus 5.5 (1M context)'],
            ['fable', 'Fable 5.1'],
            ['opus', 'Opus 5.5'],
            ['custom', 'Custom model'],
        ]);
    });

    it('normalizes Claude SDK supportedModels metadata', () => {
        expect(normalizeClaudeSdkModelList([
            {
                value: 'claude-fable-5-1',
                resolvedModel: 'claude-fable-5-1',
                displayName: 'Claude Fable 5.1 Runtime',
                supportedEffortLevels: [
                    'low',
                    'medium',
                ],
            },
            {
                value: 'claude-fable-5-1',
                displayName: 'Duplicate',
            },
            {
                value: 'claude-sonnet-5',
                displayName: 'Claude Sonnet 5',
            },
            {
                value: 'opus',
                resolvedModel: 'claude-opus-5-5',
                displayName: 'Claude Opus 5.5 Runtime',
                supportedEffortLevels: [
                    'medium',
                    'high',
                ],
            },
            {
                value: 'future-model',
                resolvedModel: 'claude-haiku-5-0',
                displayName: 'Future model',
            },
            {
                value: '',
                displayName: 'Blank',
            },
        ])).toEqual([
            {id: 'claude-fable-5-1', label: 'Fable 5.1', resolvedModel: 'claude-fable-5-1', reasoningEfforts: [{id: 'low', label: 'Low'}, {id: 'medium', label: 'Medium'}]},
            {id: 'claude-sonnet-5', label: 'Claude Sonnet 5'},
            {id: 'opus', label: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', reasoningEfforts: [{id: 'medium', label: 'Medium'}, {id: 'high', label: 'High'}]},
            {id: 'future-model', label: 'Haiku 5.0', resolvedModel: 'claude-haiku-5-0'},
        ]);
        expect(normalizeClaudeSdkModelList({data: []})).toEqual([]);
    });

    it('refuses continuation when display history has no provider-owned context', () => {
        expect(shouldRefuseClaudeContextContinuation(1, null)).toBe(true);
        expect(shouldRefuseClaudeContextContinuation(1, '')).toBe(true);
        expect(shouldRefuseClaudeContextContinuation(1, '   ')).toBe(true);
        expect(shouldRefuseClaudeContextContinuation(1, 'provider-session')).toBe(false);
        expect(shouldRefuseClaudeContextContinuation(0, null)).toBe(false);
    });

    it('does not fail setup when SDK package metadata is missing but env CLI exists', async () => {
        const result = await getClaudeAgentSdkInfo({
            env: {CLAUDE_CODE_PATH: '/opt/claude/bin/claude'},
            resolveSdkPackageDir: () => {
                throw new Error('Cannot find module @anthropic-ai/claude-agent-sdk');
            },
            findClaudeOnPath: vi.fn(async () => null),
            pathIsExecutable: vi.fn(async path => path === '/opt/claude/bin/claude'),
        });

        expect(result).toEqual({
            installed: true,
            version: null,
            executablePath: '/opt/claude/bin/claude',
        });
    });

    it('reports an actionable missing Claude CLI error when package metadata is unavailable', async () => {
        const result = await getClaudeAgentSdkInfo({
            env: {},
            resolveSdkPackageDir: () => {
                throw new Error('Cannot find module @anthropic-ai/claude-agent-sdk');
            },
            findClaudeOnPath: vi.fn(async () => null),
            pathIsExecutable: vi.fn(async () => false),
        });

        expect(result).toEqual({
            installed: false,
            version: null,
            executablePath: null,
            error: 'Claude Code executable was not found. Install Claude Code or set the executable in Settings.',
        });
    });

    it('does not use an SDK-bundled executable when the machine has no Claude installation', async () => {
        expect(await getClaudeAgentSdkInfo({env: {}, resolveSdkPackageDir: () => '/sdk', readSdkVersion: async () => '0.3.321', findClaudeOnPath: async () => null, pathIsExecutable: async () => false})).toMatchObject({installed: false, executablePath: null, version: '0.3.321'});
    });

    it.each(['success', 'error_during_execution'])('retains ordered snapshots and individual tool outcomes through %s', async (subtype) => {
        const fakeQuery = new FakeClaudeQuery();
        sdkMocks.query.mockReturnValue(fakeQuery);
        const events: unknown[] = [];
        const callbacks = {
            onInitialized: vi.fn(),
            onTurnStarted: vi.fn(),
            onReasoningDelta: vi.fn(),
            onToolActivity: (turnId: string | null, activity: unknown) => events.push({turnId, activity}),
            onUsage: vi.fn(),
            onAssistantMessage: (turnId: string | null, id: string, text: string) => events.push({turnId, id, text}),
            onTurnCompleted: vi.fn(),
            onError: vi.fn(),
        };
        const session = new ClaudeAgentAssistantSession({
            cwd: '/tmp',
            model: 'opus',
            effort: 'low',
            speedMode: 'standard',
            mcpServerName: 'evb_viewer_embedded',
            mcpServerUrl: 'http://127.0.0.1:3000',
            mcpToken: 'token',
            executablePath: '/usr/bin/claude',
            env: {
                CLAUDE_CONFIG_DIR: '/fixture/claude-home',
                INSTANCE_MARKER: 'fixture',
            },
            callbacks,
        });

        const turnId = await session.sendMessage('Hello', [], 'opus');
        fakeQuery.push({
            type: 'stream_event',
            event: {
                type: 'content_block_delta',
                delta: {
                    type: 'thinking_delta',
                    thinking: 'First inspect the document.',
                },
            },
        });
        fakeQuery.push({
            type: 'assistant',
            uuid: 'progress-1',
            message: { content: [{
                type: 'text',
                text: 'Inspecting the document.',
            }] },
        });
        fakeQuery.push({
            type: 'assistant',
            uuid: 'progress-2',
            message: { content: [{
                type: 'text',
                text: 'Reading the pages.',
            }, {
                type: 'tool_use',
                id: 'tool-1',
                name: 'mcp__evb_viewer_embedded__evb_read_resource',
                input: {},
            }, {
                type: 'tool_use',
                id: 'tool-2',
                name: 'mcp__evb_viewer_embedded__evb_run_action',
                input: {},
            }] },
        });
        await settleAsyncTicks();
        const tool = (toolId: string, name: string, phase: string) => ({turnId, activity: {
            toolId,
            name: `mcp__evb_viewer_embedded__${name}`,
            phase,
        }});
        expect(events).toEqual([
            {turnId, id: 'progress-1', text: 'Inspecting the document.'},
            {turnId, id: 'progress-2', text: 'Reading the pages.'},
            tool('tool-1', 'evb_read_resource', 'running'),
            tool('tool-2', 'evb_run_action', 'running'),
        ]);
        const runningEvents = [...events];
        fakeQuery.push({type: 'tool_use_summary', summary: 'Working', preceding_tool_use_ids: ['tool-1', 'tool-2']});
        await settleAsyncTicks();
        expect(events).toEqual(runningEvents);
        fakeQuery.push({
            type: 'user',
            message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 'tool-1', content: 'Page text'}]},
        });
        await settleAsyncTicks();
        expect(events.at(-1)).toEqual(tool('tool-1', 'evb_read_resource', 'completed'));
        expect(events).not.toContainEqual(tool('tool-2', 'evb_run_action', 'completed'));
        fakeQuery.push({
            type: 'tool_progress',
            tool_use_id: 'tool-2',
            tool_name: 'mcp__evb_viewer_embedded__evb_run_action',
            elapsed_time_seconds: 1,
        });
        fakeQuery.push({
            type: 'user',
            message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 'tool-2', is_error: true, content: 'Action refused'}]},
        });
        await settleAsyncTicks();
        expect(events.at(-1)).toEqual(tool('tool-2', 'evb_run_action', 'failed'));
        expect(callbacks.onTurnCompleted).not.toHaveBeenCalled();
        // Assistant result blocks use the same native correlation, in content order.
        fakeQuery.push({
            type: 'assistant',
            uuid: 'last-tool',
            message: {content: [
                {type: 'tool_use', id: 'tool-3', name: 'mcp__evb_viewer_embedded__evb_workspace_snapshot', input: {}},
                {type: 'tool_result', tool_use_id: 'tool-3', content: 'Verified'},
            ]},
        });
        await settleAsyncTicks();
        expect(events.slice(-2)).toEqual([
            tool('tool-3', 'evb_workspace_snapshot', 'running'),
            tool('tool-3', 'evb_workspace_snapshot', 'completed'),
        ]);
        const settledEvents = [...events];
        fakeQuery.push({
            type: 'tool_use_summary',
            summary: 'Done',
            preceding_tool_use_ids: ['tool-1', 'tool-2', 'tool-3'],
        });
        // Late progress and duplicate results must not resurrect a settled call.
        fakeQuery.push({type: 'tool_progress', tool_use_id: 'tool-2', tool_name: 'ignored', elapsed_time_seconds: 2});
        fakeQuery.push({type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 'tool-2', content: 'Duplicate'}]}});
        fakeQuery.push({
            type: 'assistant',
            uuid: 'final-answer',
            message: {content: [{type: 'text', text: 'Finished; one action was refused.'}]},
        });
        fakeQuery.push({
            type: 'result',
            subtype,
            is_error: subtype !== 'success',
            usage: {
                input_tokens: 13,
                output_tokens: 8,
                cache_read_input_tokens: 5,
                cache_creation_input_tokens: 2,
            },
            result: 'Claude exploded politely.',
        });
        await settleAsyncTicks();

        expect(callbacks.onTurnStarted).toHaveBeenCalledWith(turnId);
        expect(callbacks.onReasoningDelta).toHaveBeenCalledWith(turnId, 'First inspect the document.');
        expect(events).toEqual([...settledEvents, {turnId, id: 'final-answer', text: 'Finished; one action was refused.'}]);
        expect(callbacks.onUsage).toHaveBeenCalledWith(turnId, {
            inputTokens: 13,
            outputTokens: 8,
            cachedInputTokens: 7,
        });
        if (subtype === 'success') {
            expect(callbacks.onTurnCompleted).toHaveBeenCalledWith(turnId);
            expect(callbacks.onError).not.toHaveBeenCalled();
        } else {
            expect(callbacks.onError).toHaveBeenCalledWith(turnId, 'Claude exploded politely.');
        }
        await session.close();
    });

    it('awaits the consume-stream task when closing a live Claude session', async () => {
        const fakeQuery = new FakeClaudeQuery();
        sdkMocks.query.mockReturnValue(fakeQuery);
        const session = new ClaudeAgentAssistantSession({
            cwd: '/tmp',
            model: 'opus',
            effort: 'low',
            speedMode: 'standard',
            mcpServerName: 'evb_viewer_embedded',
            mcpServerUrl: 'http://127.0.0.1:3000',
            mcpToken: 'token',
            executablePath: '/usr/bin/claude',
            env: {
                CLAUDE_CONFIG_DIR: '/fixture/claude-home',
                INSTANCE_MARKER: 'fixture',
            },
            callbacks: {
                onInitialized: vi.fn(),
                onTurnStarted: vi.fn(),
                onReasoningDelta: vi.fn(),
                onToolActivity: vi.fn(),
                onUsage: vi.fn(),
                onAssistantMessage: vi.fn(),
                onTurnCompleted: vi.fn(),
                onError: vi.fn(),
            },
        });

        await session.sendMessage('Hello', [], 'opus');
        const queryOptions = sdkMocks.query.mock.calls[0]?.[0]?.options;
        expect(queryOptions?.mcpServers?.evb_viewer_embedded).toMatchObject({timeout: 300_000});
        expect(queryOptions?.persistSession).toBe(true);
        const closePromise = session.close();
        expect(fakeQuery.close).toHaveBeenCalledTimes(1);

        await expect(closePromise).resolves.toBeUndefined();
    });

    it('resumes the provider-owned transcript when a replacement query is created', async () => {
        const fakeQuery = new FakeClaudeQuery();
        sdkMocks.query.mockReturnValue(fakeQuery);
        const resumeSessionId = '2c8c2b8a-6d31-4b77-a8c0-0aef9c8e2e5e';
        const session = new ClaudeAgentAssistantSession({
            cwd: '/tmp',
            model: 'opus',
            effort: 'medium',
            speedMode: 'fast',
            modelOptions: [{id: 'opus', label: 'Opus', reasoningEfforts: [{id: 'medium', label: 'Medium'}], serviceTiers: [{id: 'fast', label: 'Fast'}]}],
            resumeSessionId,
            mcpServerName: 'evb_viewer_embedded',
            mcpServerUrl: 'http://127.0.0.1:3000',
            mcpToken: 'token',
            executablePath: '/usr/bin/claude',
            env: {
                CLAUDE_CONFIG_DIR: '/fixture/claude-home',
                INSTANCE_MARKER: 'fixture',
            },
            callbacks: {
                onInitialized: vi.fn(),
                onTurnStarted: vi.fn(),
                onReasoningDelta: vi.fn(),
                onToolActivity: vi.fn(),
                onUsage: vi.fn(),
                onAssistantMessage: vi.fn(),
                onTurnCompleted: vi.fn(),
                onError: vi.fn(),
            },
        });

        await session.sendMessage('Continue', [{
            type: 'image',
            id: 'image-1',
            name: 'context.png',
            mimeType: 'image/png',
            sizeBytes: 1,
            dataUrl: 'data:image/png;base64,AA==',
        }], 'opus');

        const queryOptions = sdkMocks.query.mock.calls[0]?.[0]?.options;
        expect(queryOptions).toMatchObject({
            resume: resumeSessionId,
            env: expect.objectContaining({
                CLAUDE_CONFIG_DIR: '/fixture/claude-home',
                INSTANCE_MARKER: 'fixture',
            }),
            persistSession: true,
            effort: 'medium',
            settings: {fastMode: true},
            systemPrompt: {
                type: 'preset',
                preset: 'claude_code',
                append: expect.any(String),
            },
        });
        const prompt = sdkMocks.query.mock.calls[0]?.[0]?.prompt;
        const promptMessage = await prompt[Symbol.asyncIterator]().next();
        expect(promptMessage.value).toMatchObject({message: {
            role: 'user',
            content: [
                {
                    type: 'text',
                    text: 'Continue',
                },
                {
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: 'image/png',
                        data: 'AA==',
                    },
                },
            ],
        }});
        // A refreshed setup may withdraw capabilities the live query was created with.
        expect(await session.prepareForSettings('opus', 'medium', 'fast', [{id: 'opus', label: 'Opus'}])).toBe(false);
        expect(session.isUsable).toBe(false);

    });

    it('refuses an unavailable provider transcript before starting the SDK query', async () => {
        sdkMocks.readdir.mockRejectedValueOnce(new Error('ENOENT'));
        const session = new ClaudeAgentAssistantSession({
            cwd: '/tmp',
            model: 'opus',
            effort: 'medium',
            speedMode: 'standard',
            resumeSessionId: '2c8c2b8a-6d31-4b77-a8c0-0aef9c8e2e5e',
            mcpServerName: 'evb_viewer_embedded',
            mcpServerUrl: 'http://127.0.0.1:3000',
            mcpToken: 'token',
            executablePath: '/usr/bin/claude',
            env: {
                CLAUDE_CONFIG_DIR: '/fixture/claude-home',
                INSTANCE_MARKER: 'fixture',
            },
            callbacks: {
                onInitialized: vi.fn(),
                onTurnStarted: vi.fn(),
                onReasoningDelta: vi.fn(),
                onToolActivity: vi.fn(),
                onUsage: vi.fn(),
                onAssistantMessage: vi.fn(),
                onTurnCompleted: vi.fn(),
                onError: vi.fn(),
            },
        });

        await expect(session.sendMessage('Do not submit', [], 'opus'))
            .rejects.toThrow('Claude could not restore this chat context. Start a new chat to continue.');
        expect(sdkMocks.readdir).toHaveBeenCalledWith('/fixture/claude-home/projects');
        expect(sdkMocks.query).not.toHaveBeenCalled();
    });

    it('does not create a resumed query after close wins during context verification', async () => {
        let resolveSessionInfo: ((value: unknown) => void) | undefined;
        sdkMocks.readdir.mockReturnValueOnce(new Promise(resolve => {
            resolveSessionInfo = resolve;
        }));
        const session = new ClaudeAgentAssistantSession({
            cwd: '/tmp',
            model: 'opus',
            effort: 'medium',
            speedMode: 'standard',
            resumeSessionId: '2c8c2b8a-6d31-4b77-a8c0-0aef9c8e2e5e',
            mcpServerName: 'evb_viewer_embedded',
            mcpServerUrl: 'http://127.0.0.1:3000',
            mcpToken: 'token',
            executablePath: '/usr/bin/claude',
            env: {
                CLAUDE_CONFIG_DIR: '/fixture/claude-home',
                INSTANCE_MARKER: 'fixture',
            },
            callbacks: {
                onInitialized: vi.fn(),
                onTurnStarted: vi.fn(),
                onReasoningDelta: vi.fn(),
                onToolActivity: vi.fn(),
                onUsage: vi.fn(),
                onAssistantMessage: vi.fn(),
                onTurnCompleted: vi.fn(),
                onError: vi.fn(),
            },
        });

        const sendPromise = session.sendMessage('Do not submit after close', [], 'opus');
        await vi.waitFor(() => {
            expect(sdkMocks.readdir).toHaveBeenCalledOnce();
        });
        await session.close();
        resolveSessionInfo?.(['fixture-project']);

        await expect(sendPromise).rejects.toThrow('Claude assistant session is closed.');
        expect(sdkMocks.query).not.toHaveBeenCalled();
    });

    it('does not create a resumed query after interrupt wins during context verification', async () => {
        let resolveSessionInfo: ((value: unknown) => void) | undefined;
        sdkMocks.readdir.mockReturnValueOnce(new Promise(resolve => {
            resolveSessionInfo = resolve;
        }));
        const session = new ClaudeAgentAssistantSession({
            cwd: '/tmp',
            model: 'opus',
            effort: 'medium',
            speedMode: 'standard',
            resumeSessionId: '2c8c2b8a-6d31-4b77-a8c0-0aef9c8e2e5e',
            mcpServerName: 'evb_viewer_embedded',
            mcpServerUrl: 'http://127.0.0.1:3000',
            mcpToken: 'token',
            executablePath: '/usr/bin/claude',
            env: {
                CLAUDE_CONFIG_DIR: '/fixture/claude-home',
                INSTANCE_MARKER: 'fixture',
            },
            callbacks: {
                onInitialized: vi.fn(),
                onTurnStarted: vi.fn(),
                onReasoningDelta: vi.fn(),
                onToolActivity: vi.fn(),
                onUsage: vi.fn(),
                onAssistantMessage: vi.fn(),
                onTurnCompleted: vi.fn(),
                onError: vi.fn(),
            },
        });

        const sendPromise = session.sendMessage('Do not submit after interrupt', [], 'opus');
        await vi.waitFor(() => {
            expect(sdkMocks.readdir).toHaveBeenCalledOnce();
        });
        await session.interrupt();
        resolveSessionInfo?.(['fixture-project']);

        await expect(sendPromise).rejects.toThrow('Claude assistant session is closed.');
        expect(sdkMocks.query).not.toHaveBeenCalled();
    });

    it('retires a query when interruption fails before accepting another turn', async () => {
        const firstQuery = new FakeClaudeQuery();
        const secondQuery = new FakeClaudeQuery();
        let rejectInterrupt: ((error: Error) => void) | undefined;
        firstQuery.interrupt.mockImplementationOnce(() => new Promise((_, reject) => {
            rejectInterrupt = reject;
        }));
        sdkMocks.query.mockReturnValueOnce(firstQuery).mockReturnValueOnce(secondQuery);
        const callbacks = {
            onInitialized: vi.fn(),
            onTurnStarted: vi.fn(),
            onReasoningDelta: vi.fn(),
            onToolActivity: vi.fn(),
            onUsage: vi.fn(),
            onAssistantMessage: vi.fn(),
            onTurnCompleted: vi.fn(),
            onError: vi.fn(),
        };
        const session = new ClaudeAgentAssistantSession({
            cwd: '/tmp',
            model: 'opus',
            effort: 'low',
            speedMode: 'standard',
            mcpServerName: 'evb_viewer_embedded',
            mcpServerUrl: 'http://127.0.0.1:3000',
            mcpToken: 'token',
            executablePath: '/usr/bin/claude',
            env: {
                CLAUDE_CONFIG_DIR: '/fixture/claude-home',
                INSTANCE_MARKER: 'fixture',
            },
            callbacks,
        });

        const firstTurnId = await session.sendMessage('A', [], 'opus');
        const interruptPromise = session.interrupt();
        firstQuery.push({
            type: 'stream_event',
            event: {
                type: 'content_block_delta',
                delta: {
                    type: 'text_delta',
                    text: 'late A',
                },
            },
        });
        firstQuery.push({
            type: 'assistant',
            uuid: 'retired-answer',
            message: {content: [
                {
                    type: 'text',
                    text: 'late assistant A',
                },
                {
                    type: 'tool_use',
                    id: 'late-tool',
                    name: 'mcp__evb_viewer_embedded__evb_run_action',
                    input: {},
                },
            ]},
        });
        firstQuery.push({
            type: 'tool_progress',
            tool_use_id: 'late-tool',
            tool_name: 'mcp__evb_viewer_embedded__evb_run_action',
            elapsed_time_seconds: 1,
        });
        firstQuery.push({type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 'late-tool', is_error: true}]}});
        firstQuery.push({
            type: 'result',
            subtype: 'success',
            is_error: false,
            usage: {
                input_tokens: 1,
                output_tokens: 1,
            },
        });
        await settleAsyncTicks();
        expect(rejectInterrupt).toBeTypeOf('function');
        rejectInterrupt?.(new Error('interrupt rejected'));
        await interruptPromise;

        const secondTurnId = await session.sendMessage('B', [], 'opus');
        secondQuery.push({
            type: 'assistant',
            uuid: 'current-answer',
            message: {content: [{type: 'text', text: 'B'}]},
        });
        await settleAsyncTicks();

        expect(firstTurnId).not.toBe(secondTurnId);
        expect(callbacks.onAssistantMessage.mock.calls).toEqual([[secondTurnId, 'current-answer', 'B']]);
        expect(callbacks.onToolActivity).not.toHaveBeenCalled();
        expect(callbacks.onTurnCompleted).toHaveBeenCalledWith(firstTurnId);
        expect(sdkMocks.query).toHaveBeenCalledTimes(2);
        expect(firstQuery.close).toHaveBeenCalledTimes(1);
        await session.close();
    });

    it('keeps an unresolved interruption marked as retiring until the query closes', async () => {
        const query = new FakeClaudeQuery();
        let resolveInterrupt: (() => void) | undefined;
        query.interrupt.mockImplementationOnce(() => new Promise<undefined>(resolve => {
            resolveInterrupt = () => resolve(undefined);
        }));
        sdkMocks.query.mockReturnValue(query);
        const callbacks = {
            onInitialized: vi.fn(),
            onTurnStarted: vi.fn(),
            onReasoningDelta: vi.fn(),
            onToolActivity: vi.fn(),
            onUsage: vi.fn(),
            onAssistantMessage: vi.fn(),
            onTurnCompleted: vi.fn(),
            onError: vi.fn(),
        };
        const session = new ClaudeAgentAssistantSession({
            cwd: '/tmp',
            model: 'opus',
            effort: 'low',
            speedMode: 'standard',
            mcpServerName: 'evb_viewer_embedded',
            mcpServerUrl: 'http://127.0.0.1:3000',
            mcpToken: 'token',
            executablePath: '/usr/bin/claude',
            env: {
                CLAUDE_CONFIG_DIR: '/fixture/claude-home',
                INSTANCE_MARKER: 'fixture',
            },
            callbacks,
        });

        await session.sendMessage('A', [], 'opus');
        const interruptPromise = session.interrupt();
        await settleAsyncTicks();

        expect(session.isUsable).toBe(false);
        expect(session.isRetiring).toBe(true);
        expect(query.close).not.toHaveBeenCalled();
        await expect(session.sendMessage('B', [], 'opus')).rejects.toThrow(
            'Claude assistant session is still retiring a previous turn.',
        );

        resolveInterrupt?.();
        await interruptPromise;

        expect(session.isRetiring).toBe(false);
        expect(query.close).toHaveBeenCalledTimes(1);
        expect(callbacks.onTurnCompleted).toHaveBeenCalledTimes(1);
    });
    it('fails a send whose model change is never answered instead of waiting forever', async () => {
        const query = new FakeClaudeQuery();
        query.setModel.mockImplementationOnce(() => new Promise<undefined>(() => undefined));
        sdkMocks.query.mockReturnValue(query);
        const session = new ClaudeAgentAssistantSession({
            cwd: '/tmp',
            model: 'opus',
            effort: 'low',
            speedMode: 'standard',
            mcpServerName: 'evb_viewer_embedded',
            mcpServerUrl: 'http://127.0.0.1:3000',
            mcpToken: 'token',
            executablePath: '/usr/bin/claude',
            env: {},
            callbacks: {
                onInitialized: vi.fn(),
                onTurnStarted: vi.fn(),
                onReasoningDelta: vi.fn(),
                onToolActivity: vi.fn(),
                onUsage: vi.fn(),
                onAssistantMessage: vi.fn(),
                onTurnCompleted: vi.fn(),
                onError: vi.fn(),
            },
        });
        await session.sendMessage('A', [], 'opus');
        vi.useFakeTimers();
        try {
            const send = session.sendMessage('B', [], 'fable');
            const outcome = expect(send).rejects.toThrow('did not accept the model change');
            await vi.advanceTimersByTimeAsync(10_000);
            await outcome;
        } finally {
            vi.useRealTimers();
        }
    });

    it('closes the query when its interrupt request never answers', async () => {
        const query = new FakeClaudeQuery();
        query.interrupt.mockImplementationOnce(() => new Promise<undefined>(() => undefined));
        sdkMocks.query.mockReturnValue(query);
        const onTurnCompleted = vi.fn();
        const session = new ClaudeAgentAssistantSession({
            cwd: '/tmp',
            model: 'opus',
            effort: 'low',
            speedMode: 'standard',
            mcpServerName: 'evb_viewer_embedded',
            mcpServerUrl: 'http://127.0.0.1:3000',
            mcpToken: 'token',
            executablePath: '/usr/bin/claude',
            env: {},
            callbacks: {
                onInitialized: vi.fn(),
                onTurnStarted: vi.fn(),
                onReasoningDelta: vi.fn(),
                onToolActivity: vi.fn(),
                onUsage: vi.fn(),
                onAssistantMessage: vi.fn(),
                onTurnCompleted,
                onError: vi.fn(),
            },
        });
        await session.sendMessage('A', [], 'opus');
        vi.useFakeTimers();
        try {
            const interruptPromise = session.interrupt();
            await vi.advanceTimersByTimeAsync(5_000);
            await interruptPromise;
        } finally {
            vi.useRealTimers();
        }
        expect(query.close).toHaveBeenCalledTimes(1);
        expect(session.isRetiring).toBe(false);
        expect(onTurnCompleted).toHaveBeenCalledTimes(1);
    });

    it('discovers instance models and account with its environment and without submitting a prompt', async () => {
        const metadata = new FakeClaudeQuery();
        metadata.supportedModels.mockResolvedValue([{
            value: 'opus',
            displayName: 'Opus',
            resolvedModel: 'claude-opus-5-5',
        }]);
        metadata.accountInfo.mockResolvedValue({email: 'reader@example.test'});
        sdkMocks.query.mockReturnValue(metadata);
        const env = {
            CLAUDE_CONFIG_DIR: '/fixture/claude-home',
            ANTHROPIC_BASE_URL: 'https://proxy.example.test',
        };
        expect(await discoverClaudeAssistantModels('/fixture/cwd', '/fixture/claude', env)).toMatchObject({
            models: [{
                id: 'opus',
                label: 'Opus 5.5',
            }],
            account: {email: 'reader@example.test'},
        });
        const request = sdkMocks.query.mock.calls[0]![0];
        expect(request.options).toMatchObject({
            env,
            cwd: '/fixture/cwd',
            pathToClaudeCodeExecutable: '/fixture/claude',
            tools: [],
            mcpServers: {},
            strictMcpConfig: true,
            settingSources: [],
            persistSession: false,
        });
        expect(await request.prompt[Symbol.asyncIterator]().next()).toMatchObject({done: true});
        expect(metadata.close).toHaveBeenCalled();
    });

    it('bounds metadata discovery to 15 seconds and closes a stalled SDK query', async () => {
        vi.useFakeTimers();
        const metadata = new FakeClaudeQuery();
        metadata.supportedModels.mockReturnValue(new Promise(() => undefined));
        sdkMocks.query.mockReturnValue(metadata);
        const result = expect(discoverClaudeAssistantModels('/fixture/cwd', '/fixture/claude', {})).rejects.toThrow('Claude did not finish its status check within 15 seconds.');
        await vi.advanceTimersByTimeAsync(15_000);
        await result;
        expect(metadata.close).toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['success', 'error_during_execution'])('publishes completed snapshot items and preserves individual outcomes through %s', async (subtype) => {
        vi.resetModules();
        const root = await mkdtemp(join(tmpdir(), 'claude-item-events-'));
        const events: IAssistantEvent[] = [];
        const app = {getPath: () => root, getVersion: () => 'test', getName: () => 'EVB Viewer', isPackaged: false};
        const config = {id: 'claude', driver: 'claude', displayName: 'Claude', enabled: true};
        vi.doMock('electron', () => ({default: {app}, app}));
        vi.doMock('@electron/settings', () => ({loadSettings: async () => ({assistantPanelEnabled: true})}));
        vi.doMock('@electron/features/agent/assistantInstances', () => ({
            getAssistantInstanceConfigs: async () => [config],
            getAssistantInstanceFingerprints: async () => new Map([['claude', 'fixture']]),
            assistantInstanceLabel: () => 'Claude',
            onAssistantInstancesChanged: () => undefined,
            refreshAssistantLocalSetups: async () => undefined,
            resolveAssistantLaunchContext: async () => ({binaryPath: '/fixture/claude', env: {}, homePath: null, customEndpoint: false}),
        }));
        vi.doMock('@electron/features/agent/assistantLocalSetups', () => ({identifyAssistantExecutable: async () => 'fixture'}));
        vi.doMock('@electron/features/agent/mcpServer', () => ({
            startEmbeddedMcpServer: async () => ({descriptor: {url: 'http://127.0.0.1:3000'}, token: 'fixture'}),
            shutdownEmbeddedMcpServer: async () => undefined,
            abortActiveEmbeddedMcpRequests: () => undefined,
        }));
        vi.doMock('@electron/features/agent/assistantChatPersistence', () => ({AssistantChatPersistence: class {
            getMaxSessionBytes() { return 1_000_000; }
            recoverSessions() { return Promise.resolve([]); }
            recoverSession() { return Promise.resolve(null); }
            recordSessionSnapshot() { /* Persistence is outside this event-boundary test. */ }
            flush() { return Promise.resolve(); }
        }}));
        vi.doMock('@electron/window/registry', () => ({getAllRegisteredAppWindows: () => [{}]}));
        vi.doMock('@electron/utils/sendPlatformEvent', () => ({
            sendPlatformEvent: (_window: unknown, _channel: unknown, event: IAssistantEvent) => events.push(structuredClone(event)),
        }));
        const metadata = new FakeClaudeQuery();
        metadata.supportedModels.mockResolvedValue([{value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-5-5'}]);
        const query = new FakeClaudeQuery();
        sdkMocks.query.mockReturnValueOnce(metadata).mockReturnValue(query);
        const service = await import('@electron/features/agent/assistantService');
        try {
            const sent = await service.sendAgentAssistantMessage({
                text: 'Inspect the document',
                scope: {kind: 'document', key: 'fixture', title: 'fixture.pdf', tabId: requireTabId('fixture')},
                selection: {instanceId: 'claude', model: 'opus', effort: 'low', speedMode: 'standard'},
            }, {windowId: 1});
            expect(sent.ok).toBe(true);
            const text = (uuid: string, value: string) => ({type: 'assistant', uuid, message: {content: [{type: 'text', text: value}]}});
            query.push(text('progress-one', 'Inspecting.'));
            query.push({type: 'assistant', uuid: 'progress-two', message: {content: [
                {type: 'text', text: 'Reading.'},
                ...['read', 'write', 'unfinished'].map(id => ({type: 'tool_use', id, name: `mcp__evb_viewer_embedded__${id}`, input: {}})),
            ]}});
            query.push({type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 'read', content: 'Text'}]}});
            await settleAsyncTicks();
            const items = () => events.flatMap(event => event.type === 'item' ? [event.item] : []);
            expect(items().findLast(item => item.id === 'read')).toMatchObject({status: 'completed', completedAt: expect.any(String)});
            expect(items().findLast(item => item.id === 'write')).toMatchObject({status: 'streaming'});
            query.push({type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 'write', is_error: true, content: 'Refused'}]}});
            query.push({type: 'tool_use_summary', preceding_tool_use_ids: ['read', 'write', 'unfinished'], summary: 'Working'});
            query.push(text('answer', 'Finished.'));
            await settleAsyncTicks();
            expect(items().findLast(item => item.id === 'write')).toMatchObject({status: 'failed', completedAt: expect.any(String)});
            expect(items().findLast(item => item.id === 'unfinished')).toMatchObject({status: 'streaming'});
            const messages = items().filter(item => item.kind === 'assistant');
            expect(messages.map(item => [item.id, item.text, item.status])).toEqual([
                ['progress-one', 'Inspecting.', 'completed'],
                ['progress-two', 'Reading.', 'completed'],
                ['answer', 'Finished.', 'completed'],
            ]);
            expect(messages.every(item => item.completedAt)).toBe(true);
            expect(items().at(-1)?.id).toBe('answer');
            query.push({type: 'result', subtype, is_error: subtype !== 'success', errors: subtype === 'success' ? [] : ['Turn failed'], usage: {
                input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
            }});
            await settleAsyncTicks();
            expect(items().findLast(item => item.id === 'read')?.status).toBe('completed');
            expect(items().findLast(item => item.id === 'write')?.status).toBe('failed');
            expect(items().findLast(item => item.id === 'unfinished')).toMatchObject({
                status: subtype === 'success' ? 'completed' : 'failed', completedAt: expect.any(String),
            });
            expect(items().filter(item => item.kind === 'assistant')).toEqual(messages);
        } finally {
            await service.shutdownAgentAssistant();
            await rm(root, {recursive: true, force: true});
            for (const module of [
                'electron', '@electron/settings', '@electron/features/agent/assistantInstances',
                '@electron/features/agent/assistantLocalSetups', '@electron/features/agent/mcpServer',
                '@electron/features/agent/assistantChatPersistence', '@electron/window/registry', '@electron/utils/sendPlatformEvent',
            ]) vi.doUnmock(module);
            vi.resetModules();
        }
    });

});
