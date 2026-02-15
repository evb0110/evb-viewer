import { delay } from 'es-toolkit/promise';

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
        await delay(delayMs);
        attempts += 1;
    }
}
