import { describe, expect, test } from 'bun:test';
import { knowledgeDiagnostics, type KnowledgeNames } from './check.js';
import { printItemFile } from './item-file.js';
import { content, liveItem } from '../test-helpers.js';

const names: KnowledgeNames = { stickies: new Set(['Ordering.Placed']), stormings: new Set(['Ordering']), complete: true };

const fileOf = (id: string, about: string[]): { path: string; text: string } => ({
    path: `knowledge/${id}.md`,
    text: printItemFile({ ...liveItem(id), content: content(`about ${about.join(', ')}`, 'said', about) }),
});

describe('dt check on the knowledge files', () => {
    test('K002: an item about a sticky the workspace lacks, at the line of the entry', () => {
        const found = knowledgeDiagnostics([fileOf('kn_00000001', ['Ordering.Placed', 'Ordering.Gone', 'Billing.Paid'])], names);
        expect(found.map((d) => [d.code, d.severity, d.start.line, d.message])).toEqual([
            ['K002', 'warning', 10, "The knowledge item 'kn_00000001' is about 'Ordering.Gone', which storming 'Ordering' does not have."],
            ['K002', 'warning', 11, "The knowledge item 'kn_00000001' is about 'Billing.Paid', but there is no storming 'Billing'."],
        ]);
        expect(found[0].file).toBe('knowledge/kn_00000001.md');
    });

    test('with a .dtes that did not parse, only the stickies missing from the stormings read', () => {
        const found = knowledgeDiagnostics([fileOf('kn_00000001', ['Ordering.Gone', 'Billing.Paid'])], { ...names, complete: false });
        expect(found.map((d) => d.message)).toEqual(["The knowledge item 'kn_00000001' is about 'Ordering.Gone', which storming 'Ordering' does not have."]);
    });

    test('K001: a file that does not read is an error, not a crash; other files are left alone', () => {
        const found = knowledgeDiagnostics(
            [
                { path: 'knowledge/kn_00000002.md', text: '---\nid: kn_00000002\nversion: one\n---\n\nx\n' },
                { path: 'knowledge/README.md', text: 'not an item' },
                fileOf('kn_00000003', ['Ordering.Placed']),
            ],
            names,
        );
        expect(found.map((d) => [d.code, d.severity, d.start.line, d.message])).toEqual([
            ['K001', 'error', 3, "The knowledge item does not read: 'version' is a whole number from 1: not one."],
        ]);
    });
});
