import {vi} from 'vitest';

type TListener = (...args: unknown[]) => void;

export interface ITestEventSender {
    id: number;
    destroyed: boolean;
    emit: (event: string, ...args: unknown[]) => boolean;
    isDestroyed: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
}

export const createDeferred = <T>() => Promise.withResolvers<T>();

export function createTestEventSender(id: number, send = vi.fn()): ITestEventSender {
    const listeners = new Map<string, Set<TListener>>();
    const onceListeners = new Map<string, Set<TListener>>();
    const sender: ITestEventSender = {
        id,
        destroyed: false,
        emit: (event, ...args) => {
            sender.destroyed ||= event === 'destroyed';
            const current = [...(listeners.get(event) ?? []), ...(onceListeners.get(event) ?? [])];
            onceListeners.delete(event);
            current.forEach((listener) => listener(...args));
            return current.length > 0;
        },
        isDestroyed: vi.fn(() => sender.destroyed),
        on: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
        send,
    };
    const add = (registry: Map<string, Set<TListener>>, event: string, listener: TListener) => {
        registry.set(event, (registry.get(event) ?? new Set()).add(listener));
        return sender;
    };
    sender.on.mockImplementation((event: string, listener: TListener) => add(listeners, event, listener));
    sender.once.mockImplementation((event: string, listener: TListener) => add(onceListeners, event, listener));
    sender.removeListener.mockImplementation((event: string, listener: TListener) => {
        listeners.get(event)?.delete(listener);
        onceListeners.get(event)?.delete(listener);
        return sender;
    });
    return sender;
}
