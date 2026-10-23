type TTaskResolver = () => void;

let taskChannel: MessageChannel | null | undefined;
const pendingTaskResolvers: TTaskResolver[] = [];

function getTaskChannel() {
    if (taskChannel !== undefined) {
        return taskChannel;
    }

    if (typeof MessageChannel !== 'function') {
        taskChannel = null;
        return taskChannel;
    }

    taskChannel = new MessageChannel();
    taskChannel.port1.onmessage = () => {
        pendingTaskResolvers.shift()?.();
    };
    return taskChannel;
}

/** Yield nonvisual work without waiting for a repaint that a hidden tab may never receive. */
export async function yieldToBrowser() {
    const channel = getTaskChannel();
    if (channel) {
        await new Promise<void>((resolve) => {
            pendingTaskResolvers.push(resolve);
            channel.port2.postMessage(undefined);
        });
        return;
    }

    await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });
}

export function resetBrowserYieldStateForTests() {
    pendingTaskResolvers.length = 0;
    taskChannel = undefined;
}
