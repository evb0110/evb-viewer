#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// Replay captured provider metadata so the real-app picker needs no installed
// Codex CLI, credentials, network or model turn.
if (process.argv.includes('--version')) {
    process.stdout.write('codex-cli 0.157.1\n');
} else if (process.argv.includes('login')) {
    process.stdout.write('Logged in using ChatGPT\n');
} else {
    const catalog = JSON.parse(readFileSync(new URL('./codex-app-server-model-list-0.157.1.json', import.meta.url), 'utf8'));
    const input = createInterface({ input: process.stdin });
    input.on('line', line => {
        const request = JSON.parse(line);
        if (request.id !== undefined) {
            process.stdout.write(`${JSON.stringify({
                id: request.id,
                result: request.method === 'model/list' ? catalog : {},
            })}\n`);
        }
    });
}
