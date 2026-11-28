import {describe, expect, it} from 'vitest';
import {
    decodeOcrEngineHostEvent,
    decodeOcrEngineHostRequest,
    type IOcrEngineLaneReply,
    type TOcrEngineHostEvent,
} from '@electron/features/ocr/main/ocrEngineHostProtocol';

describe('ocrEngineHostProtocol', () => {
    it('decodes success and error lane replies as a discriminated union', () => {
        const outputBytes = new Uint8Array([10, 20]);
        const successEvent = decodeOcrEngineHostEvent({
            type: 'reply',
            lane: 0,
            reply: {
                id: 1,
                ok: true,
                result: {
                    passes: [
                        {
                            stderr: '',
                            outputs: [outputBytes],
                        },
                    ],
                },
                wasmMemoryBytes: 256 * 1024 * 1024,
            },
        });
        expect(successEvent).not.toBeNull();
        expect(successEvent?.type).toBe('reply');
        if (successEvent?.type === 'reply') {
            expect(successEvent.reply.ok).toBe(true);
            if (successEvent.reply.ok) {
                expect(successEvent.reply.result.passes).toHaveLength(1);
                expect(successEvent.reply.result.passes[0]?.outputs[0]).toEqual(outputBytes);
                expect(successEvent.reply.wasmMemoryBytes).toBe(256 * 1024 * 1024);
            }
        }

        const failureEvent = decodeOcrEngineHostEvent({
            type: 'reply',
            lane: 1,
            reply: {
                id: 2,
                ok: false,
                error: 'tesseract failed',
                wasmMemoryBytes: 0,
            },
        });
        expect(failureEvent).toEqual({
            type: 'reply',
            lane: 1,
            reply: {
                id: 2,
                ok: false,
                error: 'tesseract failed',
                wasmMemoryBytes: 0,
            },
        });
    });

    it.each([
        {
            type: 'reply',
            lane: 0,
            reply: {id: 1, ok: true},
        },
        {
            type: 'reply',
            lane: 0,
            reply: {id: 1, ok: false},
        },
        {
            type: 'reply',
            lane: 0,
            reply: {id: 1, ok: true, result: {passes: []}, wasmMemoryBytes: -1},
        },
        {
            type: 'reply',
            lane: 0,
            reply: {id: 1, ok: true, result: {passes: []}, wasmMemoryBytes: 12.5},
        },
        {
            type: 'reply',
            lane: -1,
            reply: {id: 1, ok: false, error: 'bad lane'},
        },
        {
            type: 'exit',
            lane: 0,
            code: 1.5,
        },
    ])('rejects malformed host event %#', (frame) => {
        expect(decodeOcrEngineHostEvent(frame)).toBeNull();
    });

    it('decodes valid host requests and rejects invalid image descriptors', () => {
        expect(decodeOcrEngineHostRequest({type: 'shutdown'})).toEqual({type: 'shutdown'});
        expect(
            decodeOcrEngineHostRequest({
                type: 'run',
                lane: 0,
                message: {
                    id: 3,
                    request: {
                        image: {
                            kind: 'file',
                            path: '/tmp/page.ppm',
                            width: 100,
                            height: 200,
                        },
                        models: ['eng'],
                        passes: [],
                    },
                },
            })?.type,
        ).toBe('run');
        expect(
            decodeOcrEngineHostRequest({
                type: 'run',
                lane: 0,
                message: {
                    id: 3,
                    request: {
                        image: {
                            kind: 'file',
                            path: '',
                            width: 0,
                            height: 200,
                        },
                    },
                },
            }),
        ).toBeNull();
    });

    it('preserves discriminated union soundness on IOcrEngineLaneReply and TOcrEngineHostEvent', () => {
        const inspectReply = (reply: IOcrEngineLaneReply) => {
            if (reply.ok) {
                // @ts-expect-error error does not exist on ok: true lane reply
                void reply.error;
                return reply.result.passes.length;
            }
            // @ts-expect-error result does not exist on ok: false lane reply
            void reply.result;
            return reply.error.length;
        };

        // @ts-expect-error ok: true reply must include result
        const _missingResult: IOcrEngineLaneReply = {id: 1, ok: true};
        // @ts-expect-error ok: false reply must include error
        const _missingError: IOcrEngineLaneReply = {id: 2, ok: false};
        // @ts-expect-error ok: true reply cannot carry error instead of result
        const _mixedBranch: IOcrEngineLaneReply = {id: 3, ok: true, error: 'wrong'};

        const event: TOcrEngineHostEvent = {
            type: 'reply',
            lane: 0,
            reply: {
                id: 1,
                ok: true,
                result: {passes: []},
            },
        };

        expect(inspectReply(event.reply)).toBe(0);
        expect([_missingResult.id, _missingError.id, _mixedBranch.id]).toEqual([1, 2, 3]);
    });
});
