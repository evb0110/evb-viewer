import { createLogger } from '@electron/utils/createLogger';
import {
    mainJobBroker,
    type IJobBrokerLease,
} from '@electron/resources/jobBroker';
import { getOcrRuntimePolicy } from '@electron/features/ocr/main/ocrRuntimePolicy';

const log = createLogger('ocr-resource-governor');

const DEFAULT_PAGE_WIDTH_IN = 8.5;
const DEFAULT_PAGE_HEIGHT_IN = 11;
const BYTES_PER_RGBA_PIXEL = 4;
const MAX_RENDERED_PIXELS = 45_000_000;
const HIGH_DPI_THRESHOLD = 450;
const HIGH_DPI_PAGE_SLOT_COST = 2;

export interface IOcrResourceRequest {
    jobId: string;
    pageNumber: number;
    requestedDpi: number;
    pageWidthIn?: number;
    pageHeightIn?: number;
    signal: AbortSignal;
}

interface IOcrResourceLease {
    token: string;
    jobId: string;
    slotCost: number;
    brokerLease?: IJobBrokerLease | undefined;
}

function removeLease(
    activeLeases: ReadonlyMap<string, IOcrResourceLease>,
    predicate: (token: string, lease: IOcrResourceLease) => boolean,
) {
    return new Map(Array.from(activeLeases.entries()).filter(([
        token,
        lease,
    ]) => !predicate(token, lease)));
}

function getPageDimensions(request: Pick<IOcrResourceRequest, 'pageWidthIn' | 'pageHeightIn'>) {
    const widthIn = typeof request.pageWidthIn === 'number' && Number.isFinite(request.pageWidthIn) && request.pageWidthIn > 0
        ? request.pageWidthIn
        : DEFAULT_PAGE_WIDTH_IN;
    const heightIn = typeof request.pageHeightIn === 'number' && Number.isFinite(request.pageHeightIn) && request.pageHeightIn > 0
        ? request.pageHeightIn
        : DEFAULT_PAGE_HEIGHT_IN;
    return {
        widthIn,
        heightIn,
    };
}

function estimateRenderedPixels(dpi: number, request: Pick<IOcrResourceRequest, 'pageWidthIn' | 'pageHeightIn'> = {}) {
    const {
        widthIn,
        heightIn,
    } = getPageDimensions(request);
    return Math.ceil(widthIn * dpi) * Math.ceil(heightIn * dpi);
}

function estimateRenderedBytes(dpi: number, request: Pick<IOcrResourceRequest, 'pageWidthIn' | 'pageHeightIn'> = {}) {
    return estimateRenderedPixels(dpi, request) * BYTES_PER_RGBA_PIXEL;
}

function assertRenderedPixelAdmission(request: IOcrResourceRequest) {
    const requestedPixels = estimateRenderedPixels(request.requestedDpi, request);
    if (requestedPixels <= MAX_RENDERED_PIXELS) {
        return;
    }
    throw new RangeError(
        `OCR page ${request.pageNumber} at ${request.requestedDpi} DPI requires ${requestedPixels} rendered pixels; maximum is ${MAX_RENDERED_PIXELS}. Choose a lower quality setting explicitly.`,
    );
}

function getPageSlotCost(
    effectiveDpi: number,
    request: IOcrResourceRequest,
    globalSlotBudget: number,
) {
    const renderedPageBytes = estimateRenderedBytes(effectiveDpi, request);
    if (effectiveDpi >= HIGH_DPI_THRESHOLD || renderedPageBytes > (MAX_RENDERED_PIXELS * BYTES_PER_RGBA_PIXEL) / 2) {
        return Math.min(HIGH_DPI_PAGE_SLOT_COST, globalSlotBudget);
    }

    return 1;
}

class OcrResourceGovernor {
    private activeLeases = new Map<string, IOcrResourceLease>();
    private tokenCounter = 0;

    async acquire(request: IOcrResourceRequest) {
        assertRenderedPixelAdmission(request);
        const effectiveDpi = request.requestedDpi;
        const { globalPageSlots } = getOcrRuntimePolicy();
        const slotCost = getPageSlotCost(
            effectiveDpi,
            request,
            globalPageSlots,
        );

        const brokerLease = await mainJobBroker.acquire({
            ownerId: request.jobId,
            kind: 'ocr-page',
            priority: 'user',
            perOwnerLimit: globalPageSlots,
            resources: {
                cpuTokens: slotCost,
                estimatedResidentBytes: estimateRenderedBytes(effectiveDpi, request),
                nativeProcesses: 1,
                ioWeight: 1,
            },
            signal: request.signal,
        });
        const lease = this.createLease(
            request.jobId,
            slotCost,
            globalPageSlots,
        );
        lease.brokerLease = brokerLease;
        return {
            ...lease,
            effectiveDpi,
        };
    }

    release(token: string) {
        const lease = this.activeLeases.get(token);
        if (!lease) {
            return false;
        }
        lease.brokerLease?.release();
        this.activeLeases = removeLease(this.activeLeases, candidate => candidate === token);
        return true;
    }

    releaseForJob(token: string, jobId: string) {
        const lease = this.activeLeases.get(token);
        if (!lease || lease.jobId !== jobId) {
            return false;
        }
        return this.release(token);
    }

    cancelPendingForJob(jobId: string, reason = `OCR resource requests cancelled for job ${jobId}`) {
        // Termination uncertainty closes admission for pages that have not
        // received a lease. Existing leases remain owned by the job until
        // their individual proof or physical finalization.
        mainJobBroker.cancelOwner(jobId, reason);
    }

    releaseJob(jobId: string) {
        for (const lease of this.activeLeases.values()) {
            if (lease.jobId === jobId) {
                lease.brokerLease?.release();
            }
        }
        this.activeLeases = removeLease(this.activeLeases, (_token, lease) => lease.jobId === jobId);
        mainJobBroker.cancelOwner(jobId, `OCR resource request cancelled for job ${jobId}`);

    }

    reset() {
        const ownerIds = new Set<string>();
        for (const lease of this.activeLeases.values()) {
            lease.brokerLease?.release();
            ownerIds.add(lease.jobId);
        }
        ownerIds.forEach(ownerId => mainJobBroker.cancelOwner(ownerId, 'OCR resource governor reset'));
        this.activeLeases.clear();
    }

    private createLease(
        jobId: string,
        slotCost: number,
        globalPageSlots: number,
    ): IOcrResourceLease {
        const token = `${Date.now()}-${++this.tokenCounter}`;
        const lease = {
            token,
            jobId,
            slotCost,
        };
        this.activeLeases.set(token, lease);
        log.debug(`Granted OCR resource slot to ${jobId}; activeSlots=${this.getActiveSlotCost()}/${globalPageSlots}`);
        return lease;
    }

    private getActiveSlotCost() {
        return Array.from(this.activeLeases.values())
            .reduce((total, lease) => total + lease.slotCost, 0);
    }

}

export const ocrResourceGovernor = new OcrResourceGovernor();
