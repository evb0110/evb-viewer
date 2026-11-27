import type {
    IDjvuEngineDocInfoResult,
    IDjvuEngineRenderToFileResult,
} from '@electron/features/djvu/main/djvuEngineProtocol';
import { runDjvuEngine } from '@electron/features/djvu/main/djvuEnginePool';

export function verifyDjvuEngineInference() {
    const docInfo: Promise<IDjvuEngineDocInfoResult> = runDjvuEngine({
        type: 'getDocInfo',
        djvuPath: '/tmp/sample.djvu',
    });
    const hasText: Promise<boolean> = runDjvuEngine({
        type: 'hasText',
        djvuPath: '/tmp/sample.djvu',
    });
    const rendered: Promise<IDjvuEngineRenderToFileResult> = runDjvuEngine({
        type: 'renderPageToFile',
        djvuPath: '/tmp/sample.djvu',
        pageNumber: 1,
        outputPath: '/tmp/page-1.ppm',
        options: { format: 'ppm' },
    });

    // @ts-expect-error getPageInfo requires pageNumber
    void runDjvuEngine({
        type: 'getPageInfo',
        djvuPath: '/tmp/sample.djvu',
    });

    // @ts-expect-error getPageText requires includeZones
    void runDjvuEngine({
        type: 'getPageText',
        djvuPath: '/tmp/sample.djvu',
        pageNumber: 1,
    });

    void runDjvuEngine({
        type: 'getDocInfo',
        djvuPath: '/tmp/sample.djvu',
        // @ts-expect-error excess properties on inline request literals are rejected
        extraField: true,
    });

    return {
        docInfo,
        hasText,
        rendered,
    };
}
