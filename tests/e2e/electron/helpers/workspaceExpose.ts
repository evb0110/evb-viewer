import type { Page } from 'puppeteer-core';
import type {
    IEvbAutomationEvent,
    TEvbAutomationEventType,
} from '@app/types/evbAutomationEvents';
import type { IEvbTestApi } from '@app/types/evbTestApi';
import { isWorkspaceExposeSyncCommandName } from '@app/modules/workspace-shell/expose/workspaceExposeDescriptors';
import type {
    IWorkspaceExpose,
    IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import { delay } from 'es-toolkit/promise';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';

export type { IWorkspaceExpose };

export interface IFindWorkspaceExposeOptions {
    includeAllElements?: boolean;
    minVisibleSize?: number;
    preferActiveHost?: boolean;
    requiredMethods?: string[];
    requiredProperties?: string[];
    requireVisible?: boolean;
}

export interface IWorkspaceToolbarSnapshotRequirements {
    continuousScroll?: boolean;
    currentPage?: number;
    effectiveZoom?: number;
    hasPdf?: boolean;
    minEffectiveZoom?: number;
    minTotalPages?: number;
    showSidebar?: boolean;
    zoomMode?: IWorkspaceToolbarSnapshot['zoomMode'];
}

export interface IWaitForWorkspaceToolbarSnapshotOptions extends IFindWorkspaceExposeOptions {timeoutMs?: number;}

export interface IWorkspaceCommandResult<TResult = unknown> {
    called: boolean;
    value: TResult | null;
}

export interface IWorkspaceExposeProbeWindow {
    __evbCollectWorkspaceExposeDebug?: (options?: IFindWorkspaceExposeOptions) => IWorkspaceExposeDebugState;
    __evbFindWorkspaceExpose?: (options?: IFindWorkspaceExposeOptions) => IWorkspaceExpose | Record<string, unknown> | null;
    __evbTestApi?: IEvbTestApi;
}

export interface IWorkspaceExposeDebugState {
    annotationStates: unknown[];
    componentCount: number;
    componentSamples: Array<{
        exposedKeys: string[];
        setupKeys: string[];
        tag: string;
    }>;
    matchingComponentSamples: Array<{
        exposedKeys: string[];
        setupKeys: string[];
        tag: string;
    }>;
    toolbarSnapshots: unknown[];
}

function collectRequiredMethods(
    options: IFindWorkspaceExposeOptions | undefined,
    requiredMethod: string,
) {
    return Array.from(new Set([
        requiredMethod,
        ...(options?.requiredMethods ?? []),
    ]));
}

export async function installWorkspaceExposeProbe(page: Page) {
    await evaluateInPage(page, () => {
        const probeWindow = window as IWorkspaceExposeProbeWindow;
        if (probeWindow.__evbFindWorkspaceExpose && probeWindow.__evbCollectWorkspaceExposeDebug) {
            return;
        }

        const hasRequiredShape = (value: unknown, options: IFindWorkspaceExposeOptions) => {
            if (!value || typeof value !== 'object') {
                return false;
            }
            const record = value as Record<string, unknown>;
            return (options.requiredMethods ?? []).every(methodName => typeof record[methodName] === 'function')
                && (options.requiredProperties ?? []).every(propertyName => propertyName in record);
        };

        const collectStableSurfaces = (options: IFindWorkspaceExposeOptions) => {
            const api = probeWindow.__evbTestApi;
            if (!api) {
                return [];
            }

            const surfaces: unknown[] = [];
            const activeWorkspace = api.getActiveWorkspaceHandle();
            if (activeWorkspace) {
                surfaces.push(activeWorkspace);
            }

            const requestedProperties = options.requiredProperties ?? [];
            if (requestedProperties.length > 0) {
                surfaces.push(api.readActiveWorkspaceStateValues(requestedProperties));
            }

            surfaces.push(api.collectWorkspaceDebugState().activeWorkspaceState);
            return surfaces;
        };

        probeWindow.__evbFindWorkspaceExpose = (options: IFindWorkspaceExposeOptions = {}) => {
            const candidate = collectStableSurfaces(options)
                .find(surface => hasRequiredShape(surface, options));
            return candidate as IWorkspaceExpose | Record<string, unknown> | null ?? null;
        };

        probeWindow.__evbCollectWorkspaceExposeDebug = (options: IFindWorkspaceExposeOptions = {}) => {
            const debug = probeWindow.__evbTestApi?.collectWorkspaceDebugState();
            if (!debug) {
                return {
                    annotationStates: [],
                    componentCount: 0,
                    componentSamples: [],
                    matchingComponentSamples: [],
                    toolbarSnapshots: [],
                };
            }

            const annotationComments = debug.activeWorkspaceState.annotationComments;
            const annotationStates = [{
                annotationCommentsCount: Array.isArray(annotationComments)
                    ? annotationComments.length
                    : null,
                annotationEditorState: null,
            }];
            const componentSamples = debug.workspaces.slice(0, 8).map(workspace => ({
                exposedKeys: workspace.exposedKeys.slice(0, 12),
                setupKeys: workspace.automationStateKeys.slice(0, 12),
                tag: 'workspace-api',
            }));
            const activeMatch = probeWindow.__evbFindWorkspaceExpose?.(options);
            const matchingComponentSamples = activeMatch
                ? componentSamples.slice(0, 1)
                : [];

            return {
                annotationStates,
                componentCount: debug.workspaceCount,
                componentSamples,
                matchingComponentSamples,
                toolbarSnapshots: debug.workspaces
                    .map(workspace => workspace.toolbarSnapshot)
                    .filter(Boolean),
            };
        };
    });
}

export async function getWorkspaceToolbarSnapshot(
    page: Page,
    options: IFindWorkspaceExposeOptions = {},
) {
    await installWorkspaceExposeProbe(page);
    return evaluateInPage(page, (searchOptions: IFindWorkspaceExposeOptions): IWorkspaceToolbarSnapshot | null => {
        const apiSnapshot = (window as IWorkspaceExposeProbeWindow).__evbTestApi?.getActiveToolbarSnapshot() ?? null;
        if (apiSnapshot) {
            return apiSnapshot;
        }

        const workspace = (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.(searchOptions);
        return typeof workspace?.getToolbarSnapshot === 'function'
            ? workspace.getToolbarSnapshot()
            : null;
    }, {
        ...options,
        requiredMethods: collectRequiredMethods(options, 'getToolbarSnapshot'),
    });
}

export async function waitForWorkspaceToolbarSnapshot(
    page: Page,
    requirements: IWorkspaceToolbarSnapshotRequirements = {},
    options: IWaitForWorkspaceToolbarSnapshotOptions = {},
) {
    const {
        timeoutMs = 30_000,
        ...searchOptions
    } = options;

    await installWorkspaceExposeProbe(page);
    await page.waitForFunction((payload: {
        requirements: IWorkspaceToolbarSnapshotRequirements;
        searchOptions: IFindWorkspaceExposeOptions;
    }) => {
        const snapshot = (window as IWorkspaceExposeProbeWindow)
            .__evbTestApi
            ?.getActiveToolbarSnapshot()
            ?? (
                (window as IWorkspaceExposeProbeWindow)
                    .__evbFindWorkspaceExpose?.(payload.searchOptions) as IWorkspaceExpose | null | undefined
            )?.getToolbarSnapshot?.();
        if (!snapshot) {
            return false;
        }

        return (
            (typeof payload.requirements.hasPdf !== 'boolean' || snapshot.hasPdf === payload.requirements.hasPdf)
            && (typeof payload.requirements.showSidebar !== 'boolean' || snapshot.showSidebar === payload.requirements.showSidebar)
            && (typeof payload.requirements.currentPage !== 'number' || snapshot.currentPage === payload.requirements.currentPage)
            && (typeof payload.requirements.continuousScroll !== 'boolean' || snapshot.continuousScroll === payload.requirements.continuousScroll)
            && (typeof payload.requirements.minTotalPages !== 'number' || (snapshot.totalPages ?? 0) >= payload.requirements.minTotalPages)
            && (typeof payload.requirements.effectiveZoom !== 'number' || Math.abs((snapshot.effectiveZoom ?? Number.NaN) - payload.requirements.effectiveZoom) <= 0.001)
            && (typeof payload.requirements.minEffectiveZoom !== 'number' || (snapshot.effectiveZoom ?? 0) >= payload.requirements.minEffectiveZoom)
            && (payload.requirements.zoomMode === undefined || snapshot.zoomMode === payload.requirements.zoomMode)
        );
    }, { timeout: timeoutMs }, {
        requirements,
        searchOptions: {
            ...searchOptions,
            requiredMethods: collectRequiredMethods(searchOptions, 'getToolbarSnapshot'),
        },
    });

    const settleDeadline = Date.now() + Math.min(timeoutMs, 3_000);
    while (Date.now() < settleDeadline) {
        const snapshot = await getWorkspaceToolbarSnapshot(page, searchOptions);
        if (
            snapshot
            && (typeof requirements.hasPdf !== 'boolean' || snapshot.hasPdf === requirements.hasPdf)
            && (typeof requirements.showSidebar !== 'boolean' || snapshot.showSidebar === requirements.showSidebar)
            && (typeof requirements.currentPage !== 'number' || snapshot.currentPage === requirements.currentPage)
            && (typeof requirements.continuousScroll !== 'boolean' || snapshot.continuousScroll === requirements.continuousScroll)
            && (typeof requirements.minTotalPages !== 'number' || snapshot.totalPages >= requirements.minTotalPages)
            && (typeof requirements.effectiveZoom !== 'number' || Math.abs(snapshot.effectiveZoom - requirements.effectiveZoom) <= 0.001)
            && (typeof requirements.minEffectiveZoom !== 'number' || snapshot.effectiveZoom >= requirements.minEffectiveZoom)
            && (requirements.zoomMode === undefined || snapshot.zoomMode === requirements.zoomMode)
        ) {
            return snapshot;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Workspace toolbar snapshot disappeared after satisfying the requested state');
}

export async function waitForWorkspaceToolbarIdle(
    page: Page,
    options: IWaitForWorkspaceToolbarSnapshotOptions = {},
) {
    const {
        timeoutMs = 30_000,
        ...searchOptions
    } = options;

    await installWorkspaceExposeProbe(page);
    await waitForFunctionInPage(page, (payload: IFindWorkspaceExposeOptions) => {
        const snapshot = (window as IWorkspaceExposeProbeWindow)
            .__evbTestApi
            ?.getActiveToolbarSnapshot()
            ?? (
                (window as IWorkspaceExposeProbeWindow)
                    .__evbFindWorkspaceExpose?.(payload) as IWorkspaceExpose | null | undefined
            )?.getToolbarSnapshot?.();
        return snapshot
            ? !snapshot.isAnySaving && !snapshot.isSaving && !snapshot.isSavingAs
            : false;
    }, { timeout: timeoutMs }, {
        ...searchOptions,
        requiredMethods: collectRequiredMethods(searchOptions, 'getToolbarSnapshot'),
    });
}

export async function waitForSaveFrontierReady(
    page: Page,
    timeoutMs = 20_000,
) {
    const quietIntervalMs = 400;
    const pollIntervalMs = 50;
    const requiredStableObservations = 3;
    const startedAt = Date.now();
    let stableFingerprint: string | null = null;
    let stableSince = 0;
    let stableObservationCount = 0;

    await installWorkspaceExposeProbe(page);
    while (Date.now() - startedAt < timeoutMs) {
        const observation = await evaluateInPage(page, () => {
            const api = (window as IWorkspaceExposeProbeWindow).__evbTestApi;
            const workspace = api?.getActiveWorkspaceHandle() ?? null;
            const toolbar = api?.getActiveToolbarSnapshot()
                ?? workspace?.getToolbarSnapshot?.()
                ?? null;
            const ready = toolbar?.canSave === true
                && toolbar.isAnySaving !== true
                && toolbar.isSaving !== true
                && toolbar.isSavingAs !== true;
            if (!ready || !workspace) {
                return {
                    fingerprint: null,
                    ready: false,
                };
            }

            const editorState = Array.from(document.querySelectorAll<HTMLElement>(
                '.annotationEditorLayer .annotationEditor, .annotation-editor-layer .annotationEditor',
            )).map(editor => ({
                attributes: Array.from(editor.attributes)
                    .filter(attribute => attribute.name === 'id' || attribute.name.startsWith('data-'))
                    .map(attribute => [
                        attribute.name,
                        attribute.value,
                    ] as [string, string])
                    .sort(([left], [right]) => left.localeCompare(right)),
                text: editor.textContent ?? '',
            }));
            return {
                fingerprint: JSON.stringify({
                    automationState: workspace.getAutomationStateSnapshot(),
                    editorState,
                    shapes: workspace.getAllShapes?.() ?? [],
                }),
                ready: true,
            };
        });

        const now = Date.now();
        if (!observation.ready || observation.fingerprint === null) {
            stableFingerprint = null;
            stableSince = 0;
            stableObservationCount = 0;
        } else if (observation.fingerprint !== stableFingerprint) {
            stableFingerprint = observation.fingerprint;
            stableSince = now;
            stableObservationCount = 1;
        } else {
            stableObservationCount += 1;
            if (
                stableObservationCount >= requiredStableObservations
                && now - stableSince >= quietIntervalMs
            ) {
                return;
            }
        }

        await delay(pollIntervalMs);
    }
    throw new Error('Save frontier did not become ready after the document changed');
}

export async function waitForAutomationEvent(
    page: Page,
    type: TEvbAutomationEventType,
    options: {
        afterEventId?: number;
        path?: string;
        timeoutMs?: number;
    } = {},
): Promise<IEvbAutomationEvent | null> {
    const afterEventId = options.afterEventId ?? 0;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const normalizedPath = options.path?.replace(/\\/gu, '/').toLowerCase() ?? null;
    const deadline = Date.now() + timeoutMs;

    await installWorkspaceExposeProbe(page);
    while (Date.now() < deadline) {
        const result = await evaluateInPage(page, (payload: {
            afterEventId: number;
            normalizedPath: string | null;
            type: TEvbAutomationEventType;
        }) => {
            const api = (window as IWorkspaceExposeProbeWindow).__evbTestApi;
            if (!api?.getAutomationEvents) {
                return {
                    available: false,
                    event: null,
                };
            }

            const event = api.getAutomationEvents().find((candidate) => {
                if (candidate.type !== payload.type || candidate.id <= payload.afterEventId) {
                    return false;
                }
                if (!payload.normalizedPath) {
                    return true;
                }
                const path = typeof candidate.detail.path === 'string'
                    ? candidate.detail.path.replace(/\\/gu, '/').toLowerCase()
                    : '';
                return path === payload.normalizedPath;
            }) ?? null;
            return {
                available: true,
                event,
            };
        }, {
            afterEventId,
            normalizedPath,
            type,
        });
        if (!result.available) {
            return null;
        }
        if (result.event) {
            return result.event;
        }
        await delay(50);
    }
    throw new Error(`Timed out waiting for automation event '${type}' after ${String(timeoutMs)}ms`);
}

export async function getLatestAutomationEventId(page: Page) {
    await installWorkspaceExposeProbe(page);
    return evaluateInPage(page, () => {
        const events = (window as IWorkspaceExposeProbeWindow).__evbTestApi?.getAutomationEvents?.() ?? [];
        return events.at(-1)?.id ?? 0;
    });
}

export async function callWorkspaceCommand<TResult = unknown>(
    page: Page,
    commandName: string,
    args: unknown[] = [],
    options: IFindWorkspaceExposeOptions = {},
): Promise<IWorkspaceCommandResult<TResult>> {
    await installWorkspaceExposeProbe(page);
    return page.evaluate((payload: {
        args: unknown[];
        commandName: string;
        searchOptions: IFindWorkspaceExposeOptions;
        syncCommand: boolean;
    }): IWorkspaceCommandResult<TResult> | Promise<IWorkspaceCommandResult<TResult>> => {
        const api = (window as IWorkspaceExposeProbeWindow).__evbTestApi;
        if (api) {
            if (payload.syncCommand) {
                return api.callActiveWorkspaceSyncCommand<TResult>(payload.commandName, payload.args);
            }
            return api.callActiveWorkspaceCommand<TResult>(payload.commandName, payload.args);
        }

        const workspace = (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.(payload.searchOptions) as Record<string, unknown> | null | undefined;
        const command = workspace?.[payload.commandName];
        if (typeof command !== 'function') {
            return {
                called: false,
                value: null,
            };
        }

        const value = (command as (...values: unknown[]) => unknown)(...payload.args);
        if (payload.syncCommand) {
            return {
                called: true,
                value: (value ?? null) as TResult | null,
            };
        }
        return Promise.resolve(value).then(resolvedValue => ({
            called: true,
            value: (resolvedValue ?? null) as TResult | null,
        }));
    }, {
        args,
        commandName,
        searchOptions: {
            ...options,
            requiredMethods: collectRequiredMethods(options, commandName),
        },
        syncCommand: isWorkspaceExposeSyncCommandName(commandName),
    });
}

export async function readWorkspaceStateValues<TValues extends Record<string, unknown> = Record<string, unknown>>(
    page: Page,
    propertyNames: string[],
    options: IFindWorkspaceExposeOptions = {},
) {
    await installWorkspaceExposeProbe(page);
    return evaluateInPage(page, (payload: {
        propertyNames: string[];
        searchOptions: IFindWorkspaceExposeOptions;
    }) => {
        const api = (window as IWorkspaceExposeProbeWindow).__evbTestApi;
        if (api) {
            return api.readActiveWorkspaceStateValues<TValues>(payload.propertyNames);
        }

        const workspace = (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.(payload.searchOptions) as Record<string, unknown> | null | undefined;
        const values: Record<string, unknown> = {};
        for (const propertyName of payload.propertyNames) {
            values[propertyName] = workspace?.[propertyName];
        }
        return values as TValues;
    }, {
        propertyNames,
        searchOptions: {
            ...options,
            requiredProperties: options.requiredProperties ?? propertyNames,
        },
    });
}

export async function collectWorkspaceExposeDebugState(
    page: Page,
    options: IFindWorkspaceExposeOptions = {},
) {
    await installWorkspaceExposeProbe(page);
    return page.evaluate((searchOptions: IFindWorkspaceExposeOptions) => (
        (window as IWorkspaceExposeProbeWindow).__evbCollectWorkspaceExposeDebug?.(searchOptions) ?? {
            annotationStates: [],
            componentCount: 0,
            componentSamples: [],
            matchingComponentSamples: [],
            toolbarSnapshots: [],
        }
    ), options);
}
