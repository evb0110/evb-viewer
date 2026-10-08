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
                {
                    kind: 'text',
                    text: 'Use ',
                },
                {
                    kind: 'code',
                    text: 'smth',
                },
                {
                    kind: 'text',
                    text: ' here.',
                },
            ],
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
