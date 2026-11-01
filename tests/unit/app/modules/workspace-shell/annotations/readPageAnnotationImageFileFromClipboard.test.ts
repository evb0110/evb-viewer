import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    readPageAnnotationImageFileFromClipboard,
    readPageAnnotationImageFileFromPasteData,
} from '@app/modules/workspace-shell/annotations/readPageAnnotationImageFileFromClipboard';

describe('readPageAnnotationImageFileFromClipboard', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('preserves the managed file handle attached by the desktop File constructor', async () => {
        const nativeFile = globalThis.File;
        const nativeSourceHandle = {leaseId: 'clipboard-lease'};
        vi.stubGlobal('File', new Proxy(nativeFile, {construct(target, args) {
            return Object.assign(Reflect.construct(target, args), {nativeSourceHandle});
        }}));
        vi.stubGlobal('navigator', {clipboard: {read: vi.fn(async () => [{
            types: ['image/jpeg'],
            getType: vi.fn(async () => new Blob([Uint8Array.of(1, 2, 3)], {type: 'image/jpeg'})),
        }])}});

        const file = await readPageAnnotationImageFileFromClipboard();

        expect(file).toMatchObject({
            name: 'clipboard-image.jpg',
            type: 'image/jpeg',
            nativeSourceHandle,
        });
    });

    it('takes a placeable image from paste data and ignores other files', () => {
        const svg = new File(['<svg/>'], 'drawing.svg', {type: 'image/svg+xml'});
        const png = new File([Uint8Array.of(1)], 'image.png', {type: 'image/png'});

        expect(readPageAnnotationImageFileFromPasteData({files: [
            svg,
            png,
        ]})).toBe(png);
        expect(readPageAnnotationImageFileFromPasteData({files: [svg]})).toBeNull();
        expect(readPageAnnotationImageFileFromPasteData(null)).toBeNull();
    });
});
