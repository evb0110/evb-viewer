import type { ICropMargins } from '@contracts/shared';
import type { IWorkerTaskErrorFrame } from '@electron/utils/workerTask';
import { isRecord } from '@contracts/runtimeGuards';

export type TCropWorkerInput =
    | {
        type: 'crop';
        workingCopyPath: string;
        pages: number[];
        margins: ICropMargins;
        senderWebContentsId?: number;
    }
    | {
        type: 'removeCrop';
        workingCopyPath: string;
        pages: number[];
        senderWebContentsId?: number;
    };

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function decodePageNumbers(value: unknown) {
    return Array.isArray(value) && value.every(isPositiveSafeInteger)
        ? [...value]
        : null;
}

function decodeCropMargins(value: unknown): ICropMargins | null {
    if (!isRecord(value)) {
        return null;
    }
    const {
        top,
        bottom,
        left,
        right,
    } = value;
    if (
        typeof top !== 'number'
        || !Number.isFinite(top)
        || top < 0
        || typeof bottom !== 'number'
        || !Number.isFinite(bottom)
        || bottom < 0
        || typeof left !== 'number'
        || !Number.isFinite(left)
        || left < 0
        || typeof right !== 'number'
        || !Number.isFinite(right)
        || right < 0
    ) {
        return null;
    }
    return {
        top,
        bottom,
        left,
        right,
    };
}

function decodeSenderWebContentsId(value: unknown) {
    if (value === undefined) {
        return undefined;
    }
    return isPositiveSafeInteger(value) ? value : null;
}

export function decodeCropWorkerInput(value: unknown): TCropWorkerInput | null {
    if (!isRecord(value) || typeof value.workingCopyPath !== 'string' || value.workingCopyPath.length === 0) {
        return null;
    }
    const senderWebContentsId = decodeSenderWebContentsId(value.senderWebContentsId);
    if (senderWebContentsId === null) {
        return null;
    }

    const pages = decodePageNumbers(value.pages);
    if (pages === null) {
        return null;
    }
    if (value.type === 'removeCrop') {
        return {
            type: 'removeCrop',
            workingCopyPath: value.workingCopyPath,
            pages,
            ...(senderWebContentsId === undefined ? {} : {senderWebContentsId}),
        };
    }
    if (value.type !== 'crop') {
        return null;
    }
    const margins = decodeCropMargins(value.margins);
    return margins
        ? {
            type: 'crop',
            workingCopyPath: value.workingCopyPath,
            pages,
            margins,
            ...(senderWebContentsId === undefined ? {} : {senderWebContentsId}),
        }
        : null;
}

export interface ICropWorkerCancelMessage {type: 'cancel';}

export function decodeCropWorkerControlMessage(value: unknown): ICropWorkerCancelMessage | null {
    return isRecord(value) && value.type === 'cancel'
        ? {type: 'cancel'}
        : null;
}

export type TCropWorkerResult =
    | {
        type: 'result';
        ok: true;
    }
    | {
        type: 'result';
        ok: false;
        error: string;
        errorFrame?: IWorkerTaskErrorFrame;
    };
