import type { TPaneDirection } from '@contracts/editorPanes';

export type TDirectionalCommandAvailability = Record<TPaneDirection, boolean>;

export interface ITabContextAvailability {
    split: TDirectionalCommandAvailability;
    splitEmpty: TDirectionalCommandAvailability;
    move: TDirectionalCommandAvailability;
    canClose: boolean;
    canCreate: boolean;
    canMoveToNewWindow: boolean;
    canMoveToWindow: boolean;
}

export type TTabContextCommand =
    | { kind: 'new-tab' }
    | { kind: 'close-tab' }
    | { kind: 'close-others' }
    | { kind: 'close-right' }
    | { kind: 'reveal-in-folder' }
    | { kind: 'copy-path' }
    | { kind: 'move-to-new-window'; }
    | {
        kind: 'move-to-window';
        targetWindowId: number;
    }
    | {
        kind: 'split';
        direction: TPaneDirection
    }
    | {
        kind: 'split-empty';
        direction: TPaneDirection
    };

export type TDirectionalTabContextCommand = Extract<TTabContextCommand, { direction: TPaneDirection }>;
