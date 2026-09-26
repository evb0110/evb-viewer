import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    MAX_DOCUMENT_ALLOCATION_BYTES,
    assertDocumentAllocationSize,
    FILE_STAT_RESULT_SCHEMA,
} from '@contracts/electronApiDocuments';
import { decodeAppUpdateStatus } from '@contracts/updatesPlatformFeature';
import { decodeHostEnvironmentSnapshot } from '@contracts/hostPlatformFeature';
import { decodeHostResourceProfileSnapshot } from '@contracts/hostResourceProfile';
import { decodeWindowTabsAction } from '@contracts/windowTabsValidation';
import { decodeDocumentRevisionChangedEvent } from '@contracts/documentRevision';
import { decodeOcrLanguages } from '@contracts/ocrLanguages';
import * as v from 'valibot';

describe('trusted IPC payload decoders', () => {
    it('accepts bounded file sizes and rejects malformed allocation sizes', () => {
        expect(v.parse(FILE_STAT_RESULT_SCHEMA, {size: 42})).toEqual({size: 42});
        for (const value of [
            null,
            {size: '42'},
            {size: -1},
            {size: 1.5},
            {size: Number.MAX_SAFE_INTEGER + 1},
        ]) {
            expect(v.safeParse(FILE_STAT_RESULT_SCHEMA, value, {abortEarly: true}).success, JSON.stringify(value)).toBe(false);
        }
        expect(v.parse(FILE_STAT_RESULT_SCHEMA, {size: MAX_DOCUMENT_ALLOCATION_BYTES + 1})).toEqual({size: MAX_DOCUMENT_ALLOCATION_BYTES + 1});
        expect(() => assertDocumentAllocationSize(MAX_DOCUMENT_ALLOCATION_BYTES + 1)).toThrow(
            `no greater than ${MAX_DOCUMENT_ALLOCATION_BYTES} bytes`,
        );
    });

    it('validates update status including phase, origin, and percentage bounds', () => {
        expect(decodeAppUpdateStatus({
            phase: 'downloading',
            origin: 'manual',
            version: '2.0.0',
            percent: 25,
            message: null,
        })).toEqual({
            phase: 'downloading',
            origin: 'manual',
            version: '2.0.0',
            percent: 25,
            message: null,
        });
        expect(decodeAppUpdateStatus({
            phase: 'future-phase',
            origin: 'manual',
            version: null,
            percent: null,
            message: null,
        })).toBeNull();
        expect(decodeAppUpdateStatus({
            phase: 'downloading',
            origin: 'auto',
            version: null,
            percent: 101,
            message: null,
        })).toBeNull();
        expect(decodeAppUpdateStatus({
            phase: 'error',
            origin: 'auto',
            version: 'v'.repeat(129),
            percent: null,
            message: null,
        })).toBeNull();
        expect(decodeAppUpdateStatus({
            phase: 'error',
            origin: 'auto',
            version: null,
            percent: null,
            message: 'm'.repeat(4_097),
        })).toBeNull();
    });

    it('validates host environment snapshots', () => {
        expect(decodeHostEnvironmentSnapshot({
            platform: 'linux',
            osScaleFactor: 1.5,
        })).toEqual({
            platform: 'linux',
            osScaleFactor: 1.5,
        });
        expect(decodeHostEnvironmentSnapshot({
            platform: 'freebsd',
            osScaleFactor: 1,
        })).toBeNull();
        expect(decodeHostEnvironmentSnapshot({
            platform: 'darwin',
            osScaleFactor: 0,
        })).toBeNull();
        expect(decodeHostEnvironmentSnapshot({
            platform: 'darwin',
            osScaleFactor: 9,
        })).toBeNull();
    });

    it('keeps the decoded host resource profile contract stable', () => {
        expect(decodeHostResourceProfileSnapshot({
            logicalCpus: 4,
            totalRamBytes: 12 * (1024 ** 3),
            safeMode: true,
            gpuStatus: {
                gpu_compositing: 'disabled_software',
                webgl: 'unavailable_software',
            },
            detectedTier: 'low',
            performanceMode: 'medium',
            tier: 'medium',
        })).toMatchInlineSnapshot(`
          {
            "detectedTier": "low",
            "gpuStatus": {
              "gpu_compositing": "disabled_software",
              "webgl": "unavailable_software",
            },
            "logicalCpus": 4,
            "performanceMode": "medium",
            "safeMode": true,
            "tier": "medium",
            "totalRamBytes": 12884901888,
          }
        `);
    });

    it('validates every nested window-tab action variant', () => {
        expect(decodeWindowTabsAction({
            kind: 'move-tab-to-window',
            targetWindowId: 2,
            tabId: ' tab-1 ',
        })).toEqual({
            kind: 'move-tab-to-window',
            targetWindowId: 2,
            tabId: 'tab-1',
        });
        expect(decodeWindowTabsAction({
            kind: 'merge-window-into',
            targetWindowId: -1,
        })).toBeNull();
        expect(decodeWindowTabsAction({
            kind: 'close-tab',
            tabId: '  ',
        })).toBeNull();
        expect(decodeWindowTabsAction({
            kind: 'close-tab',
            tabId: 't'.repeat(513),
        })).toBeNull();
        expect(decodeWindowTabsAction({kind: 'future-action'})).toBeNull();
    });

    it('validates document revision change events and nested revision fields', () => {
        const valid = {
            version: 1,
            token: 'revision-2',
            previousToken: 'revision-1',
            documentRef: '/tmp/document.pdf',
            authority: 'electron-working-copy',
            contentRevision: 2,
            mintedAt: 123,
            reason: 'write',
        };
        expect(decodeDocumentRevisionChangedEvent(valid)).toEqual(valid);
        expect(decodeDocumentRevisionChangedEvent({
            ...valid,
            reason: 'future-reason',
        })).toBeNull();
        expect(decodeDocumentRevisionChangedEvent({
            ...valid,
            contentRevision: Number.MAX_SAFE_INTEGER + 1,
        })).toBeNull();
        expect(decodeDocumentRevisionChangedEvent({
            ...valid,
            mintedAt: 0,
        })).toBeNull();
        expect(decodeDocumentRevisionChangedEvent({
            ...valid,
            token: 't'.repeat(513),
        })).toBeNull();
        expect(decodeDocumentRevisionChangedEvent({
            ...valid,
            documentRef: 'p'.repeat(32_769),
        })).toBeNull();
        expect(decodeDocumentRevisionChangedEvent({
            ...valid,
            previousToken: '',
        })).toBeNull();
    });

    it('validates OCR language arrays and rejects invalid nested entries', () => {
        expect(decodeOcrLanguages([
            {
                code: 'eng',
                script: 'latin',
            },
            {
                code: 'ara',
                script: 'rtl',
            },
        ])).toEqual([
            {
                code: 'eng',
                script: 'latin',
            },
            {
                code: 'ara',
                script: 'rtl',
            },
        ]);
        expect(decodeOcrLanguages({
            code: 'eng',
            script: 'latin',
        })).toBeNull();
        expect(decodeOcrLanguages([])).toBeNull();
        expect(decodeOcrLanguages([{
            code: 'ENG',
            script: 'latin',
        }])).toBeNull();
        expect(decodeOcrLanguages([{
            code: 'eng',
            script: 'unknown',
        }])).toBeNull();
        expect(decodeOcrLanguages([
            {
                code: 'eng',
                script: 'latin',
            },
            {
                code: 'eng',
                script: 'latin',
            },
        ])).toBeNull();
        expect(decodeOcrLanguages(Array.from(
            {length: 129},
            (_, index) => ({
                code: `lang_${index}`,
                script: 'latin',
            }),
        ))).toBeNull();
        expect(decodeOcrLanguages([{
            code: `a${'b'.repeat(32)}`,
            script: 'latin',
        }])).toBeNull();
    });
});
