export interface IDocumentTransition<TFence> {
    readonly fence: TFence;
    readonly isCurrent: () => boolean;
}

type TDocumentTransitionInput<
    TFence,
    TTransition extends IDocumentTransition<TFence>,
> = Omit<TTransition, 'isCurrent'>;

/**
 * Delivers transitions serially while the owning lifecycle says their fence
 * is current. Fence coordinates belong to the owner; this channel only
 * preserves order and revalidates between subscribers.
 */
export function createDocumentTransitionChannel<
    TFence,
    TTransition extends IDocumentTransition<TFence>,
>(isFenceCurrent: (fence: TFence) => boolean) {
    const listeners = new Set<(transition: TTransition) => void | Promise<void>>();
    let disposed = false;

    function subscribe(listener: (transition: TTransition) => void | Promise<void>) {
        if (disposed) {
            return () => {};
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }

    async function publish(input: TDocumentTransitionInput<TFence, TTransition>) {
        if (disposed || !isFenceCurrent(input.fence)) {
            return false;
        }
        const transition = Object.freeze({
            ...input,
            isCurrent: () => !disposed && isFenceCurrent(input.fence),
        }) as TTransition;
        for (const listener of [...listeners]) {
            if (!transition.isCurrent()) {
                return false;
            }
            await listener(transition);
        }
        return transition.isCurrent();
    }

    function dispose() {
        disposed = true;
        listeners.clear();
    }

    return {
        subscribe,
        publish,
        dispose,
    };
}
