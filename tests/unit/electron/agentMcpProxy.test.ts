import {
    describe,
    expect,
    it,
} from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

interface IProxyClient {
    send(message: Record<string, unknown>): void;
    sendRaw(payload: string): void;
    waitForResponse(id: string | number): Promise<IProxyResponse>;
    stop(): Promise<void>;
}

interface IProxyResponse {
    id?: string | number | null;
    result?: unknown;
    error?: unknown;
}

interface IReceivedMessage {
    authorization: string | undefined;
    message: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
    expect(value).toBeTypeOf('object');
    expect(value).not.toBeNull();
    return value as Record<string, unknown>;
}

function createProxyClient(url: string, token = 'proxy-test-token'): IProxyClient {
    const child = spawn(process.execPath, [
        'scripts/evb-mcp-proxy.mjs',
        '--url',
        url,
    ], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            EVB_MCP_TOKEN: token,
        },
        stdio: [
            'pipe',
            'pipe',
            'pipe',
        ],
    });

    let buffer = '';
    const responses: IProxyResponse[] = [];
    const listeners = new Set<() => void>();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        while (true) {
            const lineEnd = buffer.indexOf('\n');
            if (lineEnd < 0) {
                break;
            }
            const line = buffer.slice(0, lineEnd).trim();
            buffer = buffer.slice(lineEnd + 1);
            if (line) {
                responses.push(JSON.parse(line) as IProxyResponse);
                for (const listener of listeners) {
                    listener();
                }
            }
        }
    });
    child.stderr.resume();

    return {
        send(message: Record<string, unknown>) {
            child.stdin.write(`${JSON.stringify(message)}\n`);
        },
        sendRaw(payload: string) {
            child.stdin.write(payload);
        },
        async waitForResponse(id: string | number) {
            const existing = responses.find(response => response.id === id);
            if (existing) {
                return existing;
            }

            return new Promise<IProxyResponse>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    listeners.delete(check);
                    reject(new Error(`Timed out waiting for MCP response ${id}.`));
                }, 2000);
                const check = () => {
                    const response = responses.find(candidate => candidate.id === id);
                    if (!response) {
                        return;
                    }
                    clearTimeout(timeout);
                    listeners.delete(check);
                    resolve(response);
                };
                listeners.add(check);
            });
        },
        async stop() {
            const exited = once(child, 'exit');
            child.stdin.end();
            const stopped = await Promise.race([
                exited.then(() => true),
                new Promise<false>(resolve => setTimeout(() => resolve(false), 1000)),
            ]);
            if (!stopped) {
                child.kill();
                await once(child, 'exit');
            }
        },
    };
}

async function createMcpEndpoint() {
    const requests: IReceivedMessage[] = [];
    const tools = Array.from({length: 15}, (_, index) => ({
        name: `server-owned-tool-${index + 1}`,
        inputSchema: {type: 'object'},
    }));
    const server = createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => { body += chunk; });
        request.on('end', () => {
            const message = JSON.parse(body) as Record<string, unknown>;
            requests.push({
                authorization: request.headers.authorization?.toString(),
                message,
            });
            if (message.method === 'notifications/initialized') {
                response.writeHead(202, {'Connection': 'close'});
                response.end();
                return;
            }

            let result: unknown = {};
            switch (message.method) {
                case 'initialize':
                    result = {
                        protocolVersion: '2025-11-25',
                        capabilities: {},
                        serverInfo: {name: 'server-owned-name'},
                    };
                    break;
                case 'tools/list':
                    result = {tools};
                    break;
                case 'resources/templates/list':
                    result = {resourceTemplates: [{name: 'server-owned-resource'}]};
                    break;
                case 'prompts/list':
                    result = {prompts: [{name: 'server-owned-prompt'}]};
                    break;
                case 'tools/call':
                    result = {content: [{
                        type: 'text',
                        text: 'server-owned tool result',
                    }]};
                    break;
            }
            response.writeHead(200, {
                'Connection': 'close',
                'Content-Type': 'application/json',
            });
            response.end(JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                result,
            }));
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('The MCP test endpoint did not bind a TCP port.');
    }

    return {
        requests,
        tools,
        url: `http://127.0.0.1:${address.port}`,
        async close() {
            await new Promise<void>((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
            });
        },
    };
}

describe('evb-mcp-proxy', () => {
    it('relays MCP requests and server responses over newline-delimited stdio', async () => {
        const endpoint = await createMcpEndpoint();
        const client = createProxyClient(endpoint.url);

        try {
            client.send({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {protocolVersion: '2025-11-25'},
            });
            const initialized = await client.waitForResponse(1);
            expect(asRecord(asRecord(initialized.result).serverInfo).name).toBe('server-owned-name');

            client.send({
                jsonrpc: '2.0',
                method: 'notifications/initialized',
            });
            client.send({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/list',
            });
            client.send({
                jsonrpc: '2.0',
                id: 3,
                method: 'resources/templates/list',
            });
            client.send({
                jsonrpc: '2.0',
                id: 4,
                method: 'prompts/list',
            });
            client.send({
                jsonrpc: '2.0',
                id: 5,
                method: 'tools/call',
                params: {
                    name: 'server-owned-tool-15',
                    arguments: {},
                },
            });

            const listed = asRecord((await client.waitForResponse(2)).result);
            const listedTools = listed.tools as Array<{name: string}>;
            expect(listedTools).toEqual(endpoint.tools);
            expect(asRecord((await client.waitForResponse(3)).result).resourceTemplates)
                .toEqual([{name: 'server-owned-resource'}]);
            expect(asRecord((await client.waitForResponse(4)).result).prompts)
                .toEqual([{name: 'server-owned-prompt'}]);
            expect(asRecord((await client.waitForResponse(5)).result).content)
                .toEqual([{
                    type: 'text',
                    text: 'server-owned tool result',
                }]);

            expect(endpoint.requests.map(({message}) => message.method)).toEqual(expect.arrayContaining([
                'initialize',
                'notifications/initialized',
                'tools/list',
                'resources/templates/list',
                'prompts/list',
                'tools/call',
            ]));
            expect(endpoint.requests.every(({authorization}) => authorization === 'Bearer proxy-test-token')).toBe(true);
        } finally {
            await client.stop();
            await endpoint.close();
        }
    });

    it('returns a generic JSON-RPC error when the Electron endpoint is down', async () => {
        const client = createProxyClient('http://127.0.0.1:9');

        try {
            client.send({
                jsonrpc: '2.0',
                id: 'offline',
                method: 'tools/call',
                params: {
                    name: 'unknown-to-proxy',
                    arguments: {},
                },
            });

            const response = await client.waitForResponse('offline');
            expect(response).toMatchObject({
                id: 'offline',
                error: {code: -32603},
            });
            expect(asRecord(response.error).message).toContain('endpoint is unavailable');
            expect(response).not.toHaveProperty('result');
        } finally {
            await client.stop();
        }
    });

    it('recovers after malformed Content-Length input and relays the next frame', async () => {
        const endpoint = await createMcpEndpoint();
        const client = createProxyClient(endpoint.url);

        try {
            client.sendRaw('Content-Length: nope\r\n\r\n');
            const message = JSON.stringify({
                jsonrpc: '2.0',
                id: 'after-bad-frame',
                method: 'ping',
            });
            client.sendRaw(`Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);

            await expect(client.waitForResponse('after-bad-frame')).resolves.toMatchObject({
                id: 'after-bad-frame',
                result: {},
            });
            expect(endpoint.requests.map(({message: request}) => request.method)).toContain('ping');
        } finally {
            await client.stop();
            await endpoint.close();
        }
    });
});
