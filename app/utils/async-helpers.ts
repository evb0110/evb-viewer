interface IWaitUntilIdleOptions {
    delayMs?: number;
    maxAttempts?: number;
}

export async function waitUntilIdle(
    isBusy: () => boolean,
    options: IWaitUntilIdleOptions = {},
) {
    const {
        delayMs = 25,
        maxAttempts = 120,
    } = options;
    let attempts = 0;
    while (isBusy() && attempts < maxAttempts) {
        await new Promise<void>(resolve => setTimeout(resolve, delayMs));
        attempts += 1;
    }
}
