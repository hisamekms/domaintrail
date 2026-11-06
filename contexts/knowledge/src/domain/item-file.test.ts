import { describe, expect, test } from 'bun:test';
import { Knowledge } from '../generated/index.js';
import { idOfFileName, printItemFile, readItemFile } from './item-file.js';
import { at, content, itemId, later, liveItem, sessionRef, source, userName } from '../test-helpers.js';

const read = (text: string, name?: string): Knowledge.KnowledgeItem => {
    const r = readItemFile(text, name);
    if (!r.ok) throw new Error(`line ${r.error.line}: ${r.error.message}`);
    return r.value.item;
};

const problem = (text: string, name?: string): { line: number; message: string } => {
    const r = readItemFile(text, name);
    if (r.ok) throw new Error('read');
    return r.error;
};

describe('the file of an item', () => {
    test('prints in a fixed order and reads back the same item', () => {
        const item: Knowledge.LiveKnowledgeItem = {
            ...liveItem('kn_7c0f3a9d2e', { createdIn: 's_20261105', conflictsWith: ['kn_00000009'] }),
            content: {
                ...content('月末締めの案件は、作業が翌月にずれることがある。\n\n![写真](image:img_0000000001)\n', 'agreed', [
                    'Ordering.CreateSpecification',
                    'Ordering.Placed',
                ]),
                labels: { when: 'to_be', kind: 'pain', origin: 'agreed', perspective: '案件担当' as Knowledge.Perspective },
            },
            sources: [source('s_20261105', '12', '月末締め: "翌月" になる'), source('s_20261105', 'm-13')],
            updatedAt: later,
        };
        const text = printItemFile(item);
        expect(text).toStartWith(
            '---\nid: kn_7c0f3a9d2e\nversion: 1\ntitle: "月末締めの案件は、作業が翌月にずれることがある。"\nwhen: to_be\nkind: pain\norigin: agreed\nperspective: "案件担当"\nabout:\n  - Ordering.CreateSpecification\n',
        );
        expect(text).toContain('    message: "12"\n');
        expect(read(text, 'kn_7c0f3a9d2e.md')).toEqual(item);
    });

    test('a deleted item, a hand-written item without sources, and empty lists', () => {
        const deleted: Knowledge.DeletedKnowledgeItem = {
            ...liveItem('kn_00000001'),
            state: 'Deleted',
            deletedBy: userName('a@example.com'),
            deletedAt: later,
        };
        expect(read(printItemFile(deleted))).toEqual(deleted);
        const byHand: Knowledge.LiveKnowledgeItem = { ...liveItem('kn_00000002'), sources: [], content: content('x', 'said', []) };
        const text = printItemFile(byHand);
        expect(text).toContain('about: []\nconflictsWith: []\n');
        expect(text).toContain('sources: []\n');
        expect(read(text)).toEqual(byHand);
    });

    test('reads what a person may write by hand: comments, quotes, flow lists, CRLF', () => {
        const text = [
            '---',
            '# written by hand',
            "id: 'kn_00000003'",
            'version: 2',
            "title: '締めは前日'",
            'when: as_is   # AS-IS',
            'kind: rule',
            'origin: said',
            'about: [Ordering.A, "Ordering.B"]',
            'createdIn: s1',
            'createdAt: 2026-11-05T09:00:00Z',
            'updatedAt: 2026-11-05T09:00:00Z',
            'sources:',
            '- session: s1',
            '  message: m1',
            '  at: 2026-11-05T09:00:00Z',
            "  quote: 'it''s so'",
            '---',
            'body',
            '',
        ].join('\r\n');
        const item = read(text);
        expect(item.content.about).toEqual(['Ordering.A', 'Ordering.B'] as Knowledge.StickyRef[]);
        expect(item.sources[0].quote).toBe("it's so" as Knowledge.Quote);
        expect(item.content.title).toBe('締めは前日' as Knowledge.ItemTitle);
        expect(item.content.text).toBe('body' as Knowledge.ItemText);
        expect(item.version).toBe(2 as Knowledge.ItemVersion);
        expect(item.createdIn).toBe(sessionRef('s1'));
        expect(item.createdAt).toEqual(at);
    });

    test('a file that does not read gives its first problem at its line', () => {
        const good = printItemFile(liveItem('kn_00000004'));
        expect(problem('no front matter').line).toBe(1);
        expect(problem('---\nid: kn_00000004\n').message).toContain('not closed');
        expect(problem(good.replace('kind: rule', 'kind: rules'))).toEqual({
            line: 6,
            message: "'kind' is one of rule, flow, example, term, pain, want, decision: not rules.",
        });
        expect(problem(good.replace('version: 1\n', '')).message).toBe("'version' is missing.");
        // an item has a title (ADR 0031, section 2): one written before titles does not read
        expect(problem(good.replace(/title: .*\n/, ''))).toEqual({ line: 2, message: "'title' is missing." });
        expect(problem(good.replace(/title: .*\n/, `title: "${'長'.repeat(41)}"\n`)).message).toStartWith("'title' is one line of at most 40 characters");
        expect(problem(good.replace(/title: .*\n/, 'title: " 前に空白"\n')).message).toStartWith("'title' is one line");
        expect(problem(good.replace('origin: said', 'origin: said\ncolour: red')).message).toStartWith("Unknown key 'colour'");
        expect(problem(good.replace(/quote: .*/, 'quote: "unclosed')).message).toContain('not closed');
        expect(problem(good.replace('Ordering.CreateSpecification', 'not a ref')).message).toContain("'about'");
        expect(problem(good.replace(/\n\nthe finding of kn_00000004\n$/, '\n')).message).toContain('empty');
        expect(problem(good, 'kn_00000005.md').message).toBe("The file of item 'kn_00000004' is named kn_00000005.md: name it kn_00000004.md.");
        expect(problem(good.replace('conflictsWith: []', 'conflictsWith: [kn_00000004]')).message).toBe("'conflictsWith' names the item itself.");
    });

    test('only kn_….md files are items', () => {
        expect(idOfFileName('kn_00000001.md')).toBe('kn_00000001');
        expect(idOfFileName('README.md')).toBeUndefined();
        expect(idOfFileName('.kn_00000001.md.tmp-1')).toBeUndefined();
        expect(itemId('kn_00000001')).toBe(itemId('kn_00000001'));
    });
});
