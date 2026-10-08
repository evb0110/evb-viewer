#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// Replay captured provider metadata so the real-app picker needs no installed
// Codex CLI, credentials or network. Turns return a deterministic local reply.
if (process.argv.includes('--version')) {
    process.stdout.write('codex-cli 0.157.1\n');
} else if (process.argv.includes('login')) {
    process.stdout.write('Logged in using ChatGPT\n');
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
