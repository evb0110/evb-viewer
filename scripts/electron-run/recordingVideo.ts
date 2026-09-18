import { startRendererFrameStream } from '@scripts/diagnostics/startRendererFrameStream';
import {
    spawn,
    execFile,
} from 'node:child_process';
import { promisify } from 'node:util';
import { statSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import type { Page } from 'puppeteer-core';

const run = promisify(execFile);
const FPS = 15;

export function recordingFrameCount(elapsedMs: number) {
    return Math.max(1, Math.floor(elapsedMs * FPS / 1000) + 1);
}

export function recordingEncoderArgs(path: string, input: string[] = [
    '-f',
    'image2pipe',
    '-framerate',
    String(FPS),
    '-vcodec',
    'mjpeg',
    '-i',
    'pipe:0',
]) {
    return [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-probesize',
        '32',
        '-analyzeduration',
        '0',
        ...input,
        '-an',
        '-vf',
        'scale=1280:800:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1280:800:(ow-iw)/2:(oh-ih)/2',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '23',
        '-threads',
        '1',
        '-pix_fmt',
        'yuv420p',
        '-r',
        String(FPS),
        '-g',
        String(FPS),
        '-movflags',
        '+frag_keyframe+empty_moov+default_base_moof',
        '-progress',
        'pipe:2',
        '-stats_period',
        '0.1',
        path,
    ];
}

export async function assertRecordingTools() {
    await run(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-version']);
    await run(process.env.FFPROBE_PATH ?? 'ffprobe', ['-version']);
}

export async function inspectRecordingVideo(path: string) {
    const { stdout } = await run(process.env.FFPROBE_PATH ?? 'ffprobe', [
        '-v',
        'error',
        '-read_intervals',
        '%+2',
        '-select_streams',
        'v:0',
        '-count_frames',
        '-show_entries',
        'stream=width,height,nb_read_frames:format=duration',
        '-of',
        'json',
        path,
    ], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(stdout) as {
        streams?: Array<{
            width: number;
            height: number;
            nb_read_frames: string
        }>;
        format?: {duration: string};
    };
    const stream = result.streams?.[0];
    const frames = Number(stream?.nb_read_frames);
    const duration = Number(result.format?.duration);
    if (!stream || !(frames > 0) || !(duration > 0)) {
        throw new Error(`Recording has no decodable video: ${path}`);
    }
    return {
        sampledFrames: frames,
        duration,
        width: stream.width,
        height: stream.height,
        bytes: statSync(path).size,
    };
}

/** One encoder process belongs to one capture. Fragmented MP4 retains completed fragments after a crash. */
export function startVideoEncoder(path: string, onError: (error: Error) => void, input?: string[]) {
    const child = spawn(process.env.FFMPEG_PATH ?? 'ffmpeg', recordingEncoderArgs(path, input), {
        stdio: [
            'pipe',
            'ignore',
            'pipe',
        ],
        windowsHide: true,
    });
    let stopping = false;
    let failure: Error | null = null;
    let stderr = '';
    let resolveReady: () => void;
    let rejectReady: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // A failure may arrive before the caller awaits readiness.
    void ready.catch(() => {});
    const fail = (error: Error) => {
        if (failure) { return; }
        failure = error;
        rejectReady(error);
        onError(error);
    };
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stderr.on('data', (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-8192);
        if (/frame=\s*[1-9]\d*/.test(stderr)) { resolveReady(); }
    });
    const exited = new Promise<void>((resolve) => {
        child.once('close', (code) => {
            if (code !== 0 || !stopping) { fail(new Error(`Video encoder exited (${String(code)}): ${stderr}`)); }
            resolve();
        });
    });
    const readyTimer = setTimeout(() => fail(new Error('Video encoder produced no frame within 10 seconds')), 10_000);
    void ready.finally(() => clearTimeout(readyTimer)).catch(() => {});
    let stopPromise: Promise<Awaited<ReturnType<typeof inspectRecordingVideo>>> | null = null;
    return {
        ready,
        fail,
        get error() { return failure; },
        async write(frame: Buffer) {
            if (failure) { throw failure; }
            await new Promise<void>((resolve, reject) => {
                child.stdin.write(frame, error => error ? reject(error) : resolve());
            });
        },
        stop() {
            stopPromise ??= (async () => {
                stopping = true;
                clearTimeout(readyTimer);
                if (input && child.exitCode === null) { child.stdin.write('q\n'); }
                child.stdin.end();
                const timer = setTimeout(() => {
                    fail(new Error('Video encoder did not finalize within 10 seconds'));
                    child.kill('SIGKILL');
                }, 10_000);
                await exited;
                clearTimeout(timer);
                if (failure) { throw failure; }
                return inspectRecordingVideo(path);
            })();
            return stopPromise;
        },
    };
}

/** Bounded latest-frame buffer; CFR output follows elapsed time, including idle periods. */
export async function startRendererVideo(page: Page, path: string, onError: (error: Error) => void) {
    let latest = Buffer.from(await page.screenshot({
        type: 'jpeg',
        quality: 85,
        captureBeyondViewport: false,
    }));
    const encoder = startVideoEncoder(path, onError);
    let stopping = false;
    const startedAt = Date.now();
    const started = performance.now();
    let frames = 0;
    let streamFrames = 0;
    let firstFrame: () => void;
    const streamReady = new Promise<void>(resolve => { firstFrame = resolve; });
    let stream: Awaited<ReturnType<typeof startRendererFrameStream>> | null = null;
    const loop = (async () => {
        while (!stopping && !encoder.error) {
            const due = recordingFrameCount(performance.now() - started);
            if (due - frames > FPS * 5) { throw new Error('Recording fell more than 5 seconds behind real time'); }
            while (frames < due && !stopping) {
                await encoder.write(latest);
                frames++;
            }
            await wait(Math.max(1, frames * 1000 / FPS - (performance.now() - started)));
        }
    })().catch(error => encoder.fail(error instanceof Error ? error : new Error(String(error))));
    let stopPromise: ReturnType<typeof encoder.stop> | null = null;
    const stop = () => {
        stopPromise ??= (async () => {
            stopping = true;
            await stream?.stop().catch((error: unknown) => encoder.fail(error instanceof Error ? error : new Error(String(error))));
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
                loop,
                new Promise<void>(resolve => {
                    timer = setTimeout(() => {
                        encoder.fail(new Error('Video input did not drain within 5 seconds'));
                        resolve();
                    }, 5_000);
                }),
            ]);
            clearTimeout(timer);
            if (!encoder.error) {
                try {
                    if (!page.isClosed()) {
                        latest = Buffer.from(await page.screenshot({
                            type: 'jpeg',
                            quality: 85,
                            captureBeyondViewport: false,
                        }));
                    }
                    // Include the final visual state, even when stop follows the last input immediately.
                    const due = Math.max(frames + 1, recordingFrameCount(performance.now() - started));
                    while (frames < due) { await encoder.write(latest); frames++; }
                } catch (error) { encoder.fail(error instanceof Error ? error : new Error(String(error))); }
            }
            const result = await encoder.stop();
            await loop;
            if (Math.abs(result.duration - frames / FPS) > 0.2) {
                throw new Error(`Video duration ${result.duration}s disagrees with ${frames} written frames`);
            }
            return {
                ...result,
                writtenFrames: frames,
                streamFrames,
            };
        })();
        return stopPromise;
    };
    try {
        stream = await startRendererFrameStream(page, event => {
            latest = Buffer.from(event.data, 'base64');
            streamFrames++;
            firstFrame();
        }, {
            quality: 85,
            maxWidth: 1600,
            maxHeight: 1000,
        });
        let readyTimer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                Promise.all([
                    encoder.ready,
                    streamReady,
                ]),
                new Promise<never>((_, reject) => {
                    readyTimer = setTimeout(() => reject(new Error('No renderer screencast frame within 10 seconds')), 10_000);
                }),
            ]);
        } finally { clearTimeout(readyTimer); }
    } catch (error) {
        await stop().catch(() => {});
        throw error;
    }
    return {
        startedAt,
        stop,
    };
}
