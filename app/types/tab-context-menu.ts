import type { TGroupDirection } from '@app/types/editor-groups';

export type TDirectionalCommandAvailability = Record<TGroupDirection, boolean>;

export interface ITabContextAvailability {
    split: TDirectionalCommandAvailability;
    focus: TDirectionalCommandAvailability;
    move: TDirectionalCommandAvailability;
    copy: TDirectionalCommandAvailability;
    canClose: boolean;
    canCreate: boolean;
    canMoveToNewWindow: boolean;
}

export type TTabContextCommand =
    | { kind: 'new-tab' }
    | { kind: 'close-tab' }
    | { kind: 'move-to-new-window'; }
    | {
        kind: 'move-to-window';
        targetWindowId: number;
    }
    | {
        kind: 'split';
        direction: TGroupDirection 
    }
    | {
        kind: 'focus';
        direction: TGroupDirection 
    }
    | {
        kind: 'move';
        direction: TGroupDirection 
    }
    | {
        kind: 'copy';
        direction: TGroupDirection 
    };
