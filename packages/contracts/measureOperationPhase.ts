export async function measureOperationPhase<T>(operation: () => Promise<T>, onComplete: (durationMs: number) => void): Promise<T> {
    const startedAt = typeof performance === 'undefined' ? Date.now() : performance.now();
    try {
        return await operation();
    } finally {
        const durationMs = Math.round(((typeof performance === 'undefined' ? Date.now() : performance.now()) - startedAt) * 10) / 10;
        try {
            onComplete(durationMs);
        } catch {
            // Measurement must never change the operation's result.
        }
    }
}
