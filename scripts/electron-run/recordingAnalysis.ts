import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
    mkdir, mkdtemp, readFile, realpath, unlink, writeFile,
} from 'node:fs/promises';
import {
    basename, dirname, join, resolve, sep,
} from 'node:path';
import { promisify } from 'node:util';
import { inspectRecordingVideo } from '@scripts/electron-run/recordingVideo';

const run = promisify(execFile);
interface IReviewEvent extends Record<string, unknown> { atMs: number }
interface IReviewTrack {
    id: string;
    file: string;
    atMs: number;
    status: string
}
interface IReviewOptions {
    from?: number;
    to?: number;
    step?: number;
    at?: number[];
    track?: string
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Sample the whole interval, its boundaries, and both sides of meaningful actions. */
export function recordingReviewTimes(duration: number, atMs: number, events: IReviewEvent[], options: IReviewOptions = {}) {
    const from = options.from ?? 0;
    const to = Math.min(options.to ?? duration, duration);
    const step = options.step ?? 5;
    if (![
        duration,
        atMs,
        from,
        to,
        step,
    ].every(Number.isFinite)
        || duration <= 0 || atMs < 0 || from < 0 || from >= to || step < 0.05) {
        throw new Error('Review requires 0 <= from < to <= duration and step >= 0.05 seconds');
    }
    if (options.at) {
        if (!options.at.length || options.at.length > 600
            || options.at.some(time => !Number.isFinite(time) || time < 0 || time >= duration)) {
            throw new Error('Explicit timestamps must contain 1 to 600 times within the video duration');
        }
        return [...new Set(options.at)].sort((a, b) => a - b);
    }
    const last = Math.max(from, to - 1 / 15);
    const times = new Set<number>();
    const add = (time: number) => {
        times.add(Math.round(Math.max(from, Math.min(last, time)) * 1000) / 1000);
        if (times.size > 600) {
            throw new Error('Review exceeds 600 frames per track. Review explicit --from/--to intervals or increase --step.');
        }
    };
    for (let time = from; time < to; time += step) { add(time); }
    add(last);
    for (const event of events) {
        if (event.kind === 'input' && ![
            'click',
            'pointerdown',
            'keydown',
            'wheel',
        ].includes(String(event.type))) { continue; }
        const time = (event.atMs - atMs) / 1000;
        if (time < from || time > to) { continue; }
        add(time - 0.25);
        add(time + 0.75);
    }
    return [...times].sort((a, b) => a - b);
}

async function hash(path: string) {
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
        if (!Buffer.isBuffer(chunk)) { throw new Error('Expected binary video data'); }
        digest.update(chunk);
    }
    return digest.digest('hex');
}

function escapeHtml(value: string) {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

async function ffmpeg(args: string[]) {
    return run(process.env.FFMPEG_PATH ?? 'ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        ...args,
    ], {
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
    });
}

/** Tiny numeric labels avoid platform fonts and optional FFmpeg drawtext builds. */
export function recordingContactSheet(frames: Array<{ seconds: number }>, first: number, tiles: Buffer) {
    const glyphs: Record<string, string> = {
        '0': '111101101101111',
        '1': '010110010010111',
        '2': '111001111100111',
        '3': '111001111001111',
        '4': '101101111001001',
        '5': '111100111001111',
        '6': '111100111101111',
        '7': '111001001001001',
        '8': '111101111101111',
        '9': '111101111001111',
        '.': '000000000000010',
        's': '011100010001110',
    };
    const width = 1152;
    const height = Math.ceil(frames.length / 3) * 264;
    const pixels = Buffer.alloc(width * height * 3);
    if (tiles.length !== frames.length * 384 * 240 * 3) { throw new Error('Contact sheet frame count mismatch'); }
    for (const [
        index,
        frame,
    ] of frames.entries()) {
        for (let row = 0; row < 240; row++) {
            const source = (index * 384 * 240 + row * 384) * 3;
            const destination = ((Math.floor(index / 3) * 264 + row) * width + index % 3 * 384) * 3;
            tiles.copy(pixels, destination, source, source + 384 * 3);
        }
        const label = `${first + index + 1}  ${frame.seconds.toFixed(3)}s`;
        for (const [
            letter,
            character,
        ] of [...label].entries()) {
            const glyph = glyphs[character];
            if (!glyph) { continue; }
            for (let cell = 0; cell < 15; cell++) {
                if (glyph[cell] !== '1') { continue; }
                for (let dy = 0; dy < 3; dy++) {
                    for (let dx = 0; dx < 3; dx++) {
                        const x = index % 3 * 384 + 8 + letter * 12 + cell % 3 * 3 + dx;
                        const y = Math.floor(index / 3) * 264 + 244 + Math.floor(cell / 3) * 3 + dy;
                        pixels.fill(255, (y * width + x) * 3, (y * width + x) * 3 + 3);
                    }
                }
            }
        }
    }
    return Buffer.concat([
        Buffer.from(`P6\n${width} ${height}\n255\n`),
        pixels,
    ]);
}

/** Derived evidence only: source videos, manifests, and failed capture provenance stay unchanged. */
export async function prepareRecordingReview(path: string, options: IReviewOptions = {}) {
    const manifestPath = resolve(path.endsWith('.json') ? path : join(path, 'manifest.json'));
    const directory = await realpath(dirname(manifestPath));
    const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!record(manifest) || ![
        'complete',
        'failed',
    ].includes(String(manifest.status)) || !Array.isArray(manifest.tracks)) {
        throw new Error('Review requires a stopped recording manifest with complete or failed status');
    }
    const tracks: IReviewTrack[] = manifest.tracks.map((track: unknown) => {
        if (!record(track) || typeof track.id !== 'string' || typeof track.file !== 'string'
            || typeof track.atMs !== 'number' || !Number.isFinite(track.atMs) || track.atMs < 0
            || ![
                'complete',
                'failed',
            ].includes(String(track.status))) {
            throw new Error('Invalid recording track');
        }
        return {
            id: track.id,
            file: track.file,
            atMs: track.atMs,
            status: String(track.status),
        };
    }).filter(track => !options.track || track.id === options.track);
    if (!tracks.length) { throw new Error('Recording has no video tracks to review'); }
    const events: IReviewEvent[] = (await readFile(join(directory, 'actions.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => {
        const value: unknown = JSON.parse(line);
        if (!record(value) || typeof value.atMs !== 'number' || !Number.isFinite(value.atMs) || value.atMs < 0) {
            throw new Error('Invalid action timestamp');
        }
        return {
            ...value,
            atMs: value.atMs,
        };
    });
    await mkdir(join(directory, 'reviews'), { recursive: true });
    const output = await mkdtemp(join(directory, 'reviews', 'review-'));
    const results = [];
    for (const [
        index,
        track,
    ] of tracks.entries()) {
        const source = await realpath(resolve(directory, track.file));
        if (!source.startsWith(directory + sep)) { throw new Error('Video path escapes the recording directory'); }
        const name = `track-${index + 1}`;
        const trackDir = join(output, name);
        await mkdir(trackDir);
        console.error(`[Review] ${track.id}: checking every video frame`);
        // FFprobe metadata and a valid first fragment do not establish that the whole file decodes.
        const decoded = await ffmpeg([
            '-xerror',
            '-i',
            source,
            '-map',
            '0:v:0',
            '-f',
            'null',
            '-',
        ]);
        if (decoded.stderr.trim()) { throw new Error(`Video decode errors: ${decoded.stderr}`); }
        const probe = await inspectRecordingVideo(source);
        const video = join(trackDir, 'video.mp4');
        // Keep the crash-resilient source; make a regular MP4 with duration/index up front for browser review.
        await ffmpeg([
            '-i',
            source,
            '-map',
            '0:v:0',
            '-c',
            'copy',
            '-movflags',
            '+faststart',
            video,
        ]);
        const normalized = await inspectRecordingVideo(video);
        if (Math.abs(normalized.duration - probe.duration) > 0.1) { throw new Error('Review video duration changed during remux'); }
        const relevantEvents = events.filter(event => !event.trackId || event.trackId === track.id);
        const times = recordingReviewTimes(probe.duration, track.atMs, relevantEvents, options);
        const frames = [];
        console.error(`[Review] ${track.id}: extracting ${times.length} frames and contact sheets`);
        for (const [
            frameIndex,
            time,
        ] of times.entries()) {
            const frame = `frame-${String(frameIndex + 1).padStart(4, '0')}.png`;
            const frameSeconds = Math.floor(time * probe.frameRate + 1e-6) / probe.frameRate;
            await ffmpeg([
                '-ss',
                String(Math.max(0, frameSeconds - 0.000001)),
                '-i',
                video,
                '-frames:v',
                '1',
                join(trackDir, frame),
            ]);
            const frameHash = await hash(join(trackDir, frame)); // Missing final frame is an extraction failure.
            frames.push({
                file: `${name}/${frame}`,
                seconds: time,
                frameSeconds,
                sessionMs: track.atMs + Math.round(time * 1000),
                sha256: frameHash,
            });
        }
        const sheets: Array<{
            file: string;
            firstFrame: number;
            lastFrame: number
        }> = [];
        for (let first = 0; first < frames.length; first += 12) {
            const count = Math.min(12, frames.length - first);
            const sheet = `sheet-${String(sheets.length + 1).padStart(3, '0')}.jpg`;
            const { stdout: tiles } = await run(process.env.FFMPEG_PATH ?? 'ffmpeg', [
                '-hide_banner',
                '-loglevel',
                'error',
                '-nostdin',
                '-start_number',
                String(first + 1),
                '-i',
                join(trackDir, 'frame-%04d.png'),
                '-vf',
                'scale=384:240:force_original_aspect_ratio=decrease,pad=384:240:(ow-iw)/2:(oh-ih)/2:black',
                '-frames:v',
                String(count),
                '-f',
                'rawvideo',
                '-pix_fmt',
                'rgb24',
                'pipe:1',
            ], {
                encoding: 'buffer',
                maxBuffer: 16 * 1024 * 1024,
                timeout: 120_000,
                windowsHide: true,
            });
            const bitmap = join(trackDir, `sheet-${first}.ppm`);
            await writeFile(bitmap, recordingContactSheet(frames.slice(first, first + count), first, tiles));
            await ffmpeg([
                '-i',
                bitmap,
                '-frames:v',
                '1',
                join(trackDir, sheet),
            ]);
            await unlink(bitmap);
            sheets.push({
                file: `${name}/${sheet}`,
                firstFrame: first + 1,
                lastFrame: first + count,
            });
        }
        results.push({
            id: track.id,
            captureStatus: track.status,
            source: track.file,
            sourceSha256: await hash(source),
            video: `${name}/video.mp4`,
            videoSha256: await hash(video),
            probe,
            frames,
            sheets,
        });
    }
    const report = {
        version: 1,
        captureStatus: manifest.status,
        captureErrors: manifest.errors,
        scope: manifest.scope,
        sourceManifest: manifestPath,
        sourceManifestSha256: await hash(manifestPath),
        visualAssessment: 'required',
        sampling: {
            step: options.step ?? 5,
            from: options.from ?? 0,
            to: options.to ?? null,
            at: options.at ?? null,
            timestampMeaning: 'Requested video times; frameSeconds identifies the containing frame on the recorder constant-frame-rate timeline.',
            limitation: 'Sampled frames do not prove motion or every transient state. Inspect dense intervals where needed.',
        },
        tracks: results,
        events,
    };
    await writeFile(join(output, 'review.json'), JSON.stringify(report, null, 2) + '\n');
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Recording visual review</title>
<style>body{font:16px system-ui;max-width:1200px;margin:24px auto;padding:16px;background:#f5f7fa;color:#17202b}video,img{max-width:100%}article{background:white;padding:20px;margin:20px 0}li{margin:8px 0}</style>
<h1>Recording visual review</h1><p>Capture: ${escapeHtml(String(manifest.status))}. Visual assessment: required. Extraction success is not task success.</p><a href="review.json">Timestamps, actions, hashes and coverage</a>
${results.map(track => `<article><h2>${escapeHtml(track.id)}</h2><video controls preload="metadata" src="${track.video}"></video><p>${track.probe.duration.toFixed(2)} seconds. Capture: ${escapeHtml(track.captureStatus)}.</p>
${track.sheets.map(sheet => `<a href="${sheet.file}"><img src="${sheet.file}" alt="Frames ${sheet.firstFrame} to ${sheet.lastFrame}" loading="lazy"></a>`).join('')}
<details><summary>Full-resolution frames and timestamps</summary><ol>${track.frames.map(frame => `<li><a href="${frame.file}">${escapeHtml(basename(frame.file))}</a>: video ${frame.seconds.toFixed(3)} s, session ${(frame.sessionMs / 1000).toFixed(3)} s</li>`).join('')}</ol></details></article>`).join('')}</html>`;
    await writeFile(join(output, 'index.html'), html);
    return {
        directory: output,
        reviewPath: join(output, 'index.html'),
        reportPath: join(output, 'review.json'),
        captureStatus: manifest.status,
        visualAssessment: 'required',
        tracks: results.map(track => ({
            id: track.id,
            sheets: track.sheets.map(sheet => join(output, sheet.file)),
            frames: track.frames.length,
        })),
    };
}
