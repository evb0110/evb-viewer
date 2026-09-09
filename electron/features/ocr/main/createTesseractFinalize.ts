export interface ITesseractFinalizeHandles {
    timeoutHandle: NodeJS.Timeout | null;
    killHandle: NodeJS.Timeout | null;
    forceFinalizeHandle: NodeJS.Timeout | null;
}

export type TTesseractFinalize<TResult> = (result: TResult) => void;

export function createTesseractFinalize<TResult>(
    handles: ITesseractFinalizeHandles,
    resolve: (result: TResult) => void,
    onFinalize?: () => void,
): TTesseractFinalize<TResult> {
    let settled = false;

    return (result) => {
        if (settled) {
            return;
        }

        settled = true;
        if (handles.timeoutHandle) {
            clearTimeout(handles.timeoutHandle);
            handles.timeoutHandle = null;
        }
        if (handles.killHandle) {
            clearTimeout(handles.killHandle);
            handles.killHandle = null;
        }
        if (handles.forceFinalizeHandle) {
            clearTimeout(handles.forceFinalizeHandle);
            handles.forceFinalizeHandle = null;
        }
        onFinalize?.();
        resolve(result);
    };
}
