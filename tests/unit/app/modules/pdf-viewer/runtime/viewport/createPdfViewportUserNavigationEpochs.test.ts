import {
    describe,
    expect,
    it,
} from 'vitest';
import { createPdfViewportUserNavigationEpochs } from '@app/modules/pdf-viewer/runtime/viewport/createPdfViewportUserNavigationEpochs';

describe('createPdfViewportUserNavigationEpochs', () => {
    it('treats an ordinary scroll as physical navigation', () => {
        const epochs = createPdfViewportUserNavigationEpochs();

        const isPhysicalNavigation = epochs.markScrollInteraction({
            top: 500,
            maxTop: 4000,
        });

        expect(isPhysicalNavigation).toBe(true);
        expect(epochs.userViewportInteractionEpoch.value).toBe(1);
    });

    it('attributes a strict clamp of an authored offset to the viewer', () => {
        const epochs = createPdfViewportUserNavigationEpochs();
        // A navigation wrote page 4 while earlier pages kept their painted
        // scale; releasing them shortens the document under that offset.
        epochs.observeAuthoredScrollOffset(3341);

        expect(epochs.markScrollInteraction({
            top: 2533,
            maxTop: 2533,
        })).toBe(false);

        // Reaching the end by the user's own scroll is not a clamp.
        expect(epochs.markScrollInteraction({
            top: 2533,
            maxTop: 2533,
        })).toBe(true);
        expect(epochs.markScrollInteraction({
            top: 2400,
            maxTop: 2533,
        })).toBe(true);
    });
});
