import type { IJobResourceVector } from '@electron/resources/jobBroker';

export const PDF_IMAGE_COMBINE_BINARY = 'evb-pdf-image-combine';
export const PDF_IMAGE_COMBINE_THREADS_ENV = 'EVB_PDF_COMBINE_THREADS';

/** A combine worker thread may retain one prepared image of up to 512 MiB. */
export const PDF_IMAGE_COMBINE_THREAD_RESIDENT_BYTES = 512 * 1024 * 1024;

/** Memory for the image combiner's first thread, within the broker's budget. */
export function resolvePdfImageCombineResidentBytes(capacity: Pick<IJobResourceVector, 'estimatedResidentBytes'>) {
    return Math.min(PDF_IMAGE_COMBINE_THREAD_RESIDENT_BYTES, capacity.estimatedResidentBytes);
}

/** Thread count allowed by the lease's cores and prepared-image memory. */
export function resolvePdfImageCombineThreads(
    resources: Pick<IJobResourceVector, 'cpuTokens' | 'estimatedResidentBytes'>,
) {
    return Math.max(1, Math.min(
        Math.floor(resources.cpuTokens),
        Math.floor(resources.estimatedResidentBytes / PDF_IMAGE_COMBINE_THREAD_RESIDENT_BYTES),
    ));
}
