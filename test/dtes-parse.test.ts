import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { GrammarAST, GrammarUtils, URI } from 'langium';
import { Domain, EventStorming, isEsCommand, isEsRelationClause, isEsStorming, type EsFile } from '../src/language/generated/ast.js';
import { DomainGrammar, EventStormingGrammar } from '../src/language/generated/grammar.js';
import { declarations, type Clause, type NodeElement, type Storming, type Timeline } from '../src/dtes/ir.js';
import { createStormingServices } from '../src/dtes/language/module.js';
import { parseStormings, toStormingIr } from '../src/dtes/parse.js';
import { validateStormings } from '../src/dtes/validate.js';

const SAMPLE = await readFile(path.join(import.meta.dir, 'fixtures', 'dtes', 'delivery-cancellation.dtes'), 'utf8');

async function parseOne(text: string): Promise<Storming[]> {
    const r = await parseStormings([{ path: 'a.dtes', text }]);
    expect(r.diagnostics).toEqual([]);
    expect(r.syntaxOk).toBe(true);
    return r.stormings;
}

async function syntaxErrors(text: string) {
    const r = await parseStormings([{ path: 'a.dtes', text }]);
    expect(r.syntaxOk).toBe(false);
    expect(r.stormings).toEqual([]);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    for (const d of r.diagnostics) expect(d).toMatchObject({ file: 'a.dtes', severity: 'error', code: 'SYNTAX' });
    return r.diagnostics;
}

const element = (s: Storming, id: string): NodeElement => {
    const el = s.elements.find((e) => e.id === id);
    if (!el || el.kind === 'timeline') throw new Error(`no element ${id}`);
    return el;
};

const timeline = (s: Storming, id: string): Timeline => {
    const el = s.elements.find((e) => e.id === id);
    if (el?.kind !== 'timeline') throw new Error(`no timeline ${id}`);
    return el;
};

/** A clause without its ranges. */
const shape = (c: Clause): unknown => {
    if (c.type === 'ref') return { ref: c.path };
    if (c.type === 'relation') return { [c.keyword]: c.target };
    if (c.type === 'status') return { status: c.value };
    return { resolution: c.text };
};

const lines = (...ls: string[]) => `${ls.join('\n')}\n`;

const wrap = (body: string) => `storming S {\n${body}\n}\n`;

describe('ES01: parsing the spec sample (docs/dtes-v0.1.md §4)', () => {
    test('every element, clause and step, in source order', async () => {
        const [s] = await parseOne(SAMPLE);
        expect(s.id).toBe('DeliveryCancellation');
        expect(s.label).toBe('配送キャンセル');
        expect(s.elements.map((e) => `${e.kind} ${e.id}`)).toEqual([
            'event ShipmentCancelled',
            'event BikeReleased',
            'event SlotReleased',
            'event ReleaseFailed',
            'actor Customer',
            'external PaymentGateway',
            'readmodel DeliveryDetails',
            'aggregate Shipment',
            'aggregate BikeAssignment',
            'aggregate ShipmentSlot',
            'command CancelShipment',
            'command ReleaseBike',
            'command ReceivePaymentNotice',
            'command ReleaseSlot',
            'policy CleanupAfterCancel',
            'timeline Normal',
            'timeline Failure',
            'hotspot Compensation',
        ]);
        expect(element(s, 'SlotReleased')).toMatchObject({ label: '配送枠が解放された', clauses: [] });
        expect(element(s, 'ShipmentCancelled').clauses.map(shape)).toEqual([{ ref: 'Delivery.ShipmentCancelled' }]);
        expect(element(s, 'CancelShipment').clauses.map(shape)).toEqual([
            { ref: 'Delivery.Shipment.cancel' },
            { actor: 'Customer' },
            { reads: 'DeliveryDetails' },
            { target: 'Shipment' },
            { emits: 'ShipmentCancelled' },
        ]);
        expect(element(s, 'ReleaseBike').clauses.map(shape)).toEqual([
            { ref: 'Fleet.BikeAssignment.release' },
            { target: 'BikeAssignment' },
            { emits: 'BikeReleased' },
            { emits: 'ReleaseFailed' },
        ]);
        expect(element(s, 'CleanupAfterCancel').clauses.map(shape)).toEqual([
            { on: 'ShipmentCancelled' },
            { issues: 'ReleaseBike' },
            { issues: 'ReleaseSlot' },
        ]);
        expect(element(s, 'Compensation')).toMatchObject({ label: '車両の解放に失敗した場合、配送キャンセルを補償する？' });
        expect(element(s, 'Compensation').clauses.map(shape)).toEqual([{ on: 'ReleaseFailed' }, { status: 'open' }]);
        expect(element(s, 'ReleaseBike').clauses[0]).toMatchObject({ type: 'ref', segments: ['Fleet', 'BikeAssignment', 'release'] });

        const normal = timeline(s, 'Normal');
        expect(normal.label).toBe('通常キャンセル');
        expect(normal.steps).toMatchObject([
            { type: 'event', eventId: 'ShipmentCancelled' },
            { type: 'group', kind: 'group', id: 'CleanupResults', label: '後処理', events: [{ eventId: 'BikeReleased' }, { eventId: 'SlotReleased' }] },
        ]);
        expect(timeline(s, 'Failure').steps.map((st) => st.type === 'event' && st.eventId)).toEqual(['ShipmentCancelled', 'ReleaseFailed']);
        expect(declarations(s).map((d) => d.id)).toContain('CleanupResults');
    });

    test('source ranges: declarations, names, clauses, relation targets and steps (1-based, end exclusive)', async () => {
        const [s] = await parseOne(SAMPLE);
        const file = 'a.dtes';
        expect(s.range).toEqual({ file, start: { line: 1, column: 1 }, end: { line: 67, column: 2 } });
        expect(s.nameRange).toEqual({ file, start: { line: 1, column: 10 }, end: { line: 1, column: 30 } });
        const cancel = element(s, 'CancelShipment');
        expect(cancel.range).toEqual({ file, start: { line: 23, column: 3 }, end: { line: 29, column: 4 } });
        expect(cancel.nameRange).toEqual({ file, start: { line: 23, column: 11 }, end: { line: 23, column: 25 } });
        expect(cancel.clauses[0].range).toEqual({ file, start: { line: 24, column: 5 }, end: { line: 24, column: 33 } });
        const target = cancel.clauses[3];
        expect(target.type === 'relation' && target.targetRange).toEqual({ file, start: { line: 27, column: 12 }, end: { line: 27, column: 20 } });
        expect(target.range).toEqual({ file, start: { line: 27, column: 5 }, end: { line: 27, column: 20 } });
        const [first, group] = timeline(s, 'Normal').steps;
        expect(first.range).toEqual({ file, start: { line: 51, column: 5 }, end: { line: 51, column: 22 } });
        expect(group.type === 'group' && group.nameRange).toEqual({ file, start: { line: 52, column: 11 }, end: { line: 52, column: 25 } });
        expect(group.type === 'group' && group.events[1].range).toEqual({ file, start: { line: 54, column: 7 }, end: { line: 54, column: 19 } });
    });
});

describe('end to end with the validator (T3)', () => {
    test('the spec sample parses and validates with no diagnostics', async () => {
        expect(validateStormings(await parseOne(SAMPLE))).toEqual([]);
    });

    test('what the grammar accepts permissively is reported with the spec’s rule IDs at the clause', async () => {
        const text = lines(
            'storming S {',
            '  event E',
            '  aggregate G',
            '  command C {',
            '    target G',
            '    target G',
            '  }',
            '  policy P {',
            '    ref A.P',
            '    on E',
            '    issues C',
            '  }',
            '  timeline T {',
            '    C',
            '  }',
            '  hotspot H {',
            '    status maybe',
            '  }',
            '}',
        );
        const ds = validateStormings(await parseOne(text));
        expect(ds.map((d) => [d.code, d.start.line, d.start.column])).toEqual([
            ['S004', 6, 5],
            ['S005', 9, 5],
            ['S003', 14, 5],
            ['S009', 17, 5],
        ]);
    });
});

describe('ES01: every construct of §3', () => {
    test('labels are optional; every element may have a body or none', async () => {
        const [s] = await parseOne(
            'storming S {\n  event A\n  actor B {}\n  external C\n  command D\n  policy E\n  aggregate F\n  readmodel G\n  hotspot H\n  timeline T {}\n}',
        );
        expect(s.label).toBeUndefined();
        expect(s.elements.map((e) => [e.kind, e.id, e.label])).toEqual([
            ['event', 'A', undefined],
            ['actor', 'B', undefined],
            ['external', 'C', undefined],
            ['command', 'D', undefined],
            ['policy', 'E', undefined],
            ['aggregate', 'F', undefined],
            ['readmodel', 'G', undefined],
            ['hotspot', 'H', undefined],
            ['timeline', 'T', undefined],
        ]);
        expect('label' in s).toBe(false);
    });

    test('a resolved hotspot with its resolution; strings are escaped as in .dt', async () => {
        const [s] = await parseOne(wrap('hotspot H "\\"補償\\"する？" {\n  status resolved\n  resolution "しない\\n\\\\ 理由: \\"運用\\""\n}'));
        const h = element(s, 'H');
        expect(h.label).toBe('"補償"する？');
        expect(h.clauses.map(shape)).toEqual([{ status: 'resolved' }, { resolution: 'しない\n\\ 理由: "運用"' }]);
    });

    test('`///` doc comments describe declarations, groups included; other comments are ignored', async () => {
        const [s] = await parseOne(
            [
                '/// The storming.',
                'storming S {',
                '  /// Happens once.',
                '  /// Really.',
                '  event A // trailing',
                '  /* block */ event B',
                '  // not a doc',
                '  event C',
                '  timeline T {',
                '    /// A stage.',
                '    group G { A B }',
                '  }',
                '}',
            ].join('\n'),
        );
        expect(s.doc).toBe('The storming.');
        expect(element(s, 'A').doc).toBe('Happens once.\nReally.');
        expect(element(s, 'B').doc).toBeUndefined();
        expect(element(s, 'C').doc).toBeUndefined();
        const g = timeline(s, 'T').steps[0];
        expect(g.type === 'group' && g.doc).toBe('A stage.');
    });

    test('`ref` path segments after the first may be keywords', async () => {
        const [s] = await parseOne(wrap('command C { ref Delivery.Shipment.target }\ncommand D { ref Ctx.Agg.status }'));
        expect(element(s, 'C').clauses[0]).toMatchObject({ path: 'Delivery.Shipment.target', segments: ['Delivery', 'Shipment', 'target'] });
        expect(element(s, 'D').clauses.map(shape)).toEqual([{ ref: 'Ctx.Agg.status' }]);
    });

    test('several stormings in a file and several files, in file order then source order', async () => {
        const r = await parseStormings([
            { path: 'b.dtes', text: 'storming B1 {}\nstorming B2 { event E }' },
            { path: 'a.dtes', text: 'storming A {}' },
            { path: 'empty.dtes', text: '// nothing yet\n' },
        ]);
        expect(r.syntaxOk).toBe(true);
        expect(r.stormings.map((s) => `${s.range.file}:${s.id}`)).toEqual(['b.dtes:B1', 'b.dtes:B2', 'a.dtes:A']);
    });
});

describe('the grammar is permissive where the validator (T3) reports rule IDs', () => {
    test('misplaced, repeated and wrong-kind clauses parse as written', async () => {
        const [s] = await parseOne(
            wrap(
                [
                    'event E { ref A.E\n ref A.F\n emits E\n status open }',
                    'aggregate G',
                    'command C { target G\n target G\n on E\n issues C\n status weird\n resolution "r" }',
                    'policy P { ref A.P\n target G }',
                    'actor X { ref A.X }',
                    'external Y { ref A.Y\n actor X }',
                    'readmodel R { ref A.R }',
                    'hotspot H { ref A.H\n on E\n on Missing\n status maybe\n resolution "x" }',
                ].join('\n'),
            ),
        );
        expect(element(s, 'E').clauses.map(shape)).toEqual([{ ref: 'A.E' }, { ref: 'A.F' }, { emits: 'E' }, { status: 'open' }]);
        expect(element(s, 'C').clauses.map(shape)).toEqual([
            { target: 'G' },
            { target: 'G' },
            { on: 'E' },
            { issues: 'C' },
            { status: 'weird' },
            { resolution: 'r' },
        ]);
        expect(element(s, 'P').clauses.map(shape)).toEqual([{ ref: 'A.P' }, { target: 'G' }]);
        expect(element(s, 'H').clauses.map(shape)).toEqual([{ ref: 'A.H' }, { on: 'E' }, { on: 'Missing' }, { status: 'maybe' }, { resolution: 'x' }]);
        for (const id of ['X', 'Y', 'R']) expect(element(s, id).clauses[0]).toMatchObject({ type: 'ref' });
    });

    test('timeline steps may name anything (a command, a group, an unknown ID), and duplicates are kept', async () => {
        const [s] = await parseOne(wrap('event E\ncommand C\ntimeline T { C Unknown E E group G { E E C } }\ntimeline U { G }'));
        expect(timeline(s, 'T').steps).toMatchObject([
            { type: 'event', eventId: 'C' },
            { type: 'event', eventId: 'Unknown' },
            { type: 'event', eventId: 'E' },
            { type: 'event', eventId: 'E' },
            { type: 'group', id: 'G', events: [{ eventId: 'E' }, { eventId: 'E' }, { eventId: 'C' }] },
        ]);
        expect(timeline(s, 'U').steps).toMatchObject([{ type: 'event', eventId: 'G' }]);
    });

    test('duplicate IDs across kinds and stormings, and an empty timeline, parse', async () => {
        const stormings = await parseOne('storming S { event A\n command A\n timeline A {} }\nstorming S {}');
        expect(stormings.map((s) => s.elements.map((e) => e.kind))).toEqual([['event', 'command', 'timeline'], []]);
    });
});

describe('syntax errors (spec §11 Syntax: 不正なブロック, 未知の関係, 構文不備)', () => {
    test('an unknown clause keyword', async () => {
        const [d] = await syntaxErrors(wrap('command C {\n  sends E\n}'));
        expect(d.start.line).toBe(3);
    });

    test('anything other than event IDs and groups in a timeline, and other than event IDs in a group', async () => {
        await syntaxErrors(wrap('timeline T { ref A.B }'));
        await syntaxErrors(wrap('timeline T { event E }'));
        await syntaxErrors(wrap('timeline T { group G { group H { E } } }'));
        await syntaxErrors(wrap('timeline T { group G { emits E } }'));
    });

    test('ES13: a `ref` in a timeline or a group is a syntax error (the IR has no place for it)', async () => {
        const [inTimeline] = await syntaxErrors(wrap('event E\ntimeline T {\n  ref Delivery.ShipmentCancelled\n  E\n}'));
        expect(inTimeline.start).toEqual({ line: 4, column: 3 });
        const [inGroup] = await syntaxErrors(wrap('event E\ntimeline T {\n  group G {\n    E\n    ref Delivery.ShipmentCancelled\n  }\n}'));
        expect(inGroup.start).toEqual({ line: 6, column: 5 });
    });

    test('an empty group, a clause outside a body, a declaration outside a storming, a nested storming', async () => {
        await syntaxErrors(wrap('timeline T { group G {} }'));
        await syntaxErrors(wrap('emits E'));
        await syntaxErrors('event E');
        await syntaxErrors(wrap('storming Inner {}'));
        await syntaxErrors(wrap('event E { event F }'));
    });

    test('a keyword used as an ID, a missing ID, a dangling dot, an unclosed block, an unterminated string', async () => {
        await syntaxErrors(wrap('event target'));
        await syntaxErrors(wrap('command { target G }'));
        await syntaxErrors(wrap('command C { ref Delivery. }'));
        await syntaxErrors('storming S {\n  event E');
        const [d] = await syntaxErrors(wrap('event E "unterminated'));
        expect(d.start.line).toBe(2);
    });

    test('an unexpected end of file is named as such, not as an empty token', async () => {
        expect((await syntaxErrors('storming S {\n  event E')).map((d) => d.message)).toEqual(["Expecting token of type '}' but found end of file."]);
        expect((await syntaxErrors('storming S {\n  event')).map((d) => d.message)).toEqual(["Expecting token of type 'ID' but found end of file."]);
    });

    test('a file that does not parse gives no stormings; the others still do', async () => {
        const r = await parseStormings([
            { path: 'ok.dtes', text: 'storming Ok { event E }' },
            { path: 'bad.dtes', text: 'storming Bad { event }' },
        ]);
        expect(r.syntaxOk).toBe(false);
        expect(r.stormings.map((s) => s.id)).toEqual(['Ok']);
        expect(r.diagnostics.every((d) => d.file === 'bad.dtes' && d.code === 'SYNTAX')).toBe(true);
    });

    test('unknown local references are not syntax errors (S002 is the validator’s)', async () => {
        const [s] = await parseOne(wrap('command C { target Nowhere\n emits Nothing }'));
        expect(element(s, 'C').clauses.map(shape)).toEqual([{ target: 'Nowhere' }, { emits: 'Nothing' }]);
    });
});

describe('services: local references resolve within the storming, whatever the kind (for the LSP)', () => {
    async function build(text: string) {
        const { shared } = createStormingServices();
        const doc = shared.workspace.LangiumDocumentFactory.fromString<EsFile>(text, URI.parse('file:///w/a.dtes'));
        shared.workspace.LangiumDocuments.addDocument(doc);
        await shared.workspace.DocumentBuilder.build([doc]);
        return doc;
    }

    test('a relation resolves to any declaration of its storming, groups of timelines included', async () => {
        const doc = await build(
            'storming S {\n  aggregate G\n  command C { target G\n actor C\n emits Stage }\n  timeline T { group Stage { X } }\n}\nstorming O { event X }',
        );
        const [s] = doc.parseResult.value.stormings;
        const cmd = s.elements.find(isEsCommand)!;
        const targets = cmd.clauses.filter(isEsRelationClause).map((c) => c.target.ref?.$type);
        expect(targets).toEqual(['EsAggregate', 'EsCommand', 'EsGroup']);
        const tl = s.elements.find((e) => e.$type === 'EsTimeline');
        const step = tl && 'steps' in tl && tl.steps[0].$type === 'EsGroup' ? tl.steps[0].events[0] : undefined;
        // `X` is declared in another storming only: not visible
        expect(step?.event.ref).toBeUndefined();
        expect(toStormingIr(doc.parseResult.value, 'a.dtes').map((st) => st.id)).toEqual(['S', 'O']);
        expect(isEsStorming(doc.parseResult.value.stormings[1])).toBe(true);
    });
});

describe('lexer: terminals shared with .dt (spec §14 item 1)', () => {
    const terminals = (grammar: GrammarAST.Grammar) =>
        Object.fromEntries(
            grammar.rules.filter(GrammarAST.isTerminalRule).map((r) => [r.name, { hidden: r.hidden, regex: GrammarUtils.terminalRegex(r).source }]),
        );

    test('every .dtes terminal is the .dt one, verbatim and with the same hiddenness; only INT and DECIMAL are left out', () => {
        expect(EventStorming.Terminals).toEqual({ ...Domain.Terminals, INT: undefined, DECIMAL: undefined } as never);
        const es = terminals(EventStormingGrammar());
        const dt = terminals(DomainGrammar());
        expect(Object.keys(es).sort()).toEqual(['ID', 'ML_COMMENT', 'SL_COMMENT', 'STRING', 'WS']);
        for (const [name, t] of Object.entries(es)) expect(t).toEqual(dt[name]);
        expect(
            Object.keys(dt)
                .filter((n) => !(n in es))
                .sort(),
        ).toEqual(['DECIMAL', 'INT']);
    });

    test('tokens: IDs, strings with escapes, comments hidden, keywords', () => {
        const { EventStorming: es } = createStormingServices();
        const r = es.parser.Lexer.tokenize('storming _a1 "x\\"y" /* c */ { // line\n /// doc\n event E }');
        expect(r.errors).toEqual([]);
        expect(r.tokens.map((t) => [t.tokenType.name, t.image])).toEqual([
            ['storming', 'storming'],
            ['ID', '_a1'],
            ['STRING', '"x\\"y"'],
            ['{', '{'],
            ['event', 'event'],
            ['ID', 'E'],
            ['}', '}'],
        ]);
        expect(r.hidden.map((t) => t.image)).toEqual(['/* c */', '// line', '/// doc']);
        expect(es.parser.Lexer.tokenize('event 1E').errors.length).toBeGreaterThan(0);
    });
});
