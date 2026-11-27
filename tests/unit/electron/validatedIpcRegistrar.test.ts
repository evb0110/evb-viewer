import type {IpcMainEvent, IpcMainInvokeEvent} from 'electron';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createAbortError, isAbortError} from '@contracts/isAbortError';
import {isTimeoutError} from '@contracts/isTimeoutError';
import type {IIpcMainRegistrar} from '@contracts/ipcMain';
import {requireRequestId} from '@contracts/shared';
import {
    IPC_INVOKE_CANCEL_REASON_FIELD,
    IPC_INVOKE_REQUEST_ID_FIELD,
    decodeIpcInvokeCancelPayload,
} from '@electron/platform-ipc/coreContract';
import {beginIpcInvokeCancellation, cancelIpcInvoke} from '@electron/platform-ipc/ipcInvokeCancellation';
import {registerMainOperation, resetMainOperationLifecycleForTests} from '@electron/operation-lifecycle/mainOperationLifecycle';

const mocks = vi.hoisted(() => ({
    isTrustedIpcInvokeSender: vi.fn(() => true),
    isTrustedWebContentsSender: vi.fn(() => true),
}));
const logger = vi.hoisted(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}));

vi.mock('@electron/platform-ipc/trustedIpcSender', () => mocks);
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => logger}));

type TRegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function createNativeRegistrar() {
    const handlers = new Map<string, TRegisteredHandler>();
    const handle = vi.fn((channel: string, handler: TRegisteredHandler) => {
        handlers.set(channel, handler);
    });
    const registrar: IIpcMainRegistrar<never, IpcMainInvokeEvent> = {
        handle: handle as IIpcMainRegistrar<never, IpcMainInvokeEvent>['handle'],
    };

    return {
        handle,
        handlers,
        registrar,
    };
}

describe('validated IPC registrar argument policy', () => {
    afterEach(() => {
        resetMainOperationLifecycleForTests();
        logger.debug.mockClear();
        logger.warn.mockClear();
    });

    it('rejects invoke handlers without a decoder or explicit allowlist entry', async () => {
        const {createValidatedIpcMainRegistrar} = await import('@electron/platform-ipc/validatedIpcRegistrar');
        const native = createNativeRegistrar();
        const registrar = createValidatedIpcMainRegistrar(native.registrar, {allowedChannels: new Set(['test:requires-decoder'])});

        expect(() => {
            registrar.handle('test:requires-decoder', (_event, value: string) => value);
        }).toThrow('IPC invoke channel registered without an argument decoder or explicit no-arg allowlist: test:requires-decoder');
        expect(native.handle).not.toHaveBeenCalled();
    });

    it('allows decoded invoke handlers and wraps decoder failures with channel context', async () => {
        const {createValidatedIpcMainRegistrar} = await import('@electron/platform-ipc/validatedIpcRegistrar');
        const native = createNativeRegistrar();
        const registrar = createValidatedIpcMainRegistrar(native.registrar, {
            allowedChannels: new Set(['test:decoded']),
            codecs: {
                'test:decoded': {
                    decodeArgs: (args: readonly unknown[]) => {
                        if (typeof args[0] !== 'string') {
                            throw new Error('value must be a string');
                        }
                        return [args[0]] as [value: string];
                    },
                },
            },
        });

        registrar.handle('test:decoded', (_event, ...args) => String(args[0]));

        const handler = native.handlers.get('test:decoded');
        expect(handler).toBeTypeOf('function');
        await expect(handler?.({} as IpcMainInvokeEvent, 'ok')).resolves.toBe('ok');
        await expect(handler?.({} as IpcMainInvokeEvent, 42)).rejects.toThrow(
            'Invalid IPC arguments for test:decoded: value must be a string',
        );
    });

    it('cancels operations registered by a timed invoke when its request is canceled', async () => {
        const {createValidatedIpcMainRegistrar} = await import('@electron/platform-ipc/validatedIpcRegistrar');
        const native = createNativeRegistrar();
        const sender = {} as IpcMainInvokeEvent['sender'];
        const registrar = createValidatedIpcMainRegistrar(native.registrar, {
            allowedChannels: new Set(['test:timed']),
            codecs: {'test:timed': {decodeArgs: () => []}},
        });
        const cancel = vi.fn();
        let releaseHandler: (() => void) | undefined;
        registrar.handle('test:timed', () => {
            const operation = registerMainOperation({
                kind: 'abortable-work',
                ownerWebContentsId: 7,
                cancel,
            });
            return new Promise<string>((resolve) => {
                releaseHandler = () => {
                    operation.complete();
                    resolve('ok');
                };
            });
        });

        const handler = native.handlers.get('test:timed');
        const pending = handler?.({sender} as IpcMainInvokeEvent, {[IPC_INVOKE_REQUEST_ID_FIELD]: 'timed-request'});
        expect(pending).toBeInstanceOf(Promise);

        cancelIpcInvoke(sender, requireRequestId('timed-request'));
        expect(cancel).toHaveBeenCalledWith('IPC invoke canceled');
        releaseHandler?.();
        await expect(pending).resolves.toBe('ok');
    });

    it('allows explicitly no-argument invoke handlers and rejects runtime arguments', async () => {
        const {createValidatedIpcMainRegistrar} = await import('@electron/platform-ipc/validatedIpcRegistrar');
        const native = createNativeRegistrar();
        const registrar = createValidatedIpcMainRegistrar(native.registrar, {
            allowedChannels: new Set(['test:no-args']),
            argumentValidation: {noArgumentChannels: new Set(['test:no-args'])},
        });
        const handler = vi.fn(() => 'ok');

        registrar.handle('test:no-args', handler);

        const registeredHandler = native.handlers.get('test:no-args');
        expect(registeredHandler).toBeTypeOf('function');
        await expect(registeredHandler?.({} as IpcMainInvokeEvent)).resolves.toBe('ok');
        await expect(registeredHandler?.({} as IpcMainInvokeEvent, 'unexpected')).rejects.toThrow(
            'Invalid IPC arguments for test:no-args: expected no arguments',
        );
        expect(handler).toHaveBeenCalledOnce();
        expect(logger.warn).toHaveBeenCalledWith(
            'IPC handler rejected',
            expect.objectContaining({
                channel: 'test:no-args',
                error: expect.objectContaining({name: 'IpcArgumentValidationError'}),
            }),
        );
    });

    it('rejects policy entries outside the registrar channel allowlist', async () => {
        const {createValidatedIpcMainRegistrar} = await import('@electron/platform-ipc/validatedIpcRegistrar');
        const native = createNativeRegistrar();

        expect(() =>
            createValidatedIpcMainRegistrar(native.registrar, {
                allowedChannels: new Set(['test:known']),
                argumentValidation: {noArgumentChannels: new Set(['test:typo'])},
            }),
        ).toThrow('IPC argument validation policy contains unknown invoke channel: test:typo');
    });

    it('releases invoke and event channel reservations when their registrars are disposed', async () => {
        const {createValidatedIpcMainEventRegistrar, createValidatedIpcMainRegistrar} =
            await import('@electron/platform-ipc/validatedIpcRegistrar');
        const invokeNative = createNativeRegistrar();
        const invokeOptions = {
            allowedChannels: new Set(['test:released-invoke']),
            argumentValidation: {noArgumentChannels: new Set(['test:released-invoke'])},
        };
        const firstInvoke = createValidatedIpcMainRegistrar(invokeNative.registrar, invokeOptions);
        const releaseInvoke = firstInvoke.claim('test:released-invoke');

        expect(releaseInvoke).toBeTypeOf('function');
        releaseInvoke();

        const secondInvoke = createValidatedIpcMainRegistrar(invokeNative.registrar, invokeOptions);
        expect(() => secondInvoke.handle('test:released-invoke', () => undefined)).not.toThrow();
        expect(() => secondInvoke.handle('test:released-invoke', () => undefined)).toThrow(
            'Duplicate invoke IPC channel registration: test:released-invoke',
        );

        const events = new Map<string, (event: IpcMainEvent) => void>();
        const registerEvent = vi.fn((channel: string, handler: (event: IpcMainEvent) => void) => {
            events.set(channel, handler);
        });
        const eventSource = {on: registerEvent};
        const eventOptions = {allowedChannels: new Set(['test:released-event'])};
        const firstEvent = createValidatedIpcMainEventRegistrar(eventSource, eventOptions);
        const releaseEvent = firstEvent.claim('test:released-event');

        expect(releaseEvent).toBeTypeOf('function');
        releaseEvent();

        const secondEvent = createValidatedIpcMainEventRegistrar(eventSource, eventOptions);
        expect(() => secondEvent.on('test:released-event', () => undefined)).not.toThrow();
    });

    it('aborts IPC invoke cancellation signals with a canonical AbortError preserving reason', () => {
        const sender = {} as IpcMainInvokeEvent['sender'];
        const registration = beginIpcInvokeCancellation(sender, requireRequestId('cancel-reason-test'));

        cancelIpcInvoke(sender, requireRequestId('cancel-reason-test'), 'Renderer destroyed');

        expect(registration.signal.aborted).toBe(true);
        expect(isAbortError(registration.signal.reason)).toBe(true);
        expect(registration.signal.reason).toBeInstanceOf(Error);
        expect((registration.signal.reason as Error).message).toBe('Renderer destroyed');
        registration.complete();
    });

    it('logs canonical abort rejections at debug and warns on plain cancellation-worded errors', async () => {
        const {createValidatedIpcMainRegistrar} = await import('@electron/platform-ipc/validatedIpcRegistrar');
        const native = createNativeRegistrar();
        const registrar = createValidatedIpcMainRegistrar(native.registrar, {
            allowedChannels: new Set([
                'test:abort-error',
                'test:suppressed-abort',
                'test:plain-canceled-message',
                'test:plain-renderer-destroyed',
            ]),
            argumentValidation: {
                noArgumentChannels: new Set([
                    'test:abort-error',
                    'test:suppressed-abort',
                    'test:plain-canceled-message',
                    'test:plain-renderer-destroyed',
                ]),
            },
        });

        registrar.handle('test:abort-error', () => {
            throw createAbortError('Renderer destroyed');
        });
        registrar.handle('test:suppressed-abort', () => {
            throw new SuppressedError(new Error('cleanup failed'), new DOMException('canceled', 'AbortError'));
        });
        registrar.handle('test:plain-canceled-message', () => {
            throw new Error('Unexpected failure: upstream canceled connection');
        });
        registrar.handle('test:plain-renderer-destroyed', () => {
            throw new Error('Renderer destroyed');
        });

        await expect(native.handlers.get('test:abort-error')?.({} as IpcMainInvokeEvent)).rejects.toThrow('Renderer destroyed');
        await expect(native.handlers.get('test:suppressed-abort')?.({} as IpcMainInvokeEvent)).rejects.toBeInstanceOf(SuppressedError);
        expect(logger.debug).toHaveBeenCalledTimes(2);
        expect(logger.warn).not.toHaveBeenCalled();

        await expect(native.handlers.get('test:plain-canceled-message')?.({} as IpcMainInvokeEvent)).rejects.toThrow(
            'Unexpected failure: upstream canceled connection',
        );
        await expect(native.handlers.get('test:plain-renderer-destroyed')?.({} as IpcMainInvokeEvent)).rejects.toThrow(
            'Renderer destroyed',
        );
        expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it('preserves timeout identity in main when a timed IPC invoke expires', async () => {
        const {createValidatedIpcMainRegistrar} = await import('@electron/platform-ipc/validatedIpcRegistrar');
        const native = createNativeRegistrar();
        const sender = {} as IpcMainInvokeEvent['sender'];
        const registrar = createValidatedIpcMainRegistrar(native.registrar, {
            allowedChannels: new Set(['test:timed-out-invoke']),
            codecs: {'test:timed-out-invoke': {decodeArgs: () => []}},
        });
        let operationSignal: AbortSignal | undefined;
        registrar.handle('test:timed-out-invoke', () => {
            const operation = registerMainOperation({
                kind: 'abortable-work',
                ownerWebContentsId: 9,
            });
            operationSignal = operation.signal;
            return new Promise<string>((_resolve, reject) => {
                operation.signal.addEventListener(
                    'abort',
                    () => {
                        operation.complete();
                        reject(operation.signal.reason);
                    },
                    {once: true},
                );
            });
        });

        const payload = {
            [IPC_INVOKE_REQUEST_ID_FIELD]: 'timed-out-request',
            [IPC_INVOKE_CANCEL_REASON_FIELD]: 'timeout',
        };
        const decoded = decodeIpcInvokeCancelPayload(payload);
        expect(decoded).toEqual({
            requestId: 'timed-out-request',
            kind: 'timeout',
        });

        const handler = native.handlers.get('test:timed-out-invoke');
        const pending = handler?.({sender} as IpcMainInvokeEvent, {[IPC_INVOKE_REQUEST_ID_FIELD]: 'timed-out-request'});
        cancelIpcInvoke(sender, decoded!.requestId, undefined, {timedOut: decoded!.kind === 'timeout'});

        await expect(pending).rejects.toThrow('IPC invoke timed out');
        expect(operationSignal?.aborted).toBe(true);
        expect(isTimeoutError(operationSignal?.reason)).toBe(true);
        expect(isAbortError(operationSignal?.reason)).toBe(false);
        expect(logger.warn).toHaveBeenCalledOnce();
        expect(logger.debug).not.toHaveBeenCalled();
    });
});
