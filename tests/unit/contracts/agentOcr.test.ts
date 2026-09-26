import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    AGENT_OCR_PAGE_SEGMENTATION_MODES,
    AGENT_OCR_RUN_INPUT_SCHEMA,
    parseAgentOcrRunOptions,
} from '@contracts/agentOcr';
import * as v from 'valibot';
import {toJsonSchema} from '@valibot/to-json-schema';

describe('agent OCR contract', () => {
    it('keeps the advertised fields and canonical enum values in one schema', () => {
        const advertised = toJsonSchema(AGENT_OCR_RUN_INPUT_SCHEMA);
        const branches = (advertised.anyOf ?? advertised.oneOf) as Array<{
            properties: Record<string, {
                const?: unknown;
                enum?: unknown[]
                type?: unknown;
            }>;
            additionalProperties: boolean;
        }>;
        expect(Object.keys(branches[0]!.properties)).toEqual([
            'pageRange',
            'customRange',
            'languages',
            'qualityProfile',
            'preprocessingMode',
            'pageSegmentationMode',
            'supersessionPolicy',
            'replaceAllAcknowledged',
            'open',
        ]);
        expect(new Set([
            branches[0]!.properties.supersessionPolicy?.const,
            ...(branches[1]!.properties.supersessionPolicy?.enum ?? []),
        ])).toEqual(new Set([
            'missing-only',
            'replace-evb',
            'replace-all',
        ]));
        for (const branch of branches) {
            expect(branch.properties.pageSegmentationMode?.enum).toEqual(AGENT_OCR_PAGE_SEGMENTATION_MODES);
            expect(branch.properties.pageSegmentationMode?.type).toBe('integer');
            expect(branch.additionalProperties).toBe(false);
        }
    });

    it('does not advertise OSD-only Tesseract modes as output OCR modes', () => {
        for (const mode of [
            0,
            2,
            12,
        ]) {
            expect(v.safeParse(AGENT_OCR_RUN_INPUT_SCHEMA, {pageSegmentationMode: mode}).success).toBe(false);
        }
        expect(v.safeParse(AGENT_OCR_RUN_INPUT_SCHEMA, {pageSegmentationMode: 13}).success).toBe(true);
    });

    it('keeps tolerant option parsing and normalization for the OCR popup', () => {
        expect(parseAgentOcrRunOptions({
            pageRange: 'custom',
            customRange: ' 1-3, 7 ',
            languages: [
                ' eng ',
                'rus',
                'eng',
                null,
            ],
            qualityProfile: 'poor-scan',
            preprocessingMode: 'clean',
            pageSegmentationMode: 11,
            supersessionPolicy: 'replace-all',
            replaceAllAcknowledged: true,
            open: false,
        })).toEqual({
            pageRange: 'custom',
            customRange: '1-3, 7',
            languages: [
                'eng',
                'rus',
            ],
            qualityProfile: 'poor-scan',
            preprocessingMode: 'clean',
            pageSegmentationMode: 11,
            supersessionPolicy: 'replace-all',
            replaceAllAcknowledged: true,
            open: false,
        });
        expect(parseAgentOcrRunOptions({
            pageRange: 'selection',
            customRange: '   ',
            selectedLanguages: ['deu'],
            qualityProfile: 'stock',
            preprocessingMode: 'maybe',
            pageSegmentationMode: 14,
            supersessionPolicy: 'replace-native',
            replaceAllAcknowledged: 'yes',
            open: 'yes',
        })).toEqual({});
        expect(parseAgentOcrRunOptions(null)).toEqual({});
    });

    it('requires explicit acknowledgement for replace-all and rejects unknown fields', () => {
        expect(v.safeParse(AGENT_OCR_RUN_INPUT_SCHEMA, {supersessionPolicy: 'replace-all'}).success).toBe(false);
        expect(v.safeParse(AGENT_OCR_RUN_INPUT_SCHEMA, {
            supersessionPolicy: 'replace-all',
            replaceAllAcknowledged: true,
        }).success).toBe(true);
        expect(v.safeParse(AGENT_OCR_RUN_INPUT_SCHEMA, {selectedLanguages: ['eng']}).success).toBe(false);
    });
});
