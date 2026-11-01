import { describe, expect, test } from 'bun:test';
import { AstUtils, isReference, type AstNode, type CstNode, type Reference } from 'langium';
import { analyzeDomain, type DomainAnalysis } from '../../application/analyze.js';
import { check, exampleSources } from '../../test-helpers.js';
import type { ExprModel } from '../../domain/model.js';
import {
    commandsOf,
    statesOf,
    type AggregateDecl,
    type ElementDecl,
    type Expr,
    type FieldDecl,
    type PolicyDecl,
    type Ref,
    type Site,
    type SourceModel,
} from '../../domain/source-model.js';

/** Every construct of the language, in two files, with a shared context and references across them. */
const FIXTURE = {
    'common.dt': `/// 共通の型。
shared context Common "共通" {
  terms { amount: "金額" }
  primitive Amount: Decimal { value >= 0 }
  enum Currency { JPY "円", USD }
  value Money { amount: Amount  currency: Currency }
}
`,
    'sales.dt': `context Sales "販売" {
  terms { note: "備考" }
  id OrderId: UUID
  id CustomerId: UUID
  primitive Code: String { invariant shape "形" { matches(value, "^[A-Z]\\d+$") } invariant short { length(value) < 10 } }
  error NotFound { orderId: OrderId }
  error Missing
  verified KnownCustomer of CustomerId for Code? errors NotFound
  enum Kind { A B }
  union Detail by kind: Kind { A { x: Int } B { invariant ok "ok" } }
  union Shape { Round { r: Int } }
  fields Audit { createdAt: Timestamp }
  entity Line { id: LineId  qty: Int  price: Money }
  id LineId: UUID
  /// 注文。
  aggregate Order "注文" with Audit {
    id: OrderId
    owns lines: Line[0..*]
    references customer: CustomerId -> Customer
    note: String? "備考"
    invariant sane { count(lines) >= 0 and all(lines, l => l.qty > -1) implies not (note == "x") }
    create command place(id: OrderId, customer: KnownCustomer) -> Draft emits Placed
    state Draft
    state Done { at: Timestamp  invariant later { exists(note) or unique(lines, l => l.id) } }
    command finish(at: Timestamp) Draft -> Done
      requires hasLines "明細がある" { count(lines) > 0 and contains(lines, lines) and any(lines, l => l.qty in 1..2) } else Missing
      requires documented else Missing
      changes note, note
      emits Placed[0..*] when Draft -> Done, Unknown
      errors NotFound, Missing
  }
  aggregate Customer { id: CustomerId }
  aggregate Order { id: OrderId }
  persistent event Placed { orderId: OrderId  amount: Common.Amount  total: Money }
  policy React when Placed -> Order.finish
}
`,
};

/** The source range of a CST node as a site's range (1-based). */
const rangeOf = (cst: CstNode | undefined): Pick<Site, 'start' | 'end'> => {
    const r = cst!.range;
    return { start: { line: r.start.line + 1, column: r.start.character + 1 }, end: { line: r.end.line + 1, column: r.end.character + 1 } };
};
const rangeKey = (file: string, r: Pick<Site, 'start' | 'end'>): string => `${file}:${r.start.line}:${r.start.column}-${r.end.line}:${r.end.column}`;
const siteRange = (s: Site): string => rangeKey(s.file, s);

/** Every value of the model as written that `pick` selects, at any depth, without following references. */
function collect<T>(model: SourceModel, pick: (value: object) => value is T & object): T[] {
    const out: T[] = [];
    const seen = new Set<object>();
    const visit = (value: unknown, key: string): void => {
        if (!value || typeof value !== 'object' || seen.has(value) || key === 'target' || key === 'byName') return;
        seen.add(value);
        if (!Array.isArray(value) && pick(value)) out.push(value);
        for (const [k, v] of Object.entries(value)) visit(v, k);
    };
    visit(model, '');
    return out;
}
const isRef = (v: object): v is Ref<unknown> => 'text' in v && 'at' in v && !('k' in v);

/** The AST nodes of the documents, in order. */
const nodesOf = (a: DomainAnalysis): AstNode[] => a.documents.flatMap((d) => [...AstUtils.streamAllContents(d.parseResult.value)]);
const fileOf = (a: DomainAnalysis, node: AstNode): string => a.resolveFile(AstUtils.getDocument(node).uri.toString());

/** What the Typed Model writes for an expression: the tree without its sites. */
/** The operators as written, as the Typed Model names them. */
const OPS = { implies: 'implies', or: 'or', and: 'and', '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' } as const;

function toExprModel(e: Expr): ExprModel {
    switch (e.k) {
        case 'bool':
        case 'string':
            return { k: e.k, value: e.value } as ExprModel;
        case 'int':
            return { k: 'int', value: e.negative ? -e.value : e.value };
        case 'decimal':
            return { k: 'decimal', value: `${e.negative ? '-' : ''}${e.value}` };
        case 'name':
            return { k: 'name', name: e.name };
        case 'member':
            return { k: 'member', receiver: toExprModel(e.receiver), member: e.member };
        case 'not':
            return { k: 'not', operand: toExprModel(e.operand) };
        case 'binary':
            return { k: 'binary', op: OPS[e.op], left: toExprModel(e.left), right: toExprModel(e.right) };
        case 'range':
            return { k: 'range', operand: toExprModel(e.operand), lower: toExprModel(e.lower), upper: toExprModel(e.upper) };
        case 'count':
            return { k: 'count', collection: toExprModel(e.collection) };
        case 'exists':
        case 'length':
            return { k: e.k, operand: toExprModel(e.operand) };
        case 'matches':
            return { k: 'matches', operand: toExprModel(e.operand), pattern: e.pattern };
        case 'unique':
            return { k: 'unique', collection: toExprModel(e.collection), ...(e.param && { param: e.param }), keys: e.keys.map(toExprModel) };
        case 'contains':
            return { k: 'contains', collection: toExprModel(e.collection), element: toExprModel(e.element) };
        case 'quantifier':
            return { k: 'quantifier', quantifier: e.quantifier, collection: toExprModel(e.collection), param: e.param, body: toExprModel(e.body) };
    }
}

const sources = async (): Promise<[string, DomainAnalysis][]> => [
    ['examples/shop', await analyzeDomain(await exampleSources())],
    ['the fixture', await analyzeDomain(Object.entries(FIXTURE).map(([path, text]) => ({ path, text })))],
];

describe('the model as written', () => {
    test('is built when the sources parse, and not otherwise', async () => {
        const [[, shop]] = await sources();
        expect(shop.sourceModel).toBeDefined();
        const broken = await analyzeDomain([{ path: 'a.dt', text: 'context A { aggregate }' }]);
        expect(broken.syntaxOk).toBe(false);
        expect(broken.sourceModel).toBeUndefined();
    });

    test('has a site at the range of every element, member, expression and type reference of the sources', async () => {
        for (const [, a] of await sources()) {
            const sites = new Set(collect(a.sourceModel!, (v): v is { at: Site } => 'at' in v && !isRef(v)).map((x) => siteRange(x.at)));
            // the AST nodes that are no declaration of their own: a terms block, a lambda's parameter, a multiplicity
            const nodes = nodesOf(a).filter((n) => !['Terms', 'LambdaParam', 'Multiplicity'].includes(n.$type));
            expect(nodes.length).toBeGreaterThan(100);
            const missing = nodes.filter((n) => !sites.has(rangeKey(fileOf(a, n), rangeOf(n.$cstNode)))).map((n) => n.$type);
            expect(missing).toEqual([]);
        }
    });

    test('has every reference as written, at its name, resolved to the declaration it names', async () => {
        for (const [, a] of await sources()) {
            const refs = collect(a.sourceModel!, isRef);
            const byRange = new Map(refs.map((r) => [siteRange(r.at), r]));
            const astRefs = nodesOf(a).flatMap((n) =>
                Object.values(n)
                    .flat()
                    .filter((v): v is Reference => isReference(v))
                    .map((r) => ({ r, file: fileOf(a, n) })),
            );
            expect(astRefs.length).toBe(refs.length);
            for (const { r, file } of astRefs) {
                const ref = byRange.get(rangeKey(file, rangeOf(r.$refNode)));
                expect(ref?.text).toBe(r.$refText);
                const target = ref?.target as { at: Site } | undefined;
                if (!r.ref) expect(target).toBeUndefined();
                else expect(target && siteRange(target.at)).toBe(rangeKey(fileOf(a, r.ref), rangeOf(r.ref.$cstNode)));
            }
        }
    });

    test('has the expression trees of the Typed Model', async () => {
        for (const [, a] of await sources()) {
            const written = a.sourceModel!.elements.flatMap((el) =>
                el.kind === 'aggregate'
                    ? [
                          ...el.members.flatMap((m) =>
                              m.kind === 'invariant' ? [m.expr] : m.kind === 'state' ? m.members.map((x) => (x.kind === 'invariant' ? x.expr : undefined)) : [],
                          ),
                          ...commandsOf(el).flatMap((c) => c.requirements.map((r) => r.expr)),
                      ].filter((e): e is Expr => !!e)
                    : [],
            );
            const typed = a.model!.elements.flatMap((el) =>
                el.kind === 'aggregate'
                    ? [...el.invariants, ...el.states.flatMap((s) => s.invariants), ...el.commands.flatMap((c) => c.requires)].flatMap((x) =>
                          x.expr ? [x.expr] : [],
                      )
                    : [],
            );
            expect(written.map(toExprModel)).toEqual(typed);
            expect(written.length).toBeGreaterThan(2);
        }
    });
});

describe('the fixture as written', () => {
    const model = async (): Promise<SourceModel> => (await check(FIXTURE)).sourceModel!;
    const named = (m: SourceModel, id: string): ElementDecl => m.byName.get(id)![0];

    test('keeps the fragments, terms and every element in order, duplicates included', async () => {
        const m = await model();
        expect(m.fragments.map((f) => [f.name, f.shared, f.label, f.doc, f.terms.map((t) => [t.name, t.label])])).toEqual([
            ['Common', true, '共通', '共通の型。', [['amount', '金額']]],
            ['Sales', false, '販売', undefined, [['note', '備考']]],
        ]);
        expect(m.contexts).toEqual(['Common', 'Sales']);
        expect(m.sharedContexts).toEqual(['Common']);
        expect(m.elements.filter((e) => e.id === 'Sales.Order').length).toBe(2);
        expect(m.byName.get('Sales.Order')!.length).toBe(2);
        expect(m.elements.map((e) => e.kind).slice(0, 6)).toEqual(['primitive', 'enum', 'valueObject', 'id', 'id', 'primitive']);
    });

    test('resolves references to the declarations themselves', async () => {
        const m = await model();
        const order = named(m, 'Sales.Order') as AggregateDecl;
        const [, second] = m.byName.get('Sales.Order')!;
        const policy = named(m, 'Sales.React') as PolicyDecl;
        // the first of a name is the one references resolve to
        expect(policy.aggregate.target).toBe(order);
        expect(policy.aggregate.target).not.toBe(second);
        expect(policy.command.target).toBe(commandsOf(order).find((c) => c.name === 'finish'));
        expect(policy.event.target).toBe(named(m, 'Sales.Placed') as never);
        const customer = order.members.find((f) => f.name === 'customer') as FieldDecl;
        expect(customer.kind).toBe('references');
        expect(customer.aggregate?.target).toBe(named(m, 'Sales.Customer') as never);
        expect(customer.type?.decl?.target).toBe(named(m, 'Sales.CustomerId') as never);
        const placed = named(m, 'Sales.Placed');
        expect(placed.kind === 'event' && placed.members[1].type?.decl?.target).toBe(named(m, 'Common.Amount') as never);
        expect(placed.kind === 'event' && placed.members[2].type?.decl?.target).toBe(named(m, 'Common.Money') as never);
        const [draft, done] = statesOf(order);
        const finish = commandsOf(order).find((c) => c.name === 'finish')!;
        expect(finish.transitions[0].from[0].target).toBe(draft);
        expect(finish.transitions[0].to[0].target).toBe(done);
        expect(finish.emits[0].when?.to[0].target).toBe(done);
        // unresolved: as written, without a target
        expect(finish.emits[1].event).toMatchObject({ text: 'Unknown' });
        expect(finish.emits[1].event.target).toBeUndefined();
        expect(order.fieldSets.map((r) => r.target)).toEqual([named(m, 'Sales.Audit') as never]);
        const detail = named(m, 'Sales.Detail');
        expect(detail.kind === 'union' && detail.tagType?.target).toBe(named(m, 'Sales.Kind') as never);
        const known = named(m, 'Sales.KnownCustomer');
        if (known.kind !== 'verified') throw new Error('not verified');
        expect<unknown[]>([known.base?.decl?.target, known.for?.decl?.target, known.forOptional, known.errors[0].target]).toEqual([
            named(m, 'Sales.CustomerId'),
            named(m, 'Sales.Code'),
            true,
            named(m, 'Sales.NotFound'),
        ]);
    });

    test('puts each site on what a diagnostic points at, with the element it lies in', async () => {
        const m = await model();
        const at = (s: Site): string => `${s.start.line}:${s.start.column}-${s.end.line}:${s.end.column} ${s.elementId}`;
        const order = named(m, 'Sales.Order') as AggregateDecl;
        expect(at(order.nameAt)).toBe('16:13-16:18 Sales.Order');
        expect(at(order.labelAt)).toBe('16:19-16:23 Sales.Order');
        expect(at(order.fieldSets[0].at)).toBe('16:29-16:34 Sales.Order');
        const note = order.members.find((f) => f.name === 'note') as FieldDecl;
        expect([at(note.nameAt), at(note.typeAt), at(note.labelAt)]).toEqual(['20:5-20:9 Sales.Order', '20:11-20:17 Sales.Order', '20:19-20:23 Sales.Order']);
        const finish = commandsOf(order).find((c) => c.name === 'finish')!;
        expect(at(finish.nameAt)).toBe('25:13-25:19 Sales.Order:finish');
        expect(finish.changes.map((c) => at(c.at))).toEqual(['28:15-28:19 Sales.Order:finish', '28:21-28:25 Sales.Order:finish']);
        expect(at(finish.errors[1].at)).toBe('30:24-30:31 Sales.Order:finish');
        const [, done] = statesOf(order);
        expect(at(done.nameAt)).toBe('24:11-24:15 Sales.Order#Done');
        expect(at(m.fragments[1].terms[0].nameAt)).toBe('2:11-2:15 Sales');
        // a declaration without a label: the label's site is the whole declaration
        expect(at(done.labelAt)).toBe(at(done.at));
    });

    test('has the parts of each expression and its text', async () => {
        const m = await model();
        const code = named(m, 'Sales.Code');
        const shape = code.kind === 'primitive' ? code.invariants[0].expr : undefined;
        expect(shape).toMatchObject({ k: 'matches', pattern: '^[A-Z]\\d+$', text: 'matches(value, "^[A-Z]\\d+$")' });
        const order = named(m, 'Sales.Order') as AggregateDecl;
        const sane = order.members.find((x) => x.name === 'sane');
        const e = sane?.kind === 'invariant' ? sane.expr : undefined;
        expect(e?.k).toBe('binary');
        expect(e?.text).toBe('count(lines) >= 0 and all(lines, l => l.qty > -1) implies not (note == "x")');
        if (e?.k !== 'binary') return;
        expect(e.op).toBe('implies');
        expect(toExprModel(e.right)).toEqual({
            k: 'not',
            operand: { k: 'binary', op: 'eq', left: { k: 'name', name: 'note' }, right: { k: 'string', value: 'x' } },
        });
        const finish = commandsOf(order).find((c) => c.name === 'finish')!;
        expect(finish.requirements.map((r) => [r.name, r.label, r.expr?.k, r.error.text])).toEqual([
            ['hasLines', '明細がある', 'binary', 'Missing'],
            ['documented', undefined, undefined, 'Missing'],
        ]);
    });
});
