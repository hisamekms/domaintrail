import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReplyText } from '../session/reply';
import { markdownPlain, parseInline, parseMarkdown, splitRow } from './markdown';
import { MarkdownImages, MarkdownText } from './markdown-text';

const t = (text: string): { kind: 'text'; text: string } => ({ kind: 'text', text });
const html = (text: string): string => renderToStaticMarkup(<MarkdownText text={text} renderText={(t) => <ReplyText text={t} onNavigate={() => {}} />} />);

describe('inline Markdown', () => {
    test('code, bold and italic, nested', () => {
        expect(parseInline('a `x < y` b')).toEqual([t('a '), { kind: 'code', text: 'x < y' }, t(' b')]);
        expect(parseInline('**太字** と *斜体*')).toEqual([{ kind: 'strong', children: [t('太字')] }, t(' と '), { kind: 'em', children: [t('斜体')] }]);
        expect(parseInline('**a `b` *c***')).toEqual([
            { kind: 'strong', children: [t('a '), { kind: 'code', text: 'b' }, t(' '), { kind: 'em', children: [t('c')] }] },
        ]);
        // a code span of two backticks holds one; markers in it are text
        expect(parseInline('``a ` **b**``')).toEqual([{ kind: 'code', text: 'a ` **b**' }]);
    });

    test('what is not closed or is spaced stays as written', () => {
        expect(parseInline('2 * 3 * 4')).toEqual([t('2 * 3 * 4')]);
        expect(parseInline('**open')).toEqual([t('**open')]);
        expect(parseInline('`open')).toEqual([t('`open')]);
        expect(parseInline('snake_case_name')).toEqual([t('snake_case_name')]);
    });

    test('backslash escapes, but `\\@{` is left for the element references', () => {
        expect(parseInline('\\*not\\* \\`x\\`')).toEqual([t('*not* `x`')]);
        expect(parseInline('\\@{Sales.Order}')).toEqual([t('\\@{Sales.Order}')]);
    });

    test('links and images are text: the label and the URL, never a link', () => {
        expect(parseInline('see [the docs](https://example.com/a) now')).toEqual([t('see the docs (https://example.com/a) now')]);
        expect(parseInline('[https://x.y](https://x.y)')).toEqual([t('https://x.y')]);
        expect(parseInline('![図](img.png)')).toEqual([t('図 (img.png)')]);
        expect(parseInline('<https://example.com>')).toEqual([t('https://example.com')]);
        expect(parseInline('[**b**](u)')).toEqual([{ kind: 'strong', children: [t('b')] }, t(' (u)')]);
    });

    test("an image of the page's own (`image:<id>`) is an image; a link to one is text", () => {
        expect(parseInline('前 ![伝票 **1**](image:img_0000abcd) 後')).toEqual([
            t('前 '),
            { kind: 'image', id: 'img_0000abcd', alt: '伝票 1', url: 'image:img_0000abcd' },
            t(' 後'),
        ]);
        expect(parseInline('[伝票](image:img_0000abcd)')).toEqual([t('伝票 (image:img_0000abcd)')]);
        expect(parseInline('![x](image:a b)')).toEqual([t('![x](image:a b)')]);
    });
});

describe('block Markdown', () => {
    test('paragraphs keep their line breaks; a blank line separates them', () => {
        expect(parseMarkdown('one\ntwo\n\nthree')).toEqual([
            { kind: 'paragraph', content: [t('one\ntwo')] },
            { kind: 'paragraph', content: [t('three')] },
        ]);
    });

    test('every heading level is one heading; `#name` without a space is text', () => {
        expect(parseMarkdown('# A\n## B\n###### C ##\n#注文')).toEqual([
            { kind: 'heading', content: [t('A')] },
            { kind: 'heading', content: [t('B')] },
            { kind: 'heading', content: [t('C')] },
            { kind: 'paragraph', content: [t('#注文')] },
        ]);
    });

    test('bullet and numbered lists, items going on over lines', () => {
        expect(parseMarkdown('- a\n  more\n* b\n\n3. c\n4) d')).toEqual([
            { kind: 'list', ordered: false, start: 1, items: [{ content: [t('a\nmore')] }, { content: [t('b')] }] },
            { kind: 'list', ordered: true, start: 3, items: [{ content: [t('c')] }, { content: [t('d')] }] },
        ]);
    });

    test('one level of nesting; deeper items are flattened to it', () => {
        const [list] = parseMarkdown('1. a\n   - b\n     - c\n         - d\n2. e');
        expect(list).toEqual({
            kind: 'list',
            ordered: true,
            start: 1,
            items: [
                {
                    content: [t('a')],
                    children: { kind: 'list', ordered: false, start: 1, items: [{ content: [t('b')] }, { content: [t('c')] }, { content: [t('d')] }] },
                },
                { content: [t('e')] },
            ],
        });
    });

    test('a fenced code block keeps its text as is, its indentation under the fence dropped; unclosed runs to the end', () => {
        expect(parseMarkdown('```ts\nconst a = <b>;\n  **x**\n```\nafter')).toEqual([
            { kind: 'code', text: 'const a = <b>;\n  **x**' },
            { kind: 'paragraph', content: [t('after')] },
        ]);
        expect(parseMarkdown('~~~\nx\n')).toEqual([{ kind: 'code', text: 'x\n' }]);
        // in a list: it ends the list, and the numbers go on after it
        expect(parseMarkdown('1. a\n   ```\n   code\n   ```\n2. b')).toEqual([
            { kind: 'list', ordered: true, start: 1, items: [{ content: [t('a')] }] },
            { kind: 'code', text: 'code' },
            { kind: 'list', ordered: true, start: 2, items: [{ content: [t('b')] }] },
        ]);
    });

    test('a GFM table: alignment, ragged rows padded or cut, pipes escaped or in code', () => {
        const [table] = parseMarkdown('| A | B | C |\n|:--|:-:|--:|\n| 1 | `x|y` |\n| 2 | a \\| b | 3 | extra |\nnext');
        expect(table).toEqual({
            kind: 'table',
            align: ['left', 'center', 'right'],
            head: [[t('A')], [t('B')], [t('C')]],
            rows: [
                [[t('1')], [{ kind: 'code', text: 'x|y' }], []],
                [[t('2')], [t('a | b')], [t('3')]],
            ],
        });
        expect(parseMarkdown('| A | B | C |\n|:--|:-:|--:|\n| 1 |\nnext')[1]).toEqual({ kind: 'paragraph', content: [t('next')] });
        // a delimiter row of another width: not a table
        expect(parseMarkdown('a | b\n--|--|--')[0].kind).toBe('paragraph');
        expect(splitRow('a | b')).toEqual(['a', 'b']);
    });

    test('a table and a list end the paragraph before them', () => {
        expect(parseMarkdown('intro\n| a |\n|---|\n| 1 |').map((b) => b.kind)).toEqual(['paragraph', 'table']);
        expect(parseMarkdown('intro\n- a').map((b) => b.kind)).toEqual(['paragraph', 'list']);
    });
});

describe('rendering an answer', () => {
    test('HTML is text, never markup', () => {
        const out = html('<script>alert(1)</script> <b>x</b>\n\n```\n<img src=x onerror=alert(1)>\n```');
        expect(out).not.toContain('<script>');
        expect(out).not.toContain('<b>');
        expect(out).not.toContain('<img');
        expect(out).toContain('&lt;script&gt;');
        expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    test('links and images never become anchors nor images', () => {
        const out = html('[x](javascript:alert(1)) ![y](https://e.com/i.png) <https://e.com>');
        expect(out).not.toContain('<a');
        expect(out).not.toContain('<img');
        expect(out).toContain('https://e.com/i.png');
    });

    test('blocks as elements: one heading style, lists, code, a scrolling table', () => {
        const out = html('# 見出し\n### 小見出し\n\n- a\n  - b\n\n1. c\n\n`c`\n\n| h |\n|---|\n| v |');
        expect(out.match(/class="md-heading"/g)).toHaveLength(2);
        expect(out).not.toMatch(/<h\d/);
        expect(out).toContain('<ul><li>a<ul><li>b</li></ul></li></ul><ol><li>c</li></ol>');
        expect(out).toContain('<code>c</code>');
        expect(out).toContain('<div class="md-table"><table><thead><tr><th>h</th></tr></thead><tbody><tr><td>v</td></tr></tbody></table></div>');
    });

    test('headings as paragraphs (a knowledge item): every level an ordinary paragraph, its marks dropped; the chat keeps its heading', () => {
        const src = '# x\n## y\n\ntext';
        const para = renderToStaticMarkup(<MarkdownText text={src} headings="paragraph" renderText={(t) => t} />);
        expect(para).toBe('<p>x</p><p>y</p><p>text</p>');
        expect(renderToStaticMarkup(<MarkdownText text={src} renderText={(t) => t} />)).toBe(
            '<p class="md-heading" role="heading" aria-level="4">x</p><p class="md-heading" role="heading" aria-level="4">y</p><p>text</p>',
        );
    });

    test('an attached image is drawn where the page resolves it, bounded and lazy; text where it does not (the chat today)', () => {
        const src = '![伝票](image:img_0000abcd) ![](image:img_0000ef01) ![外](https://e.com/i.png)';
        expect(html(src)).toBe('<p>伝票 (image:img_0000abcd) image:img_0000ef01 外 (https://e.com/i.png)</p>');
        const drawn = renderToStaticMarkup(
            <MarkdownImages.Provider value={(id) => `/img/${id}`}>
                <MarkdownText text={src} renderText={(t) => t} />
            </MarkdownImages.Provider>,
        );
        expect(drawn).toBe(
            '<p><img class="md-image" src="/img/img_0000abcd" alt="伝票" loading="lazy"/> <img class="md-image" src="/img/img_0000ef01" alt="" loading="lazy"/> 外 (https://e.com/i.png)</p>',
        );
    });

    test('element references in the text stay references (unresolved outside a page: their identifier)', () => {
        const out = html('**@{Sales.Order}** を見て');
        expect(out).toContain('<strong><span class="reply-element unresolved">Sales.Order</span></strong>');
    });
});

describe('the text plain', () => {
    test('a line per block, item and row; marks dropped, images left out, references as written', () => {
        expect(
            markdownPlain(
                '# 見出し\n\n**太字**と `x` の @{es:O/P}\n\n- a\n  - b\n1. c\n\n| h | i |\n|---|---|\n| v | |\n\n![図](image:img_0000abcd)\n\n```\ncode\n```',
            ),
        ).toBe('見出し\n太字と x の @{es:O/P}\na\nb\nc\nh i\nv\ncode');
        expect(markdownPlain('前 ![図](image:img_0000abcd) 後')).toBe('前 後');
    });
});
