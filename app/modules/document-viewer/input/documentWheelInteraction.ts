import { ZOOM } from '@app/constants/pdfLayout';
import { isMacClientPlatform } from '@app/utils/clientPlatform';
import { clampDocumentManualZoom } from '@app/modules/document-viewer/zoomPolicy';
import type {
    TPdfZoomState,
    TZoomMode,
} from '@contracts/shared';

const DOCUMENT_WHEEL_ZOOM_SENSITIVITY = 0.0016;
export const DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS = 180;
const WHEEL_LINE_DELTA_PX = 16;
const WHEEL_DELTA_LINE_MODE = 1;
const WHEEL_DELTA_PAGE_MODE = 2;

export type TDocumentWheelIntent = 'scroll' | 'platform-scroll' | 'zoom';

const DOCUMENT_WHEEL_ZOOM_MODIFIER_KEYS = new Set([
    'Alt',
    'AltGraph',
    'Control',
    'Meta',
    'Shift',
]);

export function isDocumentWheelZoomSessionBoundaryKey(
    event: Pick<KeyboardEvent, 'key' | 'repeat'>,
) {
    return !event.repeat && !DOCUMENT_WHEEL_ZOOM_MODIFIER_KEYS.has(event.key);
}

export function shouldResetDocumentWheelZoomSession(
    isInteractionActive: boolean,
    event?: Pick<Event, 'type'> & Partial<Pick<KeyboardEvent, 'key' | 'repeat'>>,
) {
    if (!isInteractionActive) {
        return false;
    }
    return event?.type !== 'keydown' || isDocumentWheelZoomSessionBoundaryKey({
        key: event.key ?? '',
        repeat: event.repeat === true,
    });
}

/**
 * The renderer-facing subset of the physical wheel event. Modifier keys and
 * deltaZ deliberately stay behind the shared intent resolver so consumers
 * cannot reclassify the gesture and recreate presentation-policy drift.
 */
export interface IDocumentWheelSourceEvent {
    readonly cancelable: boolean;
    readonly clientX: number;
    readonly clientY: number;
    readonly defaultPrevented: boolean;
    readonly deltaX: number;
    readonly deltaY: number;
    readonly timeStamp: number;
    preventDefault(): void;
}

export interface IDocumentWheelInteraction {
    readonly deltaPx: number;
    readonly event: IDocumentWheelSourceEvent;
    readonly intent: TDocumentWheelIntent;
}

interface IDocumentWheelZoomTarget {
    clamped: boolean;
    cumulativeDelta: number;
    nextEffectiveZoom: number;
    nextZoom: number;
    valid: true;
    zoomFactor: number;
}

interface IDocumentWheelZoomInvalidTarget {
    cumulativeDelta: number;
    reason?: 'below-manual-min-zoom-out';
    valid: false;
    zoomFactor: number;
}

interface IDocumentWheelZoomSink {
    effectiveZoom: number;
    emitZoom: (value: number) => void;
    emitZoomMode: (mode: TZoomMode) => void;
    zoomMode: TZoomMode;
}

interface IReadonlyValue<TValue> {readonly value: TValue;}

type IDocumentWheelZoomEmit = (event: 'update:zoomState', value: TPdfZoomState) => void;

interface IDocumentWheelZoomHandlerOptions {beforeZoom?: (interaction: IDocumentWheelInteraction, packetAt: number, startsNewSession: boolean) => void;}

interface IDocumentWheelZoomAccumulator {
    cumulativeDelta: number;
    startZoom: number;
}

interface IDocumentWheelZoomConsumeOptions extends IDocumentWheelZoomHandlerOptions {accumulator?: IDocumentWheelZoomAccumulator;}

function normalizeWheelDelta(value: number, deltaMode: number, viewport: HTMLElement) {
    if (deltaMode === WHEEL_DELTA_LINE_MODE) {
        return value * WHEEL_LINE_DELTA_PX;
    }
    if (deltaMode === WHEEL_DELTA_PAGE_MODE) {
        return value * Math.max(viewport.clientHeight, 1);
    }
    return value;
}

function resolveWheelDeltaPx(event: WheelEvent, viewport: HTMLElement) {
    const primaryDelta = normalizeWheelDelta(event.deltaY, event.deltaMode, viewport);
    if (Math.abs(primaryDelta) >= Number.EPSILON || Math.abs(event.deltaZ) <= Number.EPSILON) {
        return primaryDelta;
    }
    return normalizeWheelDelta(event.deltaZ, event.deltaMode, viewport);
}

export function resolveDocumentWheelIntent(event: WheelEvent, isMac = isMacClientPlatform()): TDocumentWheelIntent {
    if (isMac && event.ctrlKey && !event.metaKey) {
        return 'platform-scroll';
    }
    if (event.ctrlKey || event.metaKey || Math.abs(event.deltaZ) > Number.EPSILON) {
        return 'zoom';
    }
    return 'scroll';
}

export function resolveDocumentWheelInteraction(
    event: WheelEvent,
    viewport: HTMLElement,
    isMac = isMacClientPlatform(),
): IDocumentWheelInteraction {
    return {
        deltaPx: resolveWheelDeltaPx(event, viewport),
        event,
        intent: resolveDocumentWheelIntent(event, isMac),
    };
}

function resolveDocumentWheelCumulativeDelta(startZoom: number, targetZoom: number) {
    if (
        !Number.isFinite(startZoom)
        || startZoom <= 0
        || !Number.isFinite(targetZoom)
        || targetZoom <= 0
    ) {
        return null;
    }

    return -Math.log(targetZoom / startZoom) / DOCUMENT_WHEEL_ZOOM_SENSITIVITY;
}

export function resolveDocumentWheelZoomTarget(
    startZoom: number,
    cumulativeDelta: number,
    deltaPx: number,
    limits: {
        maximumZoom?: number;
        minimumZoom?: number;
    } = {},
): IDocumentWheelZoomTarget | IDocumentWheelZoomInvalidTarget {
    const minimumZoom = limits.minimumZoom ?? ZOOM.MIN;
    const maximumZoom = limits.maximumZoom ?? ZOOM.MAX;
    let nextCumulativeDelta = cumulativeDelta + deltaPx;
    let zoomFactor = Math.exp(-nextCumulativeDelta * DOCUMENT_WHEEL_ZOOM_SENSITIVITY);
    if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
        return {
            cumulativeDelta: nextCumulativeDelta,
            valid: false,
            zoomFactor,
        };
    }

    const rawNextEffectiveZoom = startZoom * zoomFactor;
    if (startZoom < minimumZoom && rawNextEffectiveZoom <= startZoom) {
        return {
            cumulativeDelta: 0,
            reason: 'below-manual-min-zoom-out',
            valid: false,
            zoomFactor: 1,
        };
    }

    const nextEffectiveZoom = limits.minimumZoom === undefined && limits.maximumZoom === undefined
        ? clampDocumentManualZoom(rawNextEffectiveZoom)
        : Math.min(maximumZoom, Math.max(minimumZoom, rawNextEffectiveZoom));
    const clamped = Math.abs(rawNextEffectiveZoom - nextEffectiveZoom) > Number.EPSILON;
    if (Math.abs(rawNextEffectiveZoom - nextEffectiveZoom) >= 0.001) {
        const clampedCumulativeDelta = resolveDocumentWheelCumulativeDelta(startZoom, nextEffectiveZoom);
        if (clampedCumulativeDelta !== null) {
            nextCumulativeDelta = clampedCumulativeDelta;
            zoomFactor = nextEffectiveZoom / startZoom;
        }
    }

    return {
        clamped,
        cumulativeDelta: nextCumulativeDelta,
        nextEffectiveZoom,
        nextZoom: nextEffectiveZoom,
        valid: true,
        zoomFactor,
    };
}

export function consumeDocumentWheelZoomInteraction(
    interaction: IDocumentWheelInteraction,
    sink: IDocumentWheelZoomSink,
    options: IDocumentWheelZoomConsumeOptions & {
        packetAt?: number;
        startsNewSession?: boolean;
    } = {},
) {
    if (interaction.intent !== 'zoom') {
        return false;
    }

    interaction.event.preventDefault();
    const target = resolveDocumentWheelZoomTarget(
        options.accumulator?.startZoom ?? sink.effectiveZoom,
        options.accumulator?.cumulativeDelta ?? 0,
        interaction.deltaPx,
    );
    if (options.accumulator) {
        options.accumulator.cumulativeDelta = target.cumulativeDelta;
    }
    if (!target.valid) {
        return true;
    }
    if (Math.abs(target.nextEffectiveZoom - sink.effectiveZoom) < 0.001) {
        if (!target.clamped && Math.abs(target.cumulativeDelta) > Number.EPSILON) {
            options.beforeZoom?.(
                interaction,
                options.packetAt ?? performance.now(),
                options.startsNewSession ?? true,
            );
        }
        return true;
    }
    options.beforeZoom?.(
        interaction,
        options.packetAt ?? performance.now(),
        options.startsNewSession ?? true,
    );
    if (sink.zoomMode !== 'custom') {
        sink.emitZoomMode('custom');
    }
    sink.emitZoom(target.nextZoom);
    return true;
}

export function createDocumentWheelZoomHandler(
    effectiveZoom: IReadonlyValue<number>,
    zoomMode: IReadonlyValue<TZoomMode>,
    emit: IDocumentWheelZoomEmit,
    options: IDocumentWheelZoomHandlerOptions & {
        readSessionKey?: () => unknown;
        onNonZoom?: () => void;
    } = {},
) {
    let session: (IDocumentWheelZoomAccumulator & {
        effectiveZoom: number;
        lastObservedEffectiveZoom: number;
        lastObservedZoomMode: TZoomMode;
        lastPacketAt: number;
        pendingEffectiveZooms: number[];
        pendingZoomModes: TZoomMode[];
        sessionKey: unknown;
    }) | null = null;
    const reset = () => {
        session = null;
    };
    const handleInteraction = (interaction: IDocumentWheelInteraction) => {
        if (interaction.intent !== 'zoom') {
            reset();
            options.onNonZoom?.();
            return false;
        }
        const packetAt = performance.now();
        let activeSession = session;
        if (activeSession !== null && activeSession.sessionKey !== options.readSessionKey?.()) {
            activeSession = null;
        }
        if (activeSession !== null) {
            const observedZoom = effectiveZoom.value;
            if (Math.abs(observedZoom - activeSession.lastObservedEffectiveZoom) >= 0.001) {
                const acknowledgedIndex = activeSession.pendingEffectiveZooms.findLastIndex(
                    value => Math.abs(value - observedZoom) < 0.001,
                );
                if (acknowledgedIndex < 0) {
                    activeSession = null;
                } else {
                    activeSession.lastObservedEffectiveZoom = observedZoom;
                    activeSession.pendingEffectiveZooms.splice(0, acknowledgedIndex + 1);
                }
            }
        }
        if (activeSession !== null && zoomMode.value !== activeSession.lastObservedZoomMode) {
            const acknowledgedIndex = activeSession.pendingZoomModes.lastIndexOf(zoomMode.value);
            if (acknowledgedIndex < 0) {
                activeSession = null;
            } else {
                activeSession.lastObservedZoomMode = zoomMode.value;
                activeSession.pendingZoomModes.splice(0, acknowledgedIndex + 1);
            }
        }
        let startsNewSession = false;
        if (
            activeSession === null
            || packetAt < activeSession.lastPacketAt
            || packetAt - activeSession.lastPacketAt >= DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS
        ) {
            startsNewSession = true;
            activeSession = {
                cumulativeDelta: 0,
                effectiveZoom: effectiveZoom.value,
                lastObservedEffectiveZoom: effectiveZoom.value,
                lastObservedZoomMode: zoomMode.value,
                lastPacketAt: packetAt,
                pendingEffectiveZooms: [],
                pendingZoomModes: [],
                sessionKey: options.readSessionKey?.(),
                startZoom: effectiveZoom.value,
            };
            session = activeSession;
        }
        activeSession.lastPacketAt = packetAt;
        return consumeDocumentWheelZoomInteraction(interaction, {
            effectiveZoom: activeSession.effectiveZoom,
            zoomMode: zoomMode.value,
            // A wheel zoom always leaves fit mode, so the mode switch and the
            // scale reach the host as one custom zoom state.
            emitZoomMode: (mode) => {
                activeSession.pendingZoomModes.push(mode);
            },
            emitZoom: (value) => {
                activeSession.effectiveZoom = value;
                activeSession.pendingEffectiveZooms.push(value);
                emit('update:zoomState', {
                    kind: 'custom',
                    scale: value,
                });
            },
        }, {
            accumulator: activeSession,
            packetAt,
            startsNewSession,
            ...(options.beforeZoom ? {beforeZoom: options.beforeZoom} : {}),
        });
    };
    return Object.assign(handleInteraction, {reset});
}
