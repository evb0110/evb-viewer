export interface IDocumentThumbnailResizeAnchorLifecycle<TAnchor> {
    begin: () => void;
    cancel: () => void;
    finish: () => Promise<void>;
    isActive: () => boolean;
    preserve: () => boolean;
    read: () => TAnchor | null;
}

interface IDocumentThumbnailResizeAnchorLifecycleOptions<TAnchor> {
    capture: () => TAnchor | null;
    restore: (anchor: TAnchor) => boolean;
}

function waitForNextFrame() {
    return new Promise<void>((resolve) => {
        if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
            resolve();
            return;
        }
        window.requestAnimationFrame(() => resolve());
    });
}

/**
 * Owns the semantic scroll anchor shared by virtual thumbnail rails while a
 * workspace geometry transition is moving or resizing their DOM. Browsers can
 * reset a connected scroll element to zero when its Teleport target is
 * replaced, without dispatching a scroll event. Reapplying the anchor through
 * the next two paint opportunities keeps virtual state and real DOM aligned.
 */
export function createDocumentThumbnailResizeAnchorLifecycle<TAnchor>(
    options: IDocumentThumbnailResizeAnchorLifecycleOptions<TAnchor>,
): IDocumentThumbnailResizeAnchorLifecycle<TAnchor> {
    let anchor: TAnchor | null = null;
    let generation = 0;

    function preserve() {
        return anchor !== null && options.restore(anchor);
    }

    return {
        begin() {
            generation += 1;
            anchor = options.capture();
        },
        cancel() {
            generation += 1;
            anchor = null;
        },
        async finish() {
            const finishGeneration = generation;
            preserve();
            await nextTick();
            if (finishGeneration !== generation) {
                return;
            }
            preserve();
            await waitForNextFrame();
            if (finishGeneration !== generation) {
                return;
            }
            preserve();
            await waitForNextFrame();
            if (finishGeneration !== generation) {
                return;
            }
            preserve();
            anchor = null;
        },
        isActive: () => anchor !== null,
        preserve,
        read: () => anchor,
    };
}
