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
    const input = createInterface({ input: process.stdin });
    let threadNumber = 0;
    let turnNumber = 0;
    const notify = (method, params) => process.stdout.write(JSON.stringify({
        method,
        params,
    }) + '\n');
    const finishTurn = (threadId, turnId, text) => {
        notify('item/agentMessage/delta', {
            threadId,
            turnId,
            itemId: turnId,
            delta: text,
        });
        notify('item/completed', {
            threadId,
            turnId,
            item: {
                type: 'agentMessage',
                id: turnId,
                text,
            },
        });
        notify('turn/completed', {
            threadId,
            turnId,
        });
    };
    input.on('line', line => {
        const request = JSON.parse(line);
        if (request.id !== undefined) {
            const threadId = request.params?.threadId ?? `thread-${++threadNumber}`;
            const turnId = `turn-${process.pid}-${++turnNumber}`;
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
                notify('turn/started', {
                    threadId,
                    turn: {id: turnId},
                });
                const prompt = request.params?.input?.find(item => item.type === 'text')?.text ?? '';
                if (prompt.includes('AP-B01 fenced table')) {
                    finishTurn(threadId, turnId, [
                        'Before',
                        '```js',
                        'const value = 1;',
                        '| a | b |',
                        '| --- | --- |',
                        '| c | d |',
                        '```',
                        'After',
                    ].join('\n'));
                } else {
                    finishTurn(threadId, turnId, 'Image received.');
                }
            }
        }
    });
}
