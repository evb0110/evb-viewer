export type TPageSnapAnchor = 'center' | 'top' | 'bottom';
export type TWheelDirection = -1 | 1;

export interface IWheelPageAccumulatorState {
    delta: number;
    direction: TWheelDirection | 0;
    lastEventTimeMs: number;
}
