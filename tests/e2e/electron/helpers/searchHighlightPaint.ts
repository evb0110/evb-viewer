import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createCanvas, loadImage} from '@napi-rs/canvas';
import type {CDPSession, Page} from 'puppeteer-core';

export interface ISearchHighlightPaintViewportRect {
    bottom: number;
    left: number;
    right: number;
    top: number;
}

export interface ISearchHighlightPaintViewportSize {
    height: number;
    width: number;
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

export interface ISearchHighlightPaintFrame {
    capturedAtMs: number;
    data: Buffer;
    metadata?: IScreencastFrameMetadata;
}

export interface ISearchHighlightPaintCapture {
    frames: ISearchHighlightPaintFrame[];
    stop: () => Promise<ISearchHighlightPaintFrame[]>;
}

function isWarmHighlightPixel(red: number, green: number, blue: number, alpha: number) {
    return alpha > 0 && red > 175 && green > 95 && red - blue > 45 && green - blue > 20;
}

export async function countWarmHighlightPixels(
    screenshot: Uint8Array,
    viewportRect: ISearchHighlightPaintViewportRect,
    viewportSize: ISearchHighlightPaintViewportSize,
    orangeOnly = false,
) {
    const image = await loadImage(Buffer.from(screenshot));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);

    const scaleX = image.width / viewportSize.width;
    const scaleY = image.height / viewportSize.height;
    const startX = Math.max(0, Math.floor(viewportRect.left * scaleX));
    const endX = Math.min(image.width, Math.ceil(viewportRect.right * scaleX));
    const startY = Math.max(0, Math.floor(viewportRect.top * scaleY));
    const endY = Math.min(image.height, Math.ceil(viewportRect.bottom * scaleY));
    if (endX <= startX || endY <= startY) {
        return 0;
    }

    const pixels = context.getImageData(startX, startY, endX - startX, endY - startY).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
        if (
            isWarmHighlightPixel(pixels[index] ?? 0, pixels[index + 1] ?? 0, pixels[index + 2] ?? 0, pixels[index + 3] ?? 0) &&
            (!orangeOnly || (pixels[index] ?? 0) - (pixels[index + 1] ?? 0) > 25)
        ) {
            count += 1;
        }
    }
    return count;
}

export async function countOrangeHighlightPixelsInFrame(
    frame: ISearchHighlightPaintFrame,
    viewportRect: ISearchHighlightPaintViewportRect,
    viewportSize: ISearchHighlightPaintViewportSize,
) {
    return countWarmHighlightPixels(
        frame.data,
        viewportRect,
        {
            width: frame.metadata?.deviceWidth ?? viewportSize.width,
            height: frame.metadata?.deviceHeight ?? viewportSize.height,
        },
        true,
    );
}

async function acknowledgeFrame(client: CDPSession, sessionId: number) {
    await client.send('Page.screencastFrameAck', {sessionId}).catch(() => {});
}

export async function startSearchHighlightPaintCapture(page: Page): Promise<ISearchHighlightPaintCapture> {
    const client = await page.target().createCDPSession();
    const frames: ISearchHighlightPaintFrame[] = [];
    const startedAt = Date.now();
    let acceptingFrames = true;
    let stopped = false;
    const pendingAcks = new Set<Promise<void>>();
    const ack = (sessionId: number) => {
        const pending = acknowledgeFrame(client, sessionId);
        pendingAcks.add(pending);
        void pending.finally(() => pendingAcks.delete(pending));
    };
    const handleFrame = (event: IScreencastFrameEvent) => {
        if (acceptingFrames) {
            frames.push({
                capturedAtMs: Date.now() - startedAt,
                data: Buffer.from(event.data, 'base64'),
                ...(event.metadata ? {metadata: event.metadata} : {}),
            });
        }
        ack(event.sessionId);
    };

    client.on('Page.screencastFrame', handleFrame);
    try {
        const viewport = await page.evaluate(() => ({
            width: window.innerWidth,
            height: window.innerHeight,
        }));
        await client.send('Page.enable');
        await client.send('Page.startScreencast', {
            everyNthFrame: 1,
            format: 'jpeg',
            maxWidth: viewport.width,
            maxHeight: viewport.height,
            quality: 85,
        });
    } catch (error) {
        acceptingFrames = false;
        client.off('Page.screencastFrame', handleFrame);
        await client.detach().catch(() => {});
        throw error;
    }

    return {
        frames,
        stop: async () => {
            if (stopped) {
                return frames;
            }
            stopped = true;
            await client.send('Page.stopScreencast').catch(() => {});
            acceptingFrames = false;
            client.off('Page.screencastFrame', handleFrame);
            await Promise.allSettled([...pendingAcks]);
            await client.detach().catch(() => {});
            return frames;
        },
    };
}

function sanitizeEvidenceLabel(label: string) {
    return (
        label
            .trim()
            .replace(/[^a-zA-Z0-9._-]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 80) || 'search-highlight'
    );
}

export function writeSearchHighlightPaintEvidence(input: {
    diagnostic: unknown;
    frames: readonly ISearchHighlightPaintFrame[];
    label: string;
    orangePixelCounts: readonly number[];
}) {
    const outputDir = join(process.cwd(), '.devkit', 'fresh-highlight');
    mkdirSync(outputDir, {recursive: true});
    const stamp = `${Date.now()}-${sanitizeEvidenceLabel(input.label)}`;
    const framePaths = input.frames.map((frame, index) => {
        const path = join(outputDir, `paint-frame-${stamp}-${String(index + 1).padStart(4, '0')}.jpg`);
        writeFileSync(path, frame.data);
        return path;
    });
    const tracePath = join(outputDir, `paint-trace-${stamp}.json`);
    writeFileSync(
        tracePath,
        JSON.stringify(
            {
                diagnostic: input.diagnostic,
                frames: input.frames.map((frame, index) => ({
                    capturedAtMs: frame.capturedAtMs,
                    metadata: frame.metadata,
                    path: framePaths[index],
                    orangePixelCount: input.orangePixelCounts[index] ?? null,
                })),
            },
            null,
            2,
        ),
    );
    return {
        framePaths,
        tracePath,
    };
}
