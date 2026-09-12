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
        expect(epochs.userPhysicalNavigationEpoch.value).toBe(1);
    });

    it('attributes scroll emitted by a geometry replacement to the viewer, not the user', () => {
        const epochs = createPdfViewportUserNavigationEpochs();
        const endReplacement = epochs.beginLayoutGeometryReplacement();

        expect(epochs.markScrollInteraction({
            top: 500,
            maxTop: 4000,
        })).toBe(false);
        expect(epochs.markScrollInteraction({
            top: 500,
            maxTop: 4000,
        })).toBe(false);

        expect(epochs.userViewportInteractionEpoch.value).toBe(2);
        expect(epochs.userPhysicalNavigationEpoch.value).toBe(0);

        endReplacement();
        expect(epochs.markScrollInteraction({
            top: 500,
            maxTop: 4000,
        })).toBe(true);

        expect(epochs.userPhysicalNavigationEpoch.value).toBe(1);
    });

    it('attributes an offset that clamping cannot explain to the user mid-replacement', () => {
        const epochs = createPdfViewportUserNavigationEpochs();
        epochs.markScrollInteraction({
            top: 500,
            maxTop: 4000,
        });
        const endReplacement = epochs.beginLayoutGeometryReplacement();

        // A macOS overlay scrollbar drag arrives as scroll and nothing else.
        expect(epochs.markScrollInteraction({
            top: 3200,
            maxTop: 4000,
        })).toBe(true);

        expect(epochs.userPhysicalNavigationEpoch.value).toBe(2);
        endReplacement();
    });

    it('still attributes a clamp to the shortened document to the viewer', () => {
        const epochs = createPdfViewportUserNavigationEpochs();
        epochs.markScrollInteraction({
            top: 3900,
            maxTop: 4000,
        });
        const endReplacement = epochs.beginLayoutGeometryReplacement();

        expect(epochs.markScrollInteraction({
            top: 3000,
            maxTop: 3000,
        })).toBe(false);

        expect(epochs.userPhysicalNavigationEpoch.value).toBe(1);
        endReplacement();
    });

    it('tracks writes the viewer authored so a later clamp is not misread as input', () => {
        const epochs = createPdfViewportUserNavigationEpochs();
        epochs.markScrollInteraction({
            top: 500,
            maxTop: 4000,
        });
        epochs.observeAuthoredScrollOffset(3900);
        const endReplacement = epochs.beginLayoutGeometryReplacement();

        expect(epochs.markScrollInteraction({
            top: 3000,
            maxTop: 3000,
        })).toBe(false);
        endReplacement();
    });

    it('keeps trusted wheel and pointer input authoritative during a geometry replacement', () => {
        const epochs = createPdfViewportUserNavigationEpochs();
        const endReplacement = epochs.beginLayoutGeometryReplacement();

        epochs.markPhysicalNavigation();

        expect(epochs.userPhysicalNavigationEpoch.value).toBe(1);
        endReplacement();
    });

    it('only reopens scroll attribution once every nested replacement has closed', () => {
        const epochs = createPdfViewportUserNavigationEpochs();
        const endOuter = epochs.beginLayoutGeometryReplacement();
        const endInner = epochs.beginLayoutGeometryReplacement();

        endInner();
        // A double close must not leak a negative depth that reopens the
        // window while the outer replacement is still running.
        endInner();
        epochs.markScrollInteraction({
            top: 0,
            maxTop: 0,
        });

        expect(epochs.userPhysicalNavigationEpoch.value).toBe(0);

        endOuter();
        epochs.markScrollInteraction({
            top: 0,
            maxTop: 0,
        });

        expect(epochs.userPhysicalNavigationEpoch.value).toBe(1);
    });
});
