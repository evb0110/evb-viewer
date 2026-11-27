import {describe, expect, it} from 'vitest';
import {buildPdfCommittedOpenPageShellStyle} from '@app/modules/pdf-viewer/engine/pdf-initial-surface-placeholder/buildPdfCommittedOpenPageShellStyle';

describe('buildPdfCommittedOpenPageShellStyle', () => {
    it('keeps a cold open on committed empty pixels instead of fabricating paper geometry', () => {
        expect(buildPdfCommittedOpenPageShellStyle({pageStyle: null})).toBeNull();
        expect(
            buildPdfCommittedOpenPageShellStyle({
                pageStyle: {
                    width: 'calc(100% - 2.5rem)',
                    height: '1224.51px',
                },
            }),
        ).toBeNull();
    });

    it('preserves the canonical fitted pixel geometry without subtracting viewport padding twice', () => {
        const style = buildPdfCommittedOpenPageShellStyle({
            pageStyle: {
                width: '900px',
                height: '1440px',
            },
        });

        expect(style).toEqual({
            width: '900px',
            height: '1440px',
        });
        expect(style).not.toHaveProperty('maxWidth');
        expect(style?.width).not.toContain('calc(');
    });

    it('preserves restored custom zoom geometry without fit-width substitution', () => {
        expect(
            buildPdfCommittedOpenPageShellStyle({
                pageStyle: {
                    width: '2137.5px',
                    height: '3420px',
                },
            }),
        ).toEqual({
            width: '2137.5px',
            height: '3420px',
        });
    });
});
