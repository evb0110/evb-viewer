import { randomUUID } from 'node:crypto';
import {
    appendFileSync,
    mkdirSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
    assertRecordingTools,
    startVideoEncoder,
} from '@scripts/electron-run/recordingVideo';
import { recordingReviewHtml } from '@scripts/electron-run/recordingReviewHtml';

import type { INativeUiActionLog } from '@scripts/windows-test/guest/native-ui/nativeUiAdapter';

/** Called only by the qualified guest worker on its unlocked test desktop. */
export async function startNativeVideo(directory: string, actionLog?: INativeUiActionLog) {
    if (process.platform !== 'win32') { throw new Error('Native Windows video requires the Windows test guest'); }
    await assertRecordingTools();
    const root = join(directory, `${Date.now()}-native-${randomUUID().slice(0, 8)}`);
    mkdirSync(root, {recursive: true});
    const errors: string[] = [];
    const started = performance.now();
    const actions: unknown[] = [];
    const actionsPath = join(root, 'actions.jsonl');
    writeFileSync(actionsPath, '');
    const unsubscribe = actionLog?.subscribe?.(entry => {
        const event = {
            kind: 'native-input',
            trackId: 'desktop',
            atMs: Math.round(performance.now() - started),
            ...entry,
        };
        actions.push(event);
        appendFileSync(actionsPath, JSON.stringify(event) + '\n');
    });
    const track = {
        id: 'desktop',
        file: 'desktop.mp4',
        atMs: 0,
        status: 'recording',
        video: null as unknown,
    };
    const manifest = {
        version: 1,
        session: 'windows-native-acceptance',
        scope: 'windows-guest-desktop',
        inputLogAvailable: Boolean(actionLog?.subscribe),
        platform: process.platform,
        status: 'recording',
        startedAt: new Date().toISOString(),
        endedAt: null as string | null,
        errors,
        tracks: [track],
        manifestPath: join(root, 'manifest.json'),
        reviewPath: join(root, 'index.html'),
    };
    const persist = () => writeFileSync(manifest.manifestPath, JSON.stringify(manifest, null, 2));
    const encoder = startVideoEncoder(join(root, track.file), error => {
        errors.push(error.message);
        manifest.status = 'failed';
        persist();
    }, [
        '-f',
        'gdigrab',
        '-framerate',
        '15',
        '-draw_mouse',
        '1',
        '-i',
        'desktop',
    ]);
    persist();
    try { await encoder.ready; }
    catch (error) {
        unsubscribe?.();
        await encoder.stop().catch(() => {});
        manifest.endedAt = new Date().toISOString();
        manifest.status = 'failed';
        track.status = 'failed';
        persist();
        writeFileSync(manifest.reviewPath, recordingReviewHtml(manifest, actions));
        throw error;
    }
    let stopping: Promise<void> | null = null;
    return {async stop() {
        stopping ??= (async () => {
            unsubscribe?.();
            try { track.video = await encoder.stop(); }
            catch (error) { errors.push(String(error)); }
            manifest.endedAt = new Date().toISOString();
            manifest.status = errors.length ? 'failed' : 'complete';
            track.status = manifest.status;
            persist();
            writeFileSync(manifest.reviewPath, recordingReviewHtml(manifest, actions));
            if (errors.length) { throw new Error(`Native recording failed: ${manifest.manifestPath}`); }
        })();
        return stopping;
    }};
}
