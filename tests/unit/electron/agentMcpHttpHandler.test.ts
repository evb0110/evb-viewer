import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createServer,
    request as createHttpRequest,
} from 'node:http';
import type {
    IncomingMessage,
    Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpHandler } from '@electron/features/agent/mcp/createHttpHandler';
import { abortAssistantToolRequestsForBinding } from '@electron/features/agent/mcpServer';
import type { IAssistantSessionScopeBinding } from '@electron/features/agent/assistantTurnLifecycle';
import type { IProcessMcpRequestOptions } from '@electron/features/agent/mcp/mcpServerCore';
import {requireTabId} from '@contracts/windowTabs';

const servers: Server[] = [];

function asRecord(value: unknown) {
    expect(value).toBeTypeOf('object');
    expect(value).not.toBeNull();
    return value as Record<string, unknown>;
}

function getErrorRecord(value: unknown) {
    const record = asRecord(value);
    return asRecord(record.error);
}

function createOptions(): IProcessMcpRequestOptions {
    return {
        identity: {
            name: 'evb_viewer_dev',
            title: 'EVB Viewer Dev',
            appName: 'EVB Viewer Dev',
            version: 'test',
            isPackaged: false,
            userDataPath: null,
            host: '127.0.0.1',
            port: 0,
        },
        getWorkspaceSnapshot: vi.fn(),
        runCommand: vi.fn(),
        inspectDocumentText: vi.fn(),
        searchDocument: vi.fn(),
        readDocumentPages: vi.fn(),
    };
}

async function listen(
    handler: ReturnType<typeof createHttpHandler>,
    observeRequest?: (request: IncomingMessage) => void,
) {
    const server = createServer();
    if (observeRequest) {
        server.on('request', observeRequest);
    }
    server.on('request', (request, response) => {
        void handler(request, response);
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
}

describe('createHttpHandler', () => {
    afterEach(async () => {
        await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
            server.close(() => resolve());
        })));
    });

    it('requires an explicit bearer token by default', async () => {
        const url = await listen(createHttpHandler(createOptions()));

        const response = await fetch(url, {
            method: 'POST',
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
            }),
        });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Unauthorized.' });
    });

    it('accepts authorized JSON-RPC requests', async () => {
        const url = await listen(createHttpHandler(createOptions(), { bearerToken: 'secret' }));

        const response = await fetch(url, {
            method: 'POST',
            headers: { Authorization: 'Bearer secret' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
            }),
        });
        const body = await response.json() as { result?: unknown };

        expect(response.status).toBe(200);
        expect(JSON.stringify(body.result)).toContain('evb_workspace_snapshot');
    });

    it('does not abort completed requests when Node emits data, end, then close', async () => {
        const events: string[] = [];
        const options = createOptions();
        options.getWorkspaceSnapshot = vi.fn().mockImplementation(async () => {
            await new Promise<void>(resolve => setImmediate(resolve));
            return {};
        });
        const url = await listen(
            createHttpHandler(options, { bearerToken: 'secret' }),
            (request) => {
                request.on('data', () => events.push('data'));
                request.on('end', () => events.push('end'));
                request.on('close', () => events.push('close'));
            },
        );

        const response = await fetch(url, {
            method: 'POST',
            headers: { Authorization: 'Bearer secret' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'evb_workspace_snapshot',
                    arguments: {},
                },
            }),
        });

        expect(response.status).toBe(200);
        expect(events).toEqual([
            'data',
            'end',
            'close',
        ]);
        expect(options.getWorkspaceSnapshot).toHaveBeenCalledOnce();
    });

    it('aborts an incomplete request when Node emits data, aborted, then close', async () => {
        const events: string[] = [];
        let resolveClosed: (() => void) | undefined;
        const requestClosed = new Promise<void>((resolve) => {
            resolveClosed = resolve;
        });
        const options = createOptions();
        const url = await listen(
            createHttpHandler(options, { bearerToken: 'secret' }),
            (request) => {
                request.on('data', () => events.push('data'));
                request.on('aborted', () => events.push('aborted'));
                request.on('close', () => {
                    events.push('close');
                    resolveClosed?.();
                });
            },
        );
        const body = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
                name: 'evb_workspace_snapshot',
                arguments: {},
            },
        });

        await new Promise<void>((resolve) => {
            const request = createHttpRequest(url, {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer secret',
                    'Content-Length': Buffer.byteLength(body) + 32,
                    'Content-Type': 'application/json',
                },
            });
            request.on('error', () => resolve());
            request.on('socket', (socket) => {
                socket.once('connect', () => {
                    request.write(body.slice(0, 24));
                    setImmediate(() => request.destroy());
                });
            });
            request.on('close', resolve);
        });
        await requestClosed;

        expect(events).toEqual([
            'data',
            'aborted',
            'close',
        ]);
        expect(options.getWorkspaceSnapshot).not.toHaveBeenCalled();
    });

    it('propagates client disconnect cancellation into document-text work', async () => {
        const started = Promise.withResolvers<undefined>();
        let receivedSignal: AbortSignal | undefined;
        const options = createOptions();
        options.getWorkspaceSnapshot = vi.fn().mockResolvedValue({
            activeTabId: 'tab-1',
            tabs: [{
                tabId: 'tab-1',
                kind: 'pdf',
                fileName: 'test.pdf',
                originalPath: '/tmp/test.pdf',
            }],
        });
        options.inspectDocumentText = vi.fn().mockImplementation(async (
            _input,
            _windowId,
            signal: AbortSignal | undefined,
        ) => {
            receivedSignal = signal;
            started.resolve(undefined);
            await new Promise<void>((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(signal.reason), {once: true});
            });
            return {};
        });
        const url = await listen(createHttpHandler(options, {bearerToken: 'secret'}));
        const controller = new AbortController();
        const response = fetch(url, {
            method: 'POST',
            headers: {Authorization: 'Bearer secret'},
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'evb_inspect_document_text',
                    arguments: {tabId: 'tab-1'},
                },
            }),
            signal: controller.signal,
        });

        await started.promise;
        controller.abort();

        await expect(response).rejects.toThrow();
        await vi.waitFor(() => expect(receivedSignal?.aborted).toBe(true));
    });

    it('cancels a captured embedded request before its document operation starts', async () => {
        const started = Promise.withResolvers<undefined>();
        const binding: IAssistantSessionScopeBinding = {
            sessionKey: 'codex:document-a',
            scopeKey: 'document-a',
            provider: 'codex',
            turnGeneration: 4,
            windowId: 7,
            tabId: requireTabId('tab-a'),
            documentRef: null,
            documentIdentity: null,
        };
        const activeRequestControllers = new Map<AbortController, IAssistantSessionScopeBinding | null>();
        let receivedSignal: AbortSignal | undefined;
        let operationStarted = false;
        const options = createOptions();
        options.getWorkspaceSnapshot = vi.fn().mockResolvedValue({
            activeTabId: 'tab-1',
            tabs: [{
                tabId: 'tab-1',
                kind: 'pdf',
                fileName: 'test.pdf',
                originalPath: '/tmp/test.pdf',
                currentPage: 1,
                totalPages: 1,
            }],
        });
        options.inspectDocumentText = vi.fn().mockImplementation(async (
            _input,
            _windowId,
            signal: AbortSignal | undefined,
        ) => {
            receivedSignal = signal;
            started.resolve(undefined);
            await new Promise<void>((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(signal.reason), {once: true});
            });
            operationStarted = true;
            return {};
        });
        const url = await listen(createHttpHandler(options, {
            bearerToken: 'secret',
            activeRequestControllers,
            getRequestContext: () => binding,
        }));
        const request = fetch(url, {
            method: 'POST',
            headers: {Authorization: 'Bearer secret'},
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'evb_inspect_document_text',
                    arguments: {tabId: 'tab-1'},
                },
            }),
        });

        await started.promise;
        expect(abortAssistantToolRequestsForBinding(activeRequestControllers, binding, 'Reset canceled the request')).toBe(1);
        const response = await request;
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({result: {isError: true}});
        expect(receivedSignal?.aborted).toBe(true);
        expect(operationStarted).toBe(false);
        expect(activeRequestControllers).toHaveLength(0);
    });

    it('rejects browser-origin requests unless explicitly allowed', async () => {
        const url = await listen(createHttpHandler(createOptions(), { bearerToken: 'secret' }));

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer secret',
                Origin: 'https://example.test',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
            }),
        });

        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'Browser-origin MCP requests are not allowed.' });
    });

    it('can explicitly allow browser-origin requests for trusted test harnesses', async () => {
        const url = await listen(createHttpHandler(createOptions(), {
            bearerToken: 'secret',
            allowBrowserOrigins: true,
        }));

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer secret',
                Origin: 'https://example.test',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
            }),
        });

        expect(response.status).toBe(200);
    });

    it('rejects oversized JSON-RPC batches before processing', async () => {
        const options = createOptions();
        const url = await listen(createHttpHandler(options, { bearerToken: 'secret' }));
        const batch = Array.from({ length: 33 }, (_, index) => ({
            jsonrpc: '2.0',
            id: index + 1,
            method: index === 0 ? 'tools/call' : 'tools/list',
            ...(index === 0
                ? {params: {
                    name: 'evb_workspace_snapshot',
                    arguments: {},
                }}
                : {}),
        }));

        const response = await fetch(url, {
            method: 'POST',
            headers: { Authorization: 'Bearer secret' },
            body: JSON.stringify(batch),
        });
        const error = getErrorRecord(await response.json());

        expect(response.status).toBe(400);
        expect(error).toMatchObject({
            code: -32600,
            message: 'JSON-RPC batch is too large.',
        });
        expect(options.getWorkspaceSnapshot).not.toHaveBeenCalled();
    });
});
