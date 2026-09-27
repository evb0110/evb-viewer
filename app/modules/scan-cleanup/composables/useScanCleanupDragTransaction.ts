import type {
    DeepReadonly,
    ShallowRef,
} from 'vue';

interface IScanCleanupDragPoint {
    x: number;
    y: number;
}

export interface IScanCleanupDragRect extends IScanCleanupDragPoint {
    width: number;
    height: number;
}

interface IScanCleanupDragSnapshot<TGeometry> {
    canonicalGeometry: DeepReadonly<TGeometry>;
    fitScale: number;
    pointerId: number;
    pointerStart: IScanCleanupDragPoint;
    stageRect: Readonly<IScanCleanupDragRect>;
}

interface IScanCleanupDragTransaction<TGeometry> {
    commit: (
        geometry: TGeometry,
        snapshot: IScanCleanupDragSnapshot<TGeometry>,
    ) => void;
    snapshot: IScanCleanupDragSnapshot<TGeometry>;
    target: HTMLElement;
    update: (
        event: PointerEvent,
        snapshot: IScanCleanupDragSnapshot<TGeometry>,
    ) => TGeometry;
}

interface IStartScanCleanupDragOptions<TGeometry> {
    canonicalGeometry: TGeometry;
    commit: IScanCleanupDragTransaction<TGeometry>['commit'];
    fitScale: number;
    stageRect: IScanCleanupDragRect;
    update: IScanCleanupDragTransaction<TGeometry>['update'];
}

export interface IScanCleanupDragTransactionController<TGeometry> {
    abort: (event: PointerEvent) => void;
    active: Readonly<ShallowRef<boolean>>;
    cancel: () => void;
    draftGeometry: Readonly<ShallowRef<TGeometry | null>>;
    finish: (event: PointerEvent) => void;
    lostPointerCapture: (event: PointerEvent) => void;
    move: (event: PointerEvent) => void;
    snapshot: Readonly<ShallowRef<IScanCleanupDragSnapshot<TGeometry> | null>>;
    start: (event: PointerEvent, options: IStartScanCleanupDragOptions<TGeometry>) => boolean;
}

function cloneGeometry<TGeometry>(geometry: TGeometry): TGeometry {
    return structuredClone(geometry);
}

function snapshotRect(rect: IScanCleanupDragRect): IScanCleanupDragRect {
    return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
    };
}

export const useScanCleanupDragTransaction = <TGeometry>(): IScanCleanupDragTransactionController<TGeometry> => {
    const transaction = shallowRef<IScanCleanupDragTransaction<TGeometry> | null>(null);
    const draftGeometry = shallowRef<TGeometry | null>(null);
    const snapshot = shallowRef<IScanCleanupDragSnapshot<TGeometry> | null>(null);
    const active = computed(() => transaction.value !== null);

    function handleWindowKeydown(event: KeyboardEvent) {
        if (event.key !== 'Escape' || !transaction.value) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        cancel();
    }

    function releasePointer(target: HTMLElement, pointerId: number) {
        if (
            typeof target.releasePointerCapture === 'function'
            && (
                typeof target.hasPointerCapture !== 'function'
                || target.hasPointerCapture(pointerId)
            )
        ) {
            target.releasePointerCapture(pointerId);
        }
    }

    function clear(releaseCapture: boolean) {
        const current = transaction.value;
        transaction.value = null;
        snapshot.value = null;
        draftGeometry.value = null;
        window.removeEventListener('keydown', handleWindowKeydown, true);
        if (current && releaseCapture) {
            releasePointer(current.target, current.snapshot.pointerId);
        }
    }

    function cancel() {
        if (!transaction.value) {
            return;
        }
        clear(true);
    }

    function start(event: PointerEvent, options: IStartScanCleanupDragOptions<TGeometry>) {
        if (event.button !== 0) {
            return false;
        }
        cancel();
        const target = event.currentTarget as HTMLElement;
        const canonicalGeometry = cloneGeometry(options.canonicalGeometry);
        const nextSnapshot: IScanCleanupDragSnapshot<TGeometry> = {
            canonicalGeometry: canonicalGeometry as DeepReadonly<TGeometry>,
            fitScale: options.fitScale,
            pointerId: event.pointerId,
            pointerStart: {
                x: event.clientX,
                y: event.clientY,
            },
            stageRect: snapshotRect(options.stageRect),
        };
        transaction.value = {
            commit: options.commit,
            snapshot: nextSnapshot,
            target,
            update: options.update,
        };
        snapshot.value = nextSnapshot;
        draftGeometry.value = canonicalGeometry;
        if (typeof target.setPointerCapture === 'function') {
            target.setPointerCapture(event.pointerId);
        }
        window.addEventListener('keydown', handleWindowKeydown, true);
        return true;
    }

    function move(event: PointerEvent) {
        const current = transaction.value;
        if (!current || current.snapshot.pointerId !== event.pointerId) {
            return;
        }
        draftGeometry.value = current.update(event, current.snapshot);
    }

    function finish(event: PointerEvent) {
        const current = transaction.value;
        if (!current || current.snapshot.pointerId !== event.pointerId) {
            return;
        }
        const geometry = current.update(event, current.snapshot);
        draftGeometry.value = geometry;
        const {commit} = current;
        const currentSnapshot = current.snapshot;
        clear(true);
        commit(geometry, currentSnapshot);
    }

    function abort(event: PointerEvent) {
        const current = transaction.value;
        if (!current || current.snapshot.pointerId !== event.pointerId) {
            return;
        }
        clear(true);
    }

    function lostPointerCapture(event: PointerEvent) {
        const current = transaction.value;
        if (!current || current.snapshot.pointerId !== event.pointerId) {
            return;
        }
        clear(false);
    }

    onBeforeUnmount(() => clear(true));

    return {
        abort,
        active,
        cancel,
        draftGeometry,
        finish,
        lostPointerCapture,
        move,
        snapshot,
        start,
    };
};
