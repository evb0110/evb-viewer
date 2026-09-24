import {createHash} from 'node:crypto';
import type {TOcrPageArtifact} from '@contracts/ocrIndex';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';

export const MIXED_OCR_CORPUS_PATH = '/tmp/evb-mixed-ocr-corpus.pdf';
export const MIXED_OCR_CORPUS_REVISION = requireDocumentRevisionToken('mixed-ocr-corpus-r1');

export const mixedEmbeddedTextPages = [
    {
        pageNumber: 1,
        text: 'visible native source',
        words: [],
        hasInvisibleText: false,
    },
    // Page 2 deliberately has no embedded text: it represents a scanned page.
    {
        pageNumber: 3,
        text: 'third party hidden text',
        words: [],
        hasInvisibleText: true,
    },
] as const;

const evbText = 'EVB generated text generation two';
export const mixedEvbPage: TOcrPageArtifact = {
    rotation: 0,
    render: {
        dpi: 300,
        imagePx: {
            w: 1200,
            h: 1600,
        },
    },
    text: evbText,
    words: [],
    canonicalText: {
        source: 'evb-ocr',
        generation: 'generation-2',
        contentDigest: createHash('sha256').update(evbText).digest('hex'),
    },
};

export const mixedOcrCorpusExpectedSources = [
    {
        pageNumber: 1,
        source: 'pdf-native',
    },
    {
        pageNumber: 3,
        source: 'foreign-ocr',
    },
    {
        pageNumber: 4,
        source: 'evb-ocr',
    },
] as const;
