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
    input.on('line', line => {
        const request = JSON.parse(line);
        if (request.id !== undefined) {
            const threadId = request.params?.threadId ?? `thread-${++threadNumber}`;
            const turnId = `turn-${++turnNumber}`;
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
                for (const [
                    method,
                    params,
                ] of [
                        [
                            'turn/started',
                            {
                                threadId,
                                turn: {id: turnId},
                            },
                        ],
                        [
                            'item/agentMessage/delta',
                            {
                                threadId,
                                turnId,
                                itemId: turnId,
                                delta: 'Image received.',
                            },
                        ],
                        [
                            'item/completed',
                            {
                                threadId,
                                turnId,
                                item: {
                                    type: 'agentMessage',
                                    id: turnId,
                                    text: 'Image received.',
                                },
                            },
                        ],
                        [
                            'turn/completed',
                            {
                                threadId,
                                turnId,
                            },
                        ],
                    ]) {
                    process.stdout.write(`${JSON.stringify({
                        method,
                        params,
                    })}\n`);
                }
            }
        }
    });
}
