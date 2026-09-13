/**
 * Associates a visible open error with the exact document-open generation
 * that produced it. A late valid canvas may clear that error, but a success
 * from a superseding generation must never erase an unrelated failure.
 */
export function createDocumentOpenGenerationErrorLatch() {
    let failedGeneration: number | null = null;

    return {
        recordFailure(generation: number) {
            failedGeneration = generation;
        },
        consumeMatchingSuccess(generation: number) {
            if (failedGeneration !== generation) {
                return false;
            }
            failedGeneration = null;
            return true;
        },
        reset() {
            failedGeneration = null;
        },
    };
}
