#!/usr/bin/env node
import {
    readFileSync, writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';

// Replay captured provider metadata so the real-app picker needs no installed
// Codex CLI, credentials or network. Turns return a deterministic local reply.
// EVB_FAKE_CODEX_HANG=1 reproduces a Codex that never answers initialize, as
// a real one does while it waits on a blocked sign-in refresh.
if (process.argv.includes('--version')) {
    process.stdout.write('codex-cli 0.157.1\n');
} else if (process.argv.includes('login')) {
    process.stdout.write('Logged in using ChatGPT\n');
} else if (process.env.EVB_FAKE_CODEX_HANG === '1') {
    process.stderr.write('refreshing ChatGPT token\n');
    setInterval(() => undefined, 60_000);
} else {
    const catalog = JSON.parse(readFileSync(new URL('./codex-app-server-model-list-0.157.1.json', import.meta.url), 'utf8'));
    const notify = (method, params) => process.stdout.write(JSON.stringify({
        method,
        params,
    }) + '\n');
    const finishTurn = (emit, turnId, text) => {
        emit('item/agentMessage/delta', {
            itemId: turnId,
            delta: text,
        });
        emit('item/completed', {item: {
            type: 'agentMessage',
            id: turnId,
            text,
        }});
        emit('turn/completed');
    };
    // Calls the embedded EVB MCP server the way Codex does: the URL from the
    // server override EVB passes on the command line, the bearer token from
    // the environment.
    const callEvbTool = async (name, args, callId) => {
        const override = process.argv.find(arg => arg.startsWith('mcp_servers.evb_viewer_embedded_v4='));
        const url = /url="([^"]+)"/u.exec(override ?? '')?.[1];
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${process.env.EVB_MCP_TOKEN}`,
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: callId,
                method: 'tools/call',
                params: {
                    name,
                    arguments: args,
                },
            }),
        });
        const {
            result, error,
        } = await response.json();
        if (error) return `error ${JSON.stringify(error)}`;
        if (!response.ok || !result) throw new Error(`MCP request failed: HTTP ${response.status}`);
        return result.isError ? `error ${result.content?.[0]?.text ?? ''}` : 'ok';
    };
    createInterface({input: process.stdin}).on('line', line => {
        const request = JSON.parse(line);
        if (request.id !== undefined) {
            const threadId = request.params?.threadId ?? `thread-${process.pid}-${request.id}`;
            const turnId = `turn-${process.pid}-${request.id}`;
            const result = request.method === 'model/list' ? catalog
                : request.method === 'account/read' ? {account: {
                    type: 'chatgpt',
                    email: 'local-fixture@example.test',
                }}
                    : request.method === 'getAuthStatus' ? {
                        requiresOpenaiAuth: false,
                        authMethod: 'chatgpt',
                    }
                        : request.method === 'mcpServerStatus/list' ? {data: [{
                            name: 'evb_viewer_embedded_v4',
                            tools: {},
                        }]}
                            : request.method === 'thread/start' || request.method === 'thread/resume' ? {thread: {id: threadId}}
                                : request.method === 'turn/start' ? {turn: {id: turnId}} : {};
            process.stdout.write(`${JSON.stringify({
                id: request.id,
                result,
            })}\n`);
            if (request.method === 'turn/start') {
                const emit = (method, params = {}) => notify(method, {
                    threadId,
                    turnId,
                    ...params,
                });
                notify('turn/started', {
                    threadId,
                    turn: {id: turnId},
                });
                const prompt = request.params?.input?.find(item => item.type === 'text')?.text ?? '';
                if (prompt.includes('AP-B01 fenced table')) {
                    finishTurn(emit, turnId, [
                        'Before',
                        '```js',
                        'const value = 1;',
                        '| a | b |',
                        '| --- | --- |',
                        '| c | d |',
                        '```',
                        'After',
                    ].join('\n'));
                } else if (prompt.includes('A10-4 own save')) {
                    // The turn saves its own document, then must still read it.
                    void (async () => {
                        const save = await callEvbTool('evb_run_action', {
                            id: 'file.save',
                            input: {},
                        }, `${turnId}-save`);
                        const read = await callEvbTool('evb_workspace_snapshot', {}, `${turnId}-read`);
                        finishTurn(emit, turnId, `save:${save} read:${read}`);
                    })().catch(error => finishTurn(emit, turnId, `fixture:${error.message}`));
                } else if (prompt.includes('1544 own rotation')) {
                    void (async () => {
                        const rotate = await callEvbTool('evb_run_action', {
                            id: 'page_ops.rotate_cw_selected',
                            input: {},
                        }, `${turnId}-rotate`);
                        const read = await callEvbTool('evb_workspace_snapshot', {}, `${turnId}-read`);
                        const save = await callEvbTool('evb_run_action', {
                            id: 'file.save',
                            input: {},
                        }, `${turnId}-save`);
                        writeFileSync(new URL('../../../.devkit/test/assistant-own-rotation-mcp.json', import.meta.url), JSON.stringify({
                            turnId,
                            rotate,
                            read,
                            save,
                        }));
                        finishTurn(emit, turnId, `rotate:${rotate} read:${read} save:${save}`);
                    })().catch(error => finishTurn(emit, turnId, `fixture:${error.message}`));
                } else if (prompt.includes('AP-B02 tool activity')) {
                    const transcript = JSON.parse(readFileSync(new URL('./assistant-tool-transcript.json', import.meta.url), 'utf8'));
                    for (const event of transcript) {
                        setTimeout(() => emit(event.method, event.params), event.afterMs);
                    }
                    setTimeout(() => finishTurn(emit, turnId, 'Local tool fixture finished.'), 9000);
                } else {
                    finishTurn(emit, turnId, 'Image received.');
                }
            }
        }
    });
}
