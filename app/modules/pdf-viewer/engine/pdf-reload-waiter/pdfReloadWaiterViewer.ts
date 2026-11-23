/**
 * How a view's admitted reload ended: its reading point was placed, the
 * reader or a newer command or document took the view first, or the
 * operation withdrew it because it did not reload after all.
 */
export type TPdfReloadOutcome = 'placed' | 'superseded' | 'withdrawn';

/** A reload a view was told about before it began: the receipt of its placement. */
export interface IPdfReloadAdmission {
    /** Settles once, when the view's reload has placed its reading point or no longer will. */
    readonly finished: Promise<TPdfReloadOutcome>;
    /** The operation does not reload: nothing is left to place. */
    withdraw: () => void;
}

export interface IPdfReloadWaiterViewer {
    /**
     * Admits the next reload of this view: it keeps the reading point the
     * view shows when the reload begins, on the page `mapPage` moves it to.
     */
    admitReload?: (mapPage: (page: number) => number) => IPdfReloadAdmission;
}
