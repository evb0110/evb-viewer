import type * as RecordingVideo from '@scripts/electron-run/recordingVideo';
import { EventEmitter } from 'node:events';
import {
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    buildFfmpegArtifactCommands,
    startDiagnosticFrameCapture,
} from '@scripts/diagnostics/diagnosticFrameCapture';
import {
    startSessionRecording,
    recoverSessionRecording,
} from '@scripts/electron-run/sessionRecording';
import {
    recordingFrameCount,
    recordingEncoderArgs,
    startRendererVideo,
} from '@scripts/electron-run/recordingVideo';

vi.mock('@scripts/electron-run/recordingVideo', async (importOriginal) => ({
    ...await importOriginal<typeof RecordingVideo>(),
    assertRecordingTools: vi.fn(async () => {}),
    startRendererVideo: vi.fn(async () => ({
        startedAt: Date.now(),
        stop: async () => ({
            sampledFrames: 30,
            duration: 2,
            width: 1280,
            height: 800,
            bytes: 100,
        }),
    })),
    inspectRecordingVideo: vi.fn(async () => ({
        sampledFrames: 30,
        duration: 2,
        width: 1280,
        height: 800,
        bytes: 100,
    })),
}));

function recordingBrowser() {
    const page = Object.assign(new EventEmitter(), {
        exposeFunction: vi.fn(async () => {}),
        evaluateOnNewDocument: vi.fn(async () => {}),
        evaluate: vi.fn(async () => {}),
        url: (): string => 'evb-viewer://app/electron',
    });
    return {
        page,
        browser: Object.assign(new EventEmitter(), {pages: async () => [page]}),
    };
}

class FakeCdpClient extends EventEmitter {
    public readonly sentMethods: string[] = [];

    public async send(method: string) {
        this.sentMethods.push(method);
    }

    public async detach() {
        this.sentMethods.push('detach');
    }
}

describe('diagnostic frame capture', () => {
    it('preserves elapsed idle time on a 15 fps grid and writes crash-decodable MP4', () => {
        expect(recordingFrameCount(0)).toBe(1);
        expect(recordingFrameCount(60_000)).toBe(901);
        expect(recordingFrameCount(120_000) - recordingFrameCount(60_000)).toBe(900);
        const args = recordingEncoderArgs('/tmp/capture.mp4');
        expect(args).toContain('+frag_keyframe+empty_moov+default_base_moof');
        expect(args).not.toContain('glob');
    });

    it('serializes actions, omits typed secrets, and retains capture evidence after stopping', async () => {
        const root = mkdtempSync(join(tmpdir(), 'evb-recorded-session-'));
        const {browser} = recordingBrowser();
        try {
            const capture = await startSessionRecording(browser as never, {
                directory: root,
                session: 'proof',
                cwd: process.cwd(),
            });
            const order: string[] = [];
            let release: () => void = () => {};
            const barrier = new Promise<void>(resolve => { release = resolve; });
            const first = capture.command('type', [
                '#password',
                'do-not-log-this',
            ], async () => {
                order.push('first'); await barrier; order.push('first-done');
            });
            const second = capture.command('click', ['#save'], async () => { order.push('second'); });
            await Promise.resolve();
            expect(order).toEqual(['first']);
            expect(await capture.command('health', [], async () => 'inspect-with-command-pending')).toBe('inspect-with-command-pending');
            release();
            await Promise.all([
                first,
                second,
            ]);
            capture.mark('Saved');
            const manifest = await capture.stop();
            expect(order).toEqual([
                'first',
                'first-done',
                'second',
            ]);
            expect(manifest.status).toBe('complete');
            const actions = readFileSync(join(manifest.manifestPath, '..', 'actions.jsonl'), 'utf8');
            expect(actions).not.toContain('do-not-log-this');
            expect(actions).toContain('ui-input');
            expect(actions).toContain('Saved');
            expect(readFileSync(manifest.reviewPath, 'utf8')).toContain('window-1.mp4');
        } finally { rmSync(root, {
            recursive: true,
            force: true,
        }); }
    });

    it('blocks mutations after encoder failure while allowing evidence inspection', async () => {
        const root = mkdtempSync(join(tmpdir(), 'evb-recording-failure-'));
        const {browser} = recordingBrowser();
        try {
            const capture = await startSessionRecording(browser as never, {
                directory: root,
                session: 'failure',
                cwd: process.cwd(),
            });
            const reportError = vi.mocked(startRendererVideo).mock.calls.at(-1)?.[2];
            reportError?.(new Error('encoder pipe closed'));
            const mutate = vi.fn(async () => {});
            await expect(capture.command('click', ['#save'], mutate)).rejects.toThrow('Recording is failed');
            expect(mutate).not.toHaveBeenCalled();
            expect(await capture.command('health', [], async () => 'alive')).toBe('alive');
            expect((await capture.stop()).status).toBe('failed');
        } finally { rmSync(root, {
            recursive: true,
            force: true,
        }); }
    });

    it('follows new windows and finalizes each track once', async () => {
        const root = mkdtempSync(join(tmpdir(), 'evb-recording-windows-'));
        const {browser} = recordingBrowser();
        try {
            const capture = await startSessionRecording(browser as never, {
                directory: root,
                session: 'windows',
                cwd: process.cwd(),
            });
            const {page: printPage} = recordingBrowser();
            printPage.url = () => 'file:///C:/Temp/print-data-fixture.pdf';
            browser.emit('targetcreated', {
                type: () => 'page',
                page: async () => printPage,
            });
            await Promise.resolve();
            expect(printPage.exposeFunction).not.toHaveBeenCalled();
            expect(capture.manifest.tracks).toHaveLength(1);
            const {page} = recordingBrowser();
            page.url = () => 'about:blank';
            const target = {
                type: () => 'page',
                page: async () => page,
            };
            browser.emit('targetcreated', target);
            await Promise.resolve();
            expect(capture.manifest.tracks).toHaveLength(1);
            page.url = () => 'evb-viewer://app/electron?detachedNote=1';
            browser.emit('targetchanged', target);
            browser.emit('targetcreated', {
                type: () => 'page',
                page: async () => page,
            });
            await vi.waitFor(() => expect(capture.manifest.tracks[1]?.status).toBe('recording'));
            page.emit('close');
            const manifest = await capture.stop();
            expect(manifest.tracks.map(track => track.status)).toEqual([
                'complete',
                'complete',
            ]);
            expect(browser.listenerCount('targetcreated')).toBe(0);
            expect(browser.listenerCount('targetchanged')).toBe(0);
        } finally { rmSync(root, {
            recursive: true,
            force: true,
        }); }
    });

    it('recovers interrupted footage without claiming a completed run', async () => {
        const root = mkdtempSync(join(tmpdir(), 'evb-recording-recover-'));
        try {
            const path = join(root, 'manifest.json');
            writeFileSync(path, JSON.stringify({
                status: 'recording',
                errors: [],
                tracks: [{
                    id: 'window-1',
                    file: 'window-1.mp4',
                    status: 'recording',
                }],
            }));
            writeFileSync(join(root, 'actions.jsonl'), '{"kind":"command"}\n{"partial":');
            const result = await recoverSessionRecording(path);
            expect(result.status).toBe('failed');
            expect(result.tracks[0]?.video?.duration).toBe(2);
            expect(result.errors.join(' ')).toContain('Controller exited');
            expect(readFileSync(join(root, 'index.html'), 'utf8')).toContain('window-1.mp4');
        } finally { rmSync(root, {
            recursive: true,
            force: true,
        }); }
    });
    it('builds ffmpeg commands for mp4 and contact-sheet artifacts', () => {
        const commands = buildFfmpegArtifactCommands({
            fps: 24,
            frameCount: 100,
            framesDir: '/repo/.devkit/blink-video/frames',
            outDir: '/repo/.devkit/blink-video',
        });

        expect(commands.mp4.outputPath).toBe('/repo/.devkit/blink-video/trace.mp4');
        expect(commands.mp4.args).toContain('/repo/.devkit/blink-video/frames/frame-*.jpg');
        expect(commands.mp4.args).toContain('libx264');
        expect(commands.contactSheet.outputPath).toBe('/repo/.devkit/blink-video/contact-sheet.jpg');
        expect(commands.contactSheet.args).toContain('select=\'not(mod(n\\,4))\',scale=320:-1,tile=5x5');
    });

    it('drains accepted CDP screencast frames during stop', async () => {
        const outDir = mkdtempSync(join(tmpdir(), 'evb-frame-capture-'));
        const client = new FakeCdpClient();
        const page = { createCDPSession: async () => client };

        try {
            const capture = await startDiagnosticFrameCapture(page as never, {
                ffmpegCommand: process.execPath,
                outDir,
            });
            client.emit('Page.screencastFrame', {
                data: Buffer.from('first-frame').toString('base64'),
                sessionId: 1,
            });
            client.emit('Page.screencastFrame', {
                data: Buffer.from('second-frame').toString('base64'),
                sessionId: 2,
            });

            const result = await capture.stop();
            const frameFiles = readdirSync(result.framesDir).sort();

            expect(result.frameCount).toBe(2);
            expect(frameFiles).toHaveLength(2);
            const firstFrameFile = frameFiles[0];
            const secondFrameFile = frameFiles[1];
            if (!firstFrameFile || !secondFrameFile) {
                throw new Error('Expected two captured frame files');
            }
            expect(readFileSync(join(result.framesDir, firstFrameFile), 'utf8')).toBe('first-frame');
            expect(readFileSync(join(result.framesDir, secondFrameFile), 'utf8')).toBe('second-frame');
            expect(client.sentMethods.filter(method => method === 'Page.screencastFrameAck')).toHaveLength(2);
        } finally {
            rmSync(outDir, {
                force: true,
                recursive: true,
            });
        }
    });
});
