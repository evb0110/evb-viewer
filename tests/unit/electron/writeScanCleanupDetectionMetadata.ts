import {
    readFile,
    writeFile,
} from 'fs/promises';

export async function writeScanCleanupDetectionMetadata(manifestPath: string): Promise<void> {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
        pageMetadataPath: string;
        sourcePageIndex: number;
    }>} ;
    await Promise.all(manifest.pages.map((page) => {
        const widthPx = 100 + page.sourcePageIndex * 10;
        const heightPx = 200 + page.sourcePageIndex * 10;
        return writeFile(page.pageMetadataPath, JSON.stringify({
            layoutClassification: 'single-uncut-page',
            cutterXPx: null,
            rotationDegrees: 0,
            canvasScope: 'page',
            excluded: false,
            blankOutputsSkipped: 0,
            outputCount: 1,
            outputs: [{
                half: 'full',
                sourceRegion: {
                    xPx: 0,
                    yPx: 0,
                    widthPx,
                    heightPx,
                },
                contentBox: {
                    xPx: 5,
                    yPx: 6,
                    widthPx: widthPx - 10,
                    heightPx: heightPx - 12,
                },
                cropRect: {
                    xPx: 0,
                    yPx: 0,
                    widthPx,
                    heightPx,
                },
                appliedMargins: {
                    leftPx: 0,
                    topPx: 0,
                    rightPx: 0,
                    bottomPx: 0,
                },
                inputWidthPx: widthPx,
                inputHeightPx: heightPx,
            }],
        }));
    }));
}
