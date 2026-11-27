interface IRafHost {
    requestAnimationFrame(callback: FrameRequestCallback): number;
    cancelAnimationFrame(handle: number): void;
}

export function createRafBurstScheduler(callback: () => void, rafHost?: IRafHost) {
    const host = rafHost ?? (typeof window !== 'undefined' ? window : undefined);
    let frameId: number | null = null;

    const runFrame = () => {
        frameId = null;
        callback();
    };

    return {
        request() {
            if (!host) {
                callback();
                return;
            }

            if (frameId !== null) {
                return;
            }

            frameId = host.requestAnimationFrame(runFrame);
        },
        cancel() {
            if (host && frameId !== null) {
                host.cancelAnimationFrame(frameId);
            }
            frameId = null;
        },
    };
}
