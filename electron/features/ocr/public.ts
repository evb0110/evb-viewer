export {
    cancelOcrJobsForWorkingCopy,
    recoverOcrJobManager,
    shutdownOcrJobManager,
} from '@electron/features/ocr/main/jobManager';
export {
    discardOcrResultsForDocument,
    findOcrResultForDocument,
} from '@electron/features/ocr/main/jobManager';
export {buildTesseractEnv} from '@electron/features/ocr/main/buildTesseractEnv';
