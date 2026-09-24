import {
    ALL_WORKSPACE_VIEWER_CHUNK_TARGETS,
    DJVU_WORKSPACE_VIEWER_CHUNK_TARGETS,
    PDF_WORKSPACE_VIEWER_CHUNK_TARGETS,
    type TWorkspaceViewerChunkLoader,
    type TWorkspaceViewerChunkLoaders,
    type TWorkspaceViewerChunkTarget,
    workspaceViewerChunkLoaders,
} from '@app/modules/workspace-shell/viewers/workspaceViewerChunkLoaders';
import {
    scheduleIdleWork,
    type TCancelIdleWork,
} from '@app/utils/scheduleIdleWork';
import type { TDesktopViewerWarmupStrategy } from '@app/utils/startupWorkProfile';

export interface IDesktopViewerChunkWarmupOptions {
    isDesktopRuntime: boolean;
    loaderOverrides?: Partial<Record<TWorkspaceViewerChunkTarget, TWorkspaceViewerChunkLoader>>;
}

export interface IPrioritizedViewerChunkWarmupOptions {
    isDesktopRuntime: boolean;
    paths: readonly string[];
    loaderOverrides?: Partial<Record<TWorkspaceViewerChunkTarget, TWorkspaceViewerChunkLoader>>;
}

export interface IScheduleDesktopViewerWarmupOptions
    extends IDesktopViewerChunkWarmupOptions {
    strategy: TDesktopViewerWarmupStrategy;
    scheduleIdle?: typeof scheduleIdleWork;
}

export interface IDesktopViewerWarmupHandle {
    completion: Promise<void>;
    cancel: TCancelIdleWork;
}

function resolveViewerChunkLoaders(
    overrides: Partial<Record<TWorkspaceViewerChunkTarget, TWorkspaceViewerChunkLoader>> = {},
): TWorkspaceViewerChunkLoaders {
    return {
        ...workspaceViewerChunkLoaders,
        ...overrides,
    };
}

function loadViewerChunkTargets(
    targets: readonly TWorkspaceViewerChunkTarget[],
    overrides?: Partial<Record<TWorkspaceViewerChunkTarget, TWorkspaceViewerChunkLoader>>,
) {
    const loaders = resolveViewerChunkLoaders(overrides);
    return Promise.all(targets.map(target => loaders[target]()));
}

interface IViewerChunkTargetWarmupOptions {
    targets: readonly TWorkspaceViewerChunkTarget[];
    loaderOverrides?: Partial<Record<TWorkspaceViewerChunkTarget, TWorkspaceViewerChunkLoader>>;
}

function warmupDesktopViewerChunkTargets(options: IViewerChunkTargetWarmupOptions) {
    return loadViewerChunkTargets(options.targets, options.loaderOverrides);
}

export function getWorkspaceViewerChunkTargetsForPaths(
    paths: readonly string[],
): TWorkspaceViewerChunkTarget[] {
    const requiredTargets = new Set<TWorkspaceViewerChunkTarget>();
    for (const path of paths) {
        const normalizedPath = path.toLowerCase().split(/[?#]/u, 1)[0] ?? '';
        const targets = normalizedPath.endsWith('.djvu') || normalizedPath.endsWith('.djv')
            ? DJVU_WORKSPACE_VIEWER_CHUNK_TARGETS
            : normalizedPath.endsWith('.pdf') ? PDF_WORKSPACE_VIEWER_CHUNK_TARGETS : [];
        for (const target of targets) {
            requiredTargets.add(target);
        }
    }
    return ALL_WORKSPACE_VIEWER_CHUNK_TARGETS.filter(target => requiredTargets.has(target));
}

/** Loads only the viewer engine required by paths already handed to this renderer. */
export function warmupDesktopViewerChunkForPaths(options: IPrioritizedViewerChunkWarmupOptions) {
    if (!options.isDesktopRuntime || options.paths.length === 0) {
        return null;
    }

    const targets = getWorkspaceViewerChunkTargetsForPaths(options.paths);
    return targets.length > 0 ? loadViewerChunkTargets(targets, options.loaderOverrides) : null;
}

/**
 * Warms the complete document-viewer stack (chassis, PDF.js, native PDF, and DjVu page source) after
 * desktop startup, so opening a document never waits on a local chunk fetch/parse.
 *
 * This is one mechanism of the app-wide code-splitting policy — "reserve statically,
 * fill asynchronously":
 *
 * - Layout-reserving UI (banners, skeletons, status surfaces, transition shells) must be
 *   statically imported so it exists on the first frame. Use granular
 *   `public/component-exports/*` entry points to pull a single component without dragging
 *   its whole feature module into the eager bundle.
 * - Heavy document engines and user-initiated tools (viewers, OCR, print, pdf-lib) stay
 *   behind `defineAsyncComponent`/dynamic `import()` so neither web visitors nor desktop
 *   cold start pay their parse cost up front. The same renderer build ships to the web
 *   (Vercel) and to Electron, so async boundaries must stay valid for both targets.
 * - On desktop, pending external-open paths first warm only their matching engine. This
 *   all-engine helper is reserved for background warmup after that startup claim.
 *
 * Web stays cold on purpose: prefetching both viewer engines would spend bandwidth on
 * visitors who may never open that document type.
 */
export function warmupDesktopViewerChunks(options: IDesktopViewerChunkWarmupOptions) {
    if (!options.isDesktopRuntime) {
        return null;
    }

    return loadViewerChunkTargets(ALL_WORKSPACE_VIEWER_CHUNK_TARGETS, options.loaderOverrides);
}

export function scheduleDesktopViewerWarmup(
    options: IScheduleDesktopViewerWarmupOptions,
): IDesktopViewerWarmupHandle | null {
    if (!options.isDesktopRuntime || options.strategy === 'skip') {
        return null;
    }

    const scheduleIdle = options.scheduleIdle ?? scheduleIdleWork;
    let cancelScheduled: TCancelIdleWork = () => {};
    const lifecycle: { cancelled: boolean } = {cancelled: false};
    let stageRunning = false;
    let settled = false;
    let resolveCompletion: () => void = () => {};
    let rejectCompletion: (error: unknown) => void = () => {};
    const completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
    });

    function resolveOnce() {
        if (settled) {
            return;
        }
        settled = true;
        resolveCompletion();
    }

    function rejectOnce(error: unknown) {
        if (settled) {
            return;
        }
        settled = true;
        rejectCompletion(error);
    }

    function scheduleStagedTarget(index: number) {
        if (lifecycle.cancelled || index >= ALL_WORKSPACE_VIEWER_CHUNK_TARGETS.length) {
            resolveOnce();
            return;
        }

        cancelScheduled = scheduleIdle(async () => {
            if (lifecycle.cancelled) {
                resolveOnce();
                return;
            }
            stageRunning = true;
            const target = ALL_WORKSPACE_VIEWER_CHUNK_TARGETS[index];
            try {
                if (target) {
                    await warmupDesktopViewerChunkTargets({
                        targets: [target],
                        ...(options.loaderOverrides ? {loaderOverrides: options.loaderOverrides} : {}),
                    });
                }
                stageRunning = false;
                if (lifecycle.cancelled.valueOf()) {
                    resolveOnce();
                    return;
                }
                scheduleStagedTarget(index + 1);
            } catch (error) {
                stageRunning = false;
                rejectOnce(error);
            }
        });
    }

    if (options.strategy === 'eager') {
        cancelScheduled = scheduleIdle(async () => {
            if (lifecycle.cancelled) {
                resolveOnce();
                return;
            }
            stageRunning = true;
            try {
                await warmupDesktopViewerChunks(options);
                stageRunning = false;
                resolveOnce();
            } catch (error) {
                stageRunning = false;
                rejectOnce(error);
            }
        });
    } else {
        scheduleStagedTarget(0);
    }

    return {
        completion,
        cancel: () => {
            if (settled || lifecycle.cancelled) {
                return;
            }
            lifecycle.cancelled = true;
            cancelScheduled();
            if (!stageRunning) {
                resolveOnce();
            }
        },
    };
}
