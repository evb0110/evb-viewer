declare module 'utif' {
    export interface IUtifFrame {
        width?: number;
        height?: number;
        [key: string]: unknown;
    }

    export function decode(input: Uint8Array | ArrayBuffer): IUtifFrame[];
    export function decodeImage(
        input: Uint8Array | ArrayBuffer,
        frame: IUtifFrame,
    ): void;
    export function toRGBA8(frame: IUtifFrame): Uint8Array;
}
