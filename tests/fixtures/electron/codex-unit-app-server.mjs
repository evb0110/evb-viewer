#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {
    appendFileSync, writeFileSync,
} from 'node:fs';

// Real subprocess protocol fixture. All credentials and accounts are synthetic.
if (process.env.CODEX_UNIT_PIDS) appendFileSync(process.env.CODEX_UNIT_PIDS, `${process.pid}\n`);
if (process.env.CODEX_UNIT_ARGV) writeFileSync(process.env.CODEX_UNIT_ARGV, JSON.stringify(process.argv.slice(2)));
const mode = process.env.CODEX_UNIT_MODE ?? 'responsive';
if (mode === 'hang') process.stderr.write('\u001b[31mfixture login refresh is blocked\u001b[0m\n');
const input = createInterface({input: process.stdin});
input.on('line', line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    if (mode === 'hang') return;
    const result = {
        initialize: {userAgent: 'codex-unit'},
        'account/read': {account: {
            type: 'chatgpt',
            email: 'reader@example.test',
            planType: 'plus',
        }},
        'config/read': {config: {
            mcp_servers: {outside: {}},
            plugins: {helper: {}},
        }},
        'model/list': {data: [{
            id: 'model-1',
            model: 'gpt-5.4',
            displayName: 'GPT 5.4',
            isDefault: true,
            supportedReasoningEfforts: [{
                reasoningEffort: 'high',
                description: 'High',
            }],
            defaultReasoningEffort: 'high',
        }]},
        'mcpServerStatus/list': {data: mode === 'leak' ? [{
            name: 'leaking-server',
            tools: {exec: {}},
        }] : []},
        'thread/start': {thread: {id: 'fresh-thread'}},
        'thread/resume': {thread: {id: request.params?.threadId}},
        'turn/start': {turn: {id: 'turn-1'}},
    }[request.method] ?? {};
    const response = mode === 'resume-error' && request.method === 'thread/resume'
        ? {error: {
            code: -32000,
            message: 'thread belongs to another home',
        }}
        : {result};
    process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        ...response,
    })}\n`);
});
