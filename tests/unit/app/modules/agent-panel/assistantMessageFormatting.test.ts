// @vitest-environment happy-dom
import {
    afterEach, describe, expect, it, vi,
} from 'vitest';
import {
    createApp, defineComponent, h, nextTick, reactive,
} from 'vue';
import AssistantMarkdown from '@app/modules/agent-panel/components/AssistantMarkdown.vue';
import { highlightAssistantCode } from '@app/modules/agent-panel/utils/highlightAssistantCode';

vi.mock('@app/composables/useTypedI18n', () => ({ useTypedI18n: () => ({ t: (key: string) => key }) }));

const unmounts: Array<() => void> = [];
afterEach(() => { unmounts.splice(0).forEach(unmount => unmount()); });

function render(text: string, onCopy?: (id: string, code: string) => void) {
    const props = reactive({
        text,
        onCopy,
    });
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({ setup: () => () => h(AssistantMarkdown, props) }));
    app.component('UButton', defineComponent({
        inheritAttrs: false,
        setup: (_props, { attrs }) => () => h('button', { ...attrs, type: 'button' }),
    }));
    app.mount(host);
    unmounts.push(() => { app.unmount(); host.remove(); });
    return {
        host,
        props,
    };
}

function cellTexts(host: HTMLElement, selector: string) {
    return [...host.querySelectorAll(selector)].map(cell => cell.textContent);
}

describe('assistant message rendering', () => {
    it('renders inline code, strong, emphasis and safe links as elements', () => {
        const { host } = render('Use `smth` in **Die syrische Chronik** by *Luther* and [Docs](https://example.com/docs?a=1&amp;b=2). A &amp; B &#169; &#x1F600; &amp;copy; `&amp;` \\&amp;.');
        expect(host.querySelector('code')?.textContent).toBe('smth');
        expect(host.querySelector('strong')?.textContent).toBe('Die syrische Chronik');
        expect(host.querySelector('em')?.textContent).toBe('Luther');
        const link = host.querySelector('a');
        expect(link?.getAttribute('href')).toBe('https://example.com/docs?a=1&b=2');
        expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
        expect(host.textContent).toBe('Use smth in Die syrische Chronik by Luther and Docs. A & B © 😀 &copy; &amp; &amp;.');
    });

    it('renders headings, quotes, rules and ordered lists with their own start', () => {
        const { host } = render('# Summary\n\n> quoted *note*\n\n---\n\n3. Third\n4. Fourth');
        expect(host.querySelector('h1')?.textContent).toBe('Summary');
        expect(host.querySelector('blockquote em')?.textContent).toBe('note');
        expect(host.querySelector('hr')).not.toBeNull();
        expect(host.querySelector('ol')?.getAttribute('start')).toBe('3');
        expect(cellTexts(host, 'ol > li')).toEqual(['Third', 'Fourth']);
    });

    it('keeps nested lists nested and renders task items as read-only checkboxes', () => {
        const { host } = render('- Fables\n  - **Monkey** and carpenter\n  - Fox\n- [x] Saved');
        expect(cellTexts(host, 'ul > li > ul > li')).toEqual(['Monkey and carpenter', 'Fox']);
        expect(host.querySelector('ul > li > ul strong')?.textContent).toBe('Monkey');
        const checkbox = host.querySelector<HTMLInputElement>('li input[type="checkbox"]');
        expect(checkbox?.checked).toBe(true);
        expect(checkbox?.disabled).toBe(true);
    });

    it('renders a table with header cells, body cells and column alignment', () => {
        const { host } = render('| # | Bookmark | Page |\n|---|:--|--:|\n| 1 | Al-qird wa-l-najjar (The Monkey and the Carpenter) | 1 |\n| 2 | Al-tha\'lab | 4–5 |');
        expect(host.querySelector('.markdown-table > table')).not.toBeNull();
        expect(cellTexts(host, 'thead th')).toEqual(['#', 'Bookmark', 'Page']);
        expect(cellTexts(host, 'tbody tr:first-child td')).toEqual(['1', 'Al-qird wa-l-najjar (The Monkey and the Carpenter)', '1']);
        expect(host.querySelectorAll('tbody tr')).toHaveLength(2);
        expect(host.querySelector<HTMLElement>('thead th:last-child')?.style.textAlign).toBe('right');
        expect(host.querySelectorAll('tbody th, thead td')).toHaveLength(0);
    });

    it('renders fenced code with its language and copies exactly the code text', () => {
        const copy = vi.fn();
        const code = 'const value = 1;\n| a | b |\n| --- | --- |\n| c | d |';
        const { host } = render('Before\n```js\n' + code + '\n```\nAfter', copy);
        expect(host.querySelector('pre')?.textContent).toBe(code);
        expect(host.querySelector('.markdown-code-header')?.textContent).toBe('js');
        expect(host.querySelector('table')).toBeNull();
        expect(cellTexts(host, '.assistant-markdown > p')).toEqual(['Before', 'After']);
        host.querySelector<HTMLButtonElement>('.markdown-code-header button')?.click();
        expect(copy).toHaveBeenCalledWith('code-0', code);
    });

    it('renders an unfinished fence as code while it streams', () => {
        const { host } = render('```json\n{"ok": true}');
        expect(host.querySelector('pre')?.textContent).toBe('{"ok": true}');
        expect(host.querySelector('[data-language="json"]')).not.toBeNull();
    });

    it.each([
        ['<img src=x onerror=alert(1)> and <script>alert(1)</script>', 'img, script'],
        ['<b>bold?</b>', 'b'],
        ['![remote](https://example.com/tracker.png)', 'img'],
    ])('keeps raw HTML and images as literal text: %s', (text, selector) => {
        const { host } = render(text);
        expect(host.querySelectorAll(`.assistant-markdown ${selector}`)).toHaveLength(0);
        expect(host.textContent).toContain(text.startsWith('!') ? 'remote' : text.replace(/\n/gu, ''));
    });

    it.each([
        'javascript:alert(1)',
        'data:text/html,hi',
        'file:///etc/passwd',
    ])('drops a link with an unsafe scheme but keeps its label: %s', (href) => {
        const { host } = render(`[label](${href}) tail`);
        expect(host.querySelector('a')).toBeNull();
        expect(host.textContent).toBe('label tail');
    });

    it.each([
        '['.repeat(4000),
        'literal * unclosed and _ unclosed and ` unclosed',
    ])('keeps unmatched syntax literal', (text) => {
        const { host } = render(text);
        expect(host.textContent).toBe(text);
    });

    it.each([
        'Plain **strong** tail and _emphasis_ followed by text.',
        'word [pending `code` tail](/docs) after',
        'First.\n\nSecond **bold** paragraph.\n\nAfter.',
        '- a\n  - b\n- c\n\n| a | b |\n| --- | --- |\n| c | d |',
        'Before\n```js\n| a | b |\n```\nAfter',
    ])('renders every streamed prefix exactly as a fresh render of that text: %s', async (text) => {
        const streamed = render('');
        for (let end = 0; end <= text.length; end += 1) {
            const prefix = text.slice(0, end);
            streamed.props.text = prefix;
            await nextTick();
            const fresh = render(prefix);
            expect(streamed.host.innerHTML, 'prefix ' + end).toBe(fresh.host.innerHTML);
            unmounts.pop()?.();
        }
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
        const { host } = render('```ts\n' + source + '\n```');
        expect(host.querySelector('pre img')).toBeNull();
        expect(host.querySelector('pre')?.textContent).toBe(source);
    });
});
