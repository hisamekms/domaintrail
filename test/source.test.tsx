import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { linesOf, SourceView } from '../web/source.js';

const text = 'context Shop {\n  aggregate Order {\n    id: OrderId\n  }\n}\n';
const sources = [{ path: 'shop.dt', text }];

const render = (focus?: { file: string; line: number; endLine?: number }) =>
    renderToStaticMarkup(<SourceView sources={sources} diagnostics={[]} model={null} file="shop.dt" focus={focus} onSelect={() => {}} />);

describe('source view', () => {
    test('the copied code is the original text of the range', () => {
        expect(linesOf(text, { line: 2, endLine: 4 })).toBe('  aggregate Order {\n    id: OrderId\n  }');
        expect(linesOf('a\r\nb\r\nc', { line: 2 })).toBe('b');
    });

    test('shows the copy button once, on the first line of the highlighted range', () => {
        const html = render({ file: 'shop.dt', line: 2, endLine: 4 });
        expect(html.match(/src-copy/g)).toHaveLength(1);
        const rows = html.split('<div class="src-line');
        expect(rows.findIndex((r) => r.includes('src-copy'))).toBe(2);
    });

    test('shows no copy button without a highlighted range', () => {
        expect(render()).not.toContain('src-copy');
        expect(render({ file: 'other.dt', line: 2 })).not.toContain('src-copy');
    });
});
