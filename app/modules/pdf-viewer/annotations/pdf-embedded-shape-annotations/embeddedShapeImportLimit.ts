/**
 * Embedded shape scanning parses the whole document in a worker, so it is bounded
 * by input size. Above this limit the shape layer is left unscanned: the document
 * opens and saves normally, and saves stay additive so unseen managed shapes are
 * never garbage-collected.
 */
export const EMBEDDED_SHAPE_IMPORT_MAX_INPUT_BYTES = 96 * 1024 * 1024;

/**
 * Refuses an input the shape scanner cannot hold. The `RangeError` is the wire
 * that tells the shape runtime this is a resource policy, not a broken document.
 */
export function assertEmbeddedShapeImportSize(byteLength: number) {
    if (byteLength > EMBEDDED_SHAPE_IMPORT_MAX_INPUT_BYTES) {
        throw new RangeError(
            `Embedded shape import is unavailable for PDFs larger than ${
                EMBEDDED_SHAPE_IMPORT_MAX_INPUT_BYTES / (1024 * 1024)
            } MiB`,
        );
    }
}
