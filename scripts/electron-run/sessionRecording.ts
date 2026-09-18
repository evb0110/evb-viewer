import { randomUUID } from 'node:crypto';
import {
    appendFileSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type {
    Browser,
    Page,
    Target,
} from 'puppeteer-core';
import {
    assertRecordingTools,
    inspectRecordingVideo,
    startRendererVideo,
} from '@scripts/electron-run/recordingVideo';
import { recordingReviewHtml } from '@scripts/electron-run/recordingReviewHtml';

interface IRecordingTrack {
    id: string;
    file: string;
    atMs: number;
    status: 'starting' | 'recording' | 'complete' | 'failed';
    endedAtMs?: number;
    video?: {
        sampledFrames: number;
        writtenFrames?: number;
        streamFrames?: number;
        duration: number;
        width: number;
        height: number;
        bytes: number
    };
}

function sourceIdentity(cwd: string) {
    try {
        return {
            sha: execFileSync('git', [
                'rev-parse',
                'HEAD',
            ], {
                cwd,
                encoding: 'utf8',
            }).trim(),
            dirty: execFileSync('git', [
                'status',
                '--porcelain',
            ], {
                cwd,
                encoding: 'utf8',
            }).trim().length > 0,
        };
    } catch { return {
        sha: null,
        dirty: null,
    }; }
}

/** Runs inside the renderer. Records input delivery without reading typed text or password values. */
function observeInput(binding: string) {
    const installed: unknown = Reflect.get(window, binding + '_installed');
    if (installed) { return; }
    Reflect.set(window, binding + '_installed', true);
    let movedAt = 0;
    for (const type of [
        'pointermove',
        'pointerdown',
        'pointerup',
        'click',
        'keydown',
        'keyup',
        'wheel',
    ]) {
        document.addEventListener(type, (event) => {
            if (type === 'pointermove' && performance.now() - movedAt < 100) { return; }
            if (type === 'pointermove') { movedAt = performance.now(); }
            const mouse = event instanceof MouseEvent ? event : null;
            const keyboard = event instanceof KeyboardEvent ? event : null;
            const wheel = event instanceof WheelEvent ? event : null;
            const emit = Reflect.get(window, binding) as (value: unknown) => Promise<void>;
            void emit({
                type,
                trusted: event.isTrusted,
                width: innerWidth,
                height: innerHeight,
                ...(mouse ? {
                    x: mouse.clientX,
                    y: mouse.clientY,
                    button: mouse.button,
                } : {}),
                ...(keyboard ? {
                    ...(/^(Enter|NumpadEnter|Tab|Escape|Backspace|Delete|Arrow(Up|Down|Left|Right)|Home|End|Page(Up|Down)|F[0-9]+|Shift(Left|Right)|Control(Left|Right)|Alt(Left|Right)|Meta(Left|Right))$/.test(keyboard.code) ? {code: keyboard.code} : {}),
                    ctrl: keyboard.ctrlKey,
                    alt: keyboard.altKey,
                    meta: keyboard.metaKey,
                    shift: keyboard.shiftKey,
                } : {}),
                ...(wheel ? {
                    deltaX: wheel.deltaX,
                    deltaY: wheel.deltaY,
                } : {}),
            }).catch(() => {});
        }, {
            capture: true,
            passive: true,
        });
    }
}

export async function startSessionRecording(browser: Browser, options: {
    directory: string;
    session: string;
    cwd: string
}) {
    await assertRecordingTools();
    const directory = join(options.directory, `${Date.now()}-${randomUUID().slice(0, 8)}`);
    mkdirSync(directory, {recursive: true});
    const actionsPath = join(directory, 'actions.jsonl');
    const manifestPath = join(directory, 'manifest.json');
    const startedAt = Date.now();
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const manifest = {
        version: 1,
        session: options.session,
        platform: process.platform,
        scope: 'electron-renderer',
        source: sourceIdentity(options.cwd),
        startedAt: new Date(startedAt).toISOString(),
        endedAt: null as string | null,
        status: 'starting' as 'starting' | 'recording' | 'complete' | 'failed',
        reviewPath: join(directory, 'index.html'),
        manifestPath,
        errors: [] as string[],
        tracks: [] as IRecordingTrack[],
    };
    const persist = () => {
        writeFileSync(manifestPath + '.tmp', JSON.stringify(manifest, null, 2));
        renameSync(manifestPath + '.tmp', manifestPath);
    };
    const event = (data: Record<string, unknown>) => appendFileSync(actionsPath, JSON.stringify({
        ...data,
        atMs: elapsed(),
    }) + '\n');
    const fail = (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!manifest.errors.includes(message)) { manifest.errors.push(message); }
        manifest.status = 'failed';
        event({
            kind: 'capture-error',
            error: message,
        });
        persist();
    };
    const pages = new Map<Page, Promise<() => Promise<void>>>();
    let stopping = false;
    const attach = (page: Page) => {
        if (pages.has(page) || stopping) { return pages.get(page); }
        const capture = (async () => {
            const id = `window-${manifest.tracks.length + 1}`;
            const track: IRecordingTrack = {
                id,
                file: `${id}.mp4`,
                atMs: elapsed(),
                status: 'starting',
            };
            manifest.tracks.push(track);
            persist();
            const binding = `evbRecording_${randomUUID().replaceAll('-', '')}`;
            try {
                await page.exposeFunction(binding, (input: Record<string, unknown>) => {
                    if (!stopping) { event({
                        ...input,
                        kind: 'input',
                        trackId: id,
                    }); }
                });
                await page.evaluateOnNewDocument(observeInput, binding);
                await page.evaluate(observeInput, binding);
                const video = await startRendererVideo(page, join(directory, track.file), fail);
                track.atMs = video.startedAt - startedAt;
                track.status = 'recording';
                event({
                    kind: 'window-attached',
                    trackId: id,
                    url: page.url(),
                });
                persist();
                let stopPromise: Promise<void> | null = null;
                const stop = () => {
                    stopPromise ??= (async () => {
                        track.endedAtMs = elapsed();
                        try { track.video = await video.stop(); track.status = 'complete'; }
                        catch (error) { track.status = 'failed'; fail(error); }
                        event({
                            kind: 'window-ended',
                            trackId: id,
                            status: track.status,
                        });
                        persist();
                    })();
                    return stopPromise;
                };
                page.once('close', () => { void stop(); });
                page.on('error', error => fail(error));
                return stop;
            } catch (error) {
                track.status = 'failed';
                track.endedAtMs = elapsed();
                persist();
                throw error;
            }
        })();
        pages.set(page, capture);
        void capture.catch(fail);
        return capture;
    };
    const onTarget = (target: Target) => {
        if (target.type() === 'page') {
            void target.page().then(page => page ? attach(page) : undefined).catch(fail);
        }
    };
    browser.on('targetcreated', onTarget);
    let queue = Promise.resolve();
    let pendingActions = 0;
    let stopPromise: Promise<typeof manifest> | null = null;
    const stop = (exitCode = 0) => {
        stopPromise ??= (async () => {
            stopping = true;
            if (pendingActions) { fail(new Error('Session stopped before pending commands completed')); }
            browser.off('targetcreated', onTarget);
            event({
                kind: 'session-stop',
                exitCode,
            });
            await Promise.allSettled([...pages.values()].map(async capture => (await capture)()));
            manifest.endedAt = new Date().toISOString();
            manifest.status = manifest.errors.length || exitCode !== 0 ? 'failed' : 'complete';
            persist();
            const events = readFileSync(actionsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown);
            writeFileSync(manifest.reviewPath, recordingReviewHtml(manifest, events));
            return manifest;
        })();
        return stopPromise;
    };
    try {
        event({
            kind: 'session-start',
            scope: manifest.scope,
        });
        const initialPages = await browser.pages();
        if (!initialPages.length) { throw new Error('No renderer page is available to record'); }
        await Promise.all(initialPages.map(async page => attach(page)));
        if (manifest.errors.length) { throw new Error(manifest.errors.join('\n')); }
        manifest.status = 'recording';
        persist();
    } catch (error) { fail(error); await stop(1); throw error; }
    return {
        manifest,
        stop,
        mark(label: string) { event({
            kind: 'mark',
            label: label.slice(0, 500),
        }); },
        async command<T>(command: string, args: unknown[], execute: () => Promise<T>): Promise<T> {
            if (command === 'ping') { return execute(); }
            const inspection = [
                'health',
                'console',
                'devtools',
                'recording',
            ].includes(command);
            const invoke = async () => {
                if ((stopping || manifest.status !== 'recording') && ![
                    'recording',
                    'health',
                    'console',
                    'screenshot',
                    'devtools',
                ].includes(command)) {
                    throw new Error(`Recording is ${manifest.status}; inspect ${manifestPath}`);
                }
                const id = randomUUID();
                // Code and typed strings can contain secrets. Record the command and argument sizes instead.
                const argumentsSummary = [
                    'eval',
                    'run',
                    'type',
                ].includes(command)
                    ? args.map(value => typeof value === 'string' ? {characters: value.length} : typeof value)
                    : args;
                const method = [
                    'click',
                    'type',
                ].includes(command) ? 'ui-input'
                    : [
                        'run',
                        'eval',
                    ].includes(command) ? 'direct-eval'
                        : command === 'openPdf' ? 'app-api' : 'inspection';
                event({
                    kind: 'command',
                    phase: 'start',
                    id,
                    command,
                    method,
                    args: argumentsSummary,
                });
                try {
                    const result = await execute();
                    event({
                        kind: 'command',
                        phase: 'end',
                        id,
                        command,
                    });
                    return result;
                } catch (error) {
                    event({
                        kind: 'command',
                        phase: 'failed',
                        id,
                        command,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    throw error;
                }
            };
            if (!inspection) { pendingActions++; }
            const action = inspection ? invoke() : queue.then(invoke).finally(() => { pendingActions--; });
            if (!inspection) { queue = action.then(() => {}, () => {}); }
            return action;
        },
    };
}

export type TSessionRecording = Awaited<ReturnType<typeof startSessionRecording>>;

/** Only call after proving that the owning controller has exited. Never upgrades interrupted footage to a pass. */
export async function recoverSessionRecording(path: string) {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as TSessionRecording['manifest'];
    const directory = join(path, '..');
    if (!manifest.endedAt) {
        manifest.status = 'failed';
        manifest.errors.push('Controller exited before finalization; recovered partial recording');
        manifest.endedAt = new Date().toISOString();
        for (const track of manifest.tracks) {
            try { track.video = await inspectRecordingVideo(join(directory, track.file)); }
            catch (error) { manifest.errors.push(String(error)); }
            if (track.status !== 'complete') { track.status = 'failed'; }
        }
        writeFileSync(path, JSON.stringify(manifest, null, 2));
    }
    const actions = readFileSync(join(directory, 'actions.jsonl'), 'utf8').split('\n').filter(Boolean)
        .flatMap(line => { try { return [JSON.parse(line) as unknown]; } catch { return []; } });
    writeFileSync(join(directory, 'index.html'), recordingReviewHtml(manifest, actions));
    return manifest;
}
