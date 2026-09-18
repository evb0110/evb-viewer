import { startRendererFrameStream } from '@scripts/diagnostics/startRendererFrameStream';
import { getErrorMessage } from '@contracts/getErrorMessage';
import { execFile } from 'node:child_process';
import {
    mkdirSync,
    writeFileSync,
} from 'node:fs';
import {
    join,
    resolve,
} from 'node:path';
import { promisify } from 'node:util';
import type {
    CDPSession,
    Page,
} from 'puppeteer-core';

const execFileAsync = promisify(execFile);

export type TDiagnosticFrameCaptureMode = 'cdp-screencast' | 'screenshot-fallback';

interface IDiagnosticFrameCaptureOptions {
    ffmpegCommand?: string;
    fps?: number;
    maxFrames?: number;
    outDir: string;
    quality?: number;
    screenshotIntervalMs?: number;
}

interface IScreencastFrameMetadata {
    deviceHeight?: number;
    deviceWidth?: number;
    pageScaleFactor?: number;
    scrollOffsetX?: number;
    scrollOffsetY?: number;
    timestamp?: number;
}

interface IScreencastFrameEvent {
    data: string;
    metadata?: IScreencastFrameMetadata;
    sessionId: number;
}

export interface IDiagnosticFrameCaptureFrame {
    atMs: number;
    cdpTimestamp: number | null;
    index: number;
    path: string;
}

export interface IFfmpegCommandSpec {
    args: string[];
    outputPath: string;
}

export interface IFfmpegArtifactCommands {
    contactSheet: IFfmpegCommandSpec;
    mp4: IFfmpegCommandSpec;
}

interface IFfmpegArtifactResult {
    available: boolean;
    command: string;
    contactSheetPath: string | null;
    error: string | null;
    mp4Path: string | null;
}

export interface IDiagnosticFrameCaptureResult {
    contactSheetPath: string | null;
    fallbackReason: string | null;
    ffmpeg: IFfmpegArtifactResult;
    frameCount: number;
    frames: IDiagnosticFrameCaptureFrame[];
    framesDir: string;
    mode: TDiagnosticFrameCaptureMode;
    mp4Path: string | null;
    outDir: string;
}

export interface IDiagnosticFrameCapture { stop: () => Promise<IDiagnosticFrameCaptureResult>; }

function clampInteger(value: number | undefined, fallback: number, min: number, max: number) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(value)));
}

function formatFrameName(index: number, atMs: number) {
    const paddedIndex = String(index).padStart(6, '0');
    const paddedMs = String(Math.max(0, Math.round(atMs))).padStart(7, '0');
    return `frame-${paddedIndex}-t+${paddedMs}ms.jpg`;
}

function normalizeCaptureOptions(options: IDiagnosticFrameCaptureOptions) {
    return {
        ffmpegCommand: options.ffmpegCommand ?? process.env.FFMPEG_PATH ?? 'ffmpeg',
        fps: clampInteger(options.fps, 30, 1, 120),
        maxFrames: clampInteger(options.maxFrames, 900, 1, 10_000),
        outDir: resolve(options.outDir),
        quality: clampInteger(options.quality, 80, 1, 100),
        screenshotIntervalMs: clampInteger(options.screenshotIntervalMs, 100, 16, 5_000),
    };
}

export function buildFfmpegArtifactCommands(payload: {
    fps: number;
    frameCount: number;
    framesDir: string;
    outDir: string;
}): IFfmpegArtifactCommands {
    const frameGlob = join(payload.framesDir, 'frame-*.jpg');
    const mp4Path = join(payload.outDir, 'trace.mp4');
    const contactSheetPath = join(payload.outDir, 'contact-sheet.jpg');
    const sampledFrameCount = Math.min(25, payload.frameCount);
    const tileColumns = Math.min(5, Math.max(1, sampledFrameCount));
    const tileRows = Math.max(1, Math.ceil(sampledFrameCount / tileColumns));
    const stride = Math.max(1, Math.floor(payload.frameCount / sampledFrameCount));

    return {
        contactSheet: {
            outputPath: contactSheetPath,
            args: [
                '-y',
                '-pattern_type',
                'glob',
                '-framerate',
                String(payload.fps),
                '-i',
                frameGlob,
                '-vf',
                `select='not(mod(n\\,${stride}))',scale=320:-1,tile=${tileColumns}x${tileRows}`,
                '-frames:v',
                '1',
                contactSheetPath,
            ],
        },
        mp4: {
            outputPath: mp4Path,
            args: [
                '-y',
                '-pattern_type',
                'glob',
                '-framerate',
                String(payload.fps),
                '-i',
                frameGlob,
                '-vf',
                'scale=trunc(iw/2)*2:trunc(ih/2)*2',
                '-c:v',
                'libx264',
                '-pix_fmt',
                'yuv420p',
                mp4Path,
            ],
        },
    };
}

async function createFfmpegArtifacts(options: {
    command: string;
    fps: number;
    frameCount: number;
    framesDir: string;
    outDir: string;
}): Promise<IFfmpegArtifactResult> {
    if (options.frameCount < 1) {
        return {
            available: false,
            command: options.command,
            contactSheetPath: null,
            error: 'No frames captured.',
            mp4Path: null,
        };
    }

    const commands = buildFfmpegArtifactCommands({
        fps: options.fps,
        frameCount: options.frameCount,
        framesDir: options.framesDir,
        outDir: options.outDir,
    });

    try {
        await execFileAsync(options.command, commands.mp4.args);
        await execFileAsync(options.command, commands.contactSheet.args);
        return {
            available: true,
            command: options.command,
            contactSheetPath: commands.contactSheet.outputPath,
            error: null,
            mp4Path: commands.mp4.outputPath,
        };
    } catch (error) {
        return {
            available: false,
            command: options.command,
            contactSheetPath: null,
            error: getErrorMessage(error),
            mp4Path: null,
        };
    }
}

function createFrameWriter(options: {
    frames: IDiagnosticFrameCaptureFrame[];
    framesDir: string;
    maxFrames: number;
    startedAt: number;
}) {
    return (data: Buffer | Uint8Array, cdpTimestamp: number | null) => {
        if (options.frames.length >= options.maxFrames) {
            return;
        }

        const index = options.frames.length + 1;
        const atMs = Date.now() - options.startedAt;
        const framePath = join(options.framesDir, formatFrameName(index, atMs));
        writeFileSync(framePath, data);
        options.frames.push({
            atMs,
            cdpTimestamp,
            index,
            path: framePath,
        });
    };
}

async function startCdpScreencastCapture(page: Page, options: {
    frames: IDiagnosticFrameCaptureFrame[];
    framesDir: string;
    maxFrames: number;
    quality: number;
    startedAt: number;
}) {
    const writeFrame = createFrameWriter(options);
    return startRendererFrameStream(page, event => {
        writeFrame(Buffer.from(event.data, 'base64'), event.metadata?.timestamp ?? null);
    }, {quality: options.quality});
}

function startScreenshotFallbackCapture(page: Page, options: {
    frames: IDiagnosticFrameCaptureFrame[];
    framesDir: string;
    intervalMs: number;
    maxFrames: number;
    quality: number;
    startedAt: number;
}) {
    const writeFrame = createFrameWriter(options);
    let stopped = false;
    let pendingCapture = Promise.resolve();

    const capture = () => {
        pendingCapture = pendingCapture.finally(async () => {
            if (stopped || options.frames.length >= options.maxFrames) {
                return;
            }
            const data = await page.screenshot({
                captureBeyondViewport: false,
                quality: options.quality,
                type: 'jpeg',
            });
            writeFrame(data, null);
        });
    };

    capture();
    const interval = setInterval(capture, options.intervalMs);

    const stop = async () => {
        stopped = true;
        clearInterval(interval);
        await pendingCapture.catch(() => {});
    };

    return { stop };
}

export async function startDiagnosticFrameCapture(
    page: Page,
    rawOptions: IDiagnosticFrameCaptureOptions,
): Promise<IDiagnosticFrameCapture> {
    const options = normalizeCaptureOptions(rawOptions);
    const framesDir = join(options.outDir, 'frames');
    const frames: IDiagnosticFrameCaptureFrame[] = [];
    const startedAt = Date.now();
    mkdirSync(framesDir, { recursive: true });

    let mode: TDiagnosticFrameCaptureMode = 'cdp-screencast';
    let fallbackReason: string | null = null;
    let cdpCapture: {
        client: CDPSession;
        handleFrame: (event: IScreencastFrameEvent) => void;
        stop: () => Promise<void>;
    } | null = null;
    let fallbackCapture: { stop: () => Promise<void>; } | null = null;

    try {
        cdpCapture = await startCdpScreencastCapture(page, {
            frames,
            framesDir,
            maxFrames: options.maxFrames,
            quality: options.quality,
            startedAt,
        });
    } catch (error) {
        mode = 'screenshot-fallback';
        fallbackReason = getErrorMessage(error);
        fallbackCapture = startScreenshotFallbackCapture(page, {
            frames,
            framesDir,
            intervalMs: options.screenshotIntervalMs,
            maxFrames: options.maxFrames,
            quality: options.quality,
            startedAt,
        });
    }

    const stop = async () => {
        await cdpCapture?.stop();
        await fallbackCapture?.stop();
        const ffmpeg = await createFfmpegArtifacts({
            command: options.ffmpegCommand,
            fps: options.fps,
            frameCount: frames.length,
            framesDir,
            outDir: options.outDir,
        });
        return {
            contactSheetPath: ffmpeg.contactSheetPath,
            fallbackReason,
            ffmpeg,
            frameCount: frames.length,
            frames,
            framesDir,
            mode,
            mp4Path: ffmpeg.mp4Path,
            outDir: options.outDir,
        };
    };

    return { stop };
}
