export async function waitForBoundedAssistantInterrupt(operation: Promise<unknown>, timeoutMs = 5_000) {
    let timeout: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            operation,
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error('Assistant interrupt timed out.')), timeoutMs);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}
