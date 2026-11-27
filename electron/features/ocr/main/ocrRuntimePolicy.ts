import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {clamp} from 'es-toolkit/math';
import type {IHostResourceProfileSnapshot} from '@contracts/hostResourceProfile';
import {HOST_TIER_LOW_RAM_MAX_GIB} from '@contracts/hostResourceProfile';
import {type TOcrModelCode, withOcrModelSublanguages} from '@contracts/ocrLanguages';
import {parseBoundedEnvInt} from '@contracts/resourcePolicies';
import {readPnmSize} from '@ocr-core/ppmRaster';
import type {TOcrEngineImageInput} from '@electron/features/ocr/main/ocrEngineHostProtocol';
import type {IJobResourceVector} from '@electron/resources/jobBroker';
import {getHostResourceProfileSnapshot} from '@electron/resources/hostResourceProfile';
import {runtimeConfig} from '@electron/runtimeConfig';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const LOW_MEMORY_BYTES = HOST_TIER_LOW_RAM_MAX_GIB * GIB;
// A host with at most 4 GiB recognizes one page at a time, whatever its tier.
const SINGLE_LANE_MAX_MEMORY_BYTES = 4 * GIB;
const BASE_NORMAL_PAGE_SLOTS = 3;
const LOW_MEMORY_PAGE_SLOTS = 2;
const NORMAL_RENDERED_PAGE_BYTES = 33_660_000;
/**
 * A warm engine keeps each model it read about two and a half times over:
 * the file Tesseract was handed and the networks it built from it.
 */
export const OCR_LANE_MODEL_BYTES_FACTOR = 2.5;
/** The engine's WebAssembly heap before a page: code, stacks and Tesseract's own tables. */
export const OCR_LANE_BASE_WASM_HEAP_BYTES = 192 * MIB;
/** Tesseract's working images of one page pixel: color, gray, binary and the line images. */
export const OCR_LANE_WASM_HEAP_BYTES_PER_PIXEL = 12;

export interface IOcrRuntimePolicy {
    globalPageSlots: number;
    modelDownloadConcurrency: number;
}

function getCpuSlotCount(logicalCpus: number) {
    return Math.max(1, Math.floor(logicalCpus / 2));
}

function getMemorySlotCount(memoryBytes: number) {
    if (memoryBytes <= 0) {
        return BASE_NORMAL_PAGE_SLOTS;
    }

    const memoryBudgetRatio = memoryBytes >= 32 * GIB ? 0.18 : memoryBytes >= 16 * GIB ? 0.12 : 0.08;
    return Math.max(1, Math.floor((memoryBytes * memoryBudgetRatio) / NORMAL_RENDERED_PAGE_BYTES));
}

function getLaneCeiling(profile: IHostResourceProfileSnapshot) {
    return profile.totalRamBytes > 0 && profile.totalRamBytes <= SINGLE_LANE_MAX_MEMORY_BYTES ? 1 : Math.max(1, profile.logicalCpus);
}

/**
 * Page lanes scale with cores and memory alone; the job broker then charges
 * each lane what its engine really holds, so lanes that do not fit wait.
 */
export function resolveOcrRuntimePolicy(profile: IHostResourceProfileSnapshot, env: NodeJS.ProcessEnv): IOcrRuntimePolicy {
    const isLowTier = profile.tier === 'low';
    const laneCeiling = getLaneCeiling(profile);
    const defaultGlobalPageSlots = isLowTier
        ? 1
        : profile.totalRamBytes > 0 && profile.totalRamBytes < LOW_MEMORY_BYTES
          ? LOW_MEMORY_PAGE_SLOTS
          : Math.min(getCpuSlotCount(profile.logicalCpus), getMemorySlotCount(profile.totalRamBytes));
    const globalPageSlots = parseBoundedEnvInt(env.OCR_GLOBAL_PAGE_SLOTS, {
        fallback: clamp(defaultGlobalPageSlots, 1, laneCeiling),
        min: 1,
        max: laneCeiling,
    });
    const configuredModelDownloadConcurrency = runtimeConfig.ocrModelDownloadConcurrency;
    const modelDownloadConcurrency = configuredModelDownloadConcurrency || (isLowTier ? 1 : 3);

    return {
        globalPageSlots,
        modelDownloadConcurrency,
    };
}

export function getOcrRuntimePolicy() {
    return resolveOcrRuntimePolicy(getHostResourceProfileSnapshot(), process.env);
}

function readRasterPixelCount(image: TOcrEngineImageInput) {
    if (!(image instanceof Uint8Array)) {
        return image.width * image.height;
    }
    try {
        const {width, height} = readPnmSize(image);
        return width * height;
    } catch {
        return image.byteLength;
    }
}

/**
 * What one OCR lane holds while it recognizes a page: its models, read
 * `2.5 * modelBytes`, and the WebAssembly heap the page needs. Clamped to
 * the broker's capacity so that a page larger than the budget still runs,
 * alone.
 */
export function resolveOcrLaneResources(
    modelBytes: number,
    image: TOcrEngineImageInput,
    capacity: Readonly<IJobResourceVector>,
): IJobResourceVector {
    const wasmHeapBytes = OCR_LANE_BASE_WASM_HEAP_BYTES + readRasterPixelCount(image) * OCR_LANE_WASM_HEAP_BYTES_PER_PIXEL;
    return {
        cpuTokens: Math.min(1, capacity.cpuTokens),
        estimatedResidentBytes: Math.min(
            capacity.estimatedResidentBytes,
            Math.ceil(OCR_LANE_MODEL_BYTES_FACTOR * Math.max(0, modelBytes) + wasmHeapBytes),
        ),
        nativeProcesses: 0,
        ioWeight: 0,
    };
}

/**
 * Reads the installed bytes of each model an engine request loads, with the
 * sub-languages Tesseract loads beside them. A model not installed yet, such
 * as an early-print one, counts nothing and is read again next time.
 */
export function createOcrModelBytesReader(tessdataDir: string) {
    const sizes = new Map<TOcrModelCode, Promise<number>>();
    const readSize = (code: TOcrModelCode) => {
        let size = sizes.get(code);
        if (size === undefined) {
            size = stat(join(tessdataDir, `${code}.traineddata`)).then((model) => model.size);
            size.catch(() => sizes.delete(code));
            sizes.set(code, size);
        }
        return size.catch(() => 0);
    };
    return async (models: readonly TOcrModelCode[]): Promise<ReadonlyMap<TOcrModelCode, number>> => {
        const codes = withOcrModelSublanguages(models);
        const sizes = await Promise.all(codes.map(readSize));
        return new Map(codes.map((code, index) => [code, sizes[index]!]));
    };
}

export function sumOcrModelBytes(sizes: ReadonlyMap<TOcrModelCode, number>) {
    let total = 0;
    for (const size of sizes.values()) {
        total += size;
    }
    return total;
}
