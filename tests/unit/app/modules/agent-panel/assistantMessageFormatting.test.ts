import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createStreamingAssistantMessageFormatter,
    formatAssistantMessage,
} from '@app/modules/agent-panel/utils/formatAssistantMessage';
import { highlightAssistantCode } from '@app/modules/agent-panel/utils/highlightAssistantCode';

describe('assistantMessageFormatting', () => {
    it('preserves plain text while splitting inline code spans', () => {
        expect(formatAssistantMessage('Use `smth` here.')).toEqual([{
            kind: 'text',
            segments: [
                'Use ',
                'smth',
                ' here.',
            ].map((text, index) => ({
                kind: index === 1 ? 'code' : 'text',
                text,
            })),
        }]);
    });

    it('splits strong emphasis markers into safe inline segments', () => {
        expect(formatAssistantMessage(
            'This PDF is **Die syrische Chronik des Josua Stylites** by **Andreas Luther**.',
        )).toEqual([{
            kind: 'text',
            segments: [
                {
                    kind: 'text',
                    text: 'This PDF is ',
                },
                {
                    kind: 'strong',
                    text: 'Die syrische Chronik des Josua Stylites',
                },
                {
                    kind: 'text',
                    text: ' by ',
                },
                {
                    kind: 'strong',
                    text: 'Andreas Luther',
                },
                {
                    kind: 'text',
                    text: '.',
                },
            ],
        }]);
    });

    it('recognizes common markdown blocks produced by agents', () => {
        expect(formatAssistantMessage([
            '# Summary',
            '- **Ready** item',
            '- [Docs](https://example.com/docs)',
            '> quoted *note*',
            '---',
        ].join('\n'))).toEqual([
            {
                kind: 'heading',
                level: 1,
                segments: [{
                    kind: 'text',
                    text: 'Summary',
                }],
            },
            {
                kind: 'list',
                ordered: false,
                items: [
                    [
                        {
                            kind: 'strong',
                            text: 'Ready',
                        },
                        {
                            kind: 'text',
                            text: ' item',
                        },
                    ],
                    [{
                        kind: 'link',
                        text: 'Docs',
                        href: 'https://example.com/docs',
                    }],
                ],
            },
            {
                kind: 'blockquote',
                segments: [
                    {
                        kind: 'text',
                        text: 'quoted ',
                    },
                    {
                        kind: 'emphasis',
                        text: 'note',
                    },
                ],
            },
            { kind: 'rule' },
        ]);
    });

    it('marks ordered lists separately from unordered lists', () => {
        expect(formatAssistantMessage('1. First\n2. Second')).toEqual([{
            kind: 'list',
            ordered: true,
            items: [
                [{
                    kind: 'text',
                    text: 'First',
                }],
                [{
                    kind: 'text',
                    text: 'Second',
                }],
            ],
        }]);
    });

    it('keeps fenced code blocks separate from surrounding text', () => {
        expect(formatAssistantMessage('Before\n```ts\nconst value = 1;\n```\nAfter')).toEqual([
            {
                kind: 'text',
                segments: [{
                    kind: 'text',
                    text: 'Before',
                }],
            },
            {
                kind: 'code',
                language: 'ts',
                code: 'const value = 1;',
            },
            {
                kind: 'text',
                segments: [{
                    kind: 'text',
                    text: 'After',
                }],
            },
        ]);
    });

    it.each([
        false,
        true,
    ])('keeps table-looking rows owned by a code fence, closed=%s', (closed) => {
        const code = 'const value = 1;\n| a | b |\n| --- | --- |\n| c | d |';
        expect(formatAssistantMessage('```js\n' + code + (closed ? '\n```' : ''))).toEqual([{
            kind: 'code',
            language: 'js',
            code,
        }]);
    });

    it('renders an unfinished fenced block as code for streaming messages', () => {
        expect(formatAssistantMessage('```json\n{"ok": true}')).toEqual([{
            kind: 'code',
            language: 'json',
            code: '{"ok": true}',
        }]);
    });

    it('renders tables and incrementally preserves committed blocks while streaming', () => {
        expect(formatAssistantMessage('| Name | State |\n| --- | --- |\n| OCR | Ready |')).toEqual([{
            kind: 'table',
            rows: [
                [
                    [{
                        kind: 'text',
                        text: 'Name',
                    }],
                    [{
                        kind: 'text',
                        text: 'State',
                    }],
                ],
                [
                    [{
                        kind: 'text',
                        text: 'OCR',
                    }],
                    [{
                        kind: 'text',
                        text: 'Ready',
                    }],
                ],
            ],
        }]);

        const formatter = createStreamingAssistantMessageFormatter();
        const first = formatter.format('First paragraph.\n\nSecond');
        const second = formatter.format('First paragraph.\n\nSecond paragraph.');
        expect(first).toHaveLength(2);
        expect(second).toHaveLength(2);
        expect(second[0]).toBe(first[0]);
    });

    it.each([
        '['.repeat(4000),
        '['.repeat(4000) + 'label](javascript:alert)',
        'literal * unclosed and _ unclosed and ` unclosed',
    ])('preserves unmatched or unsafe inline syntax literally', (text) => {
        expect(formatAssistantMessage(text)).toEqual([{
            kind: 'text',
            segments: [{
                kind: 'text',
                text,
            }],
        }]);
    });

    it.each([
        'Plain paragraph grows without a blank line.',
        'Plain **strong** tail and _emphasis_ followed by text.',
        'word [pending `code` tail](/docs)',
        'word [pending **strong** tail](/docs)',
        'word [pending *emphasis* tail](/docs)',
        'word _emphasis_suffix and [Docs](https://example.test) tail',
        'First.\n\nSecond **bold** paragraph.\n\nAfter.',
        'First\r\n\r\nSecond\r\nline',
        '1. First\n2. Second\n\nAfter',
        '| a | b |\n| --- | --- |\n| c | d |',
        'Before\n```js\n| a | b |\n| --- | --- |\n| c | d |\n```\nAfter',
    ])('matches full formatting at every streamed prefix: %s', (text) => {
        const formatter = createStreamingAssistantMessageFormatter();
        for (let end = 0; end <= text.length; end += 1) {
            const prefix = text.slice(0, end);
            expect(formatter.format(prefix), 'prefix ' + end).toEqual(formatAssistantMessage(prefix));
        }
        expect(formatter.format('Replacement.')).toEqual(formatAssistantMessage('Replacement.'));
        expect(formatter.format('')).toEqual([]);
    });

    it('syntax-highlights code as escaped text tokens without producing HTML', () => {
        const source = 'const unsafe = "<img onerror=alert(1)>"; // safe text';
        const tokens = highlightAssistantCode(source, 'ts');

        expect(tokens.map(token => token.text).join('')).toBe(source);
        expect(tokens).toEqual(expect.arrayContaining([
            {
                kind: 'keyword',
                text: 'const',
            },
            {
                kind: 'literal',
                text: '"<img onerror=alert(1)>"',
            },
            {
                kind: 'comment',
                text: '// safe text',
            },
        ]));
        expect(tokens.some(token => token.text.includes('<img'))).toBe(true);
    });
});
