import * as posix from 'node:path/posix';
import type { AggregateModel, CommandModel, DomainModel, ElementModel, ExprModel, FieldModel, InvariantModel, PolicyElement } from '@domaintrail/modeling';
import { applicableOutcomes, BINARY_OP_TEXT, contextNames, elementOf, elementsIn, fieldsOf, invariantsOf, statesOf, variantsOf } from '@domaintrail/modeling';
import type { DomainPrimitive } from './checks.js';
import {
    aggregateInvariants,
    checkName,
    checkWithName,
    declaredChecksName,
    declaredRequiresName,
    hasDeclared,
    primitiveInvariants,
    quote,
    requiresName,
    requiresWithName,
    unionInvariants,
} from './checks.js';
import { aggregateParamName, choiceCheckName, commandTypeName, commandsInterfaceName, makeTypeName, policyHandlersName, stateTypeName } from './naming.js';
import type { PolicyMode } from './typescript.js';
// the version of domaintrail, which the generated tests state (outside the package: the root package is domaintrail)
import { version as VERSION } from '../../../../package.json' with { type: 'json' };

/** The test runners `dt` writes an adapter for (`generate.ts.tests.runner`). */
export const RUNNERS = ['bun', 'vitest', 'jest', 'node'] as const;
export type Runner = (typeof RUNNERS)[number];

export interface TestsOptions {
    /** Directory of the test modules (`/`-separated, relative to the output root). */
    dir: string;
    runner?: Runner;
    /** The mode of each context's policies (absent: `optional`); `required` adds `policies` to `contract(impl)`. */
    policies?: Readonly<Record<string, PolicyMode>>;
    /** The directory of the test modules of the contexts written elsewhere than `dir` (into another package), by context. */
    dirs?: Readonly<Record<string, string>>;
    /**
     * The modules of the contexts written into another package (`generate.ts.contexts.<Ctx>.module`): the tests of
     * another directory import their tests from `<module>/tests` (ADR 0028).
     */
    modules?: Readonly<Record<string, string>>;
    /** How deep values of recursive types go (absent: `DEFAULT_MAX_RECURSION_DEPTH`). */
    maxRecursionDepth?: number;
    /** Per type, by qualified name: its own `maxRecursionDepth`. */
    types?: TypeTestsOptions;
}

interface File {
    path: string;
    content: string;
}

/** The generic helpers of the tests, the same for every model: shipped with domaintrail (ADR 0028, decision 5). */
const TESTING = 'domaintrail/testing';

/** `register(suite)` per runner: one `describe` per suite, one test per case. */
const ADAPTERS: Record<Runner, string> = {
    bun: `import { describe, test } from 'bun:test';`,
    vitest: `import { describe, test } from 'vitest';`,
    jest: `import { describe, test } from '@jest/globals';`,
    node: `import { describe, test } from 'node:test';`,
};

function adapter(header: string, runner: Runner): string {
    const todo = runner === 'node' ? `test(c.name, { todo: true })` : `test.todo(c.name)`;
    // not at the start of a line of this file, which the architecture test would read as an import of this module
    const imports = [ADAPTERS[runner], `import { isSuite, type Suite } from '${TESTING}';`];
    return `${header}
${imports.join('\n')}

/** Registers the cases of a generated suite with ${runner === 'node' ? 'node:test' : runner}: a \`describe\` per suite, a test per case. */
export function register(suite: Suite): void {
    describe(suite.name, () => {
        for (const c of suite.children) {
            if (isSuite(c)) register(c);
            else if (c.todo) ${todo};
            else test(c.name, () => c.run());
        }
    });
}
`;
}

/** The types whose arbitraries an element's arbitrary is made of (qualified names): those of its fields, its base. */
function arbitraryParts(el: ElementModel): string[] {
    const fields = [...fieldsOf(el), ...statesOf(el).flatMap((s) => s.fields), ...variantsOf(el).flatMap((v) => v.fields)];
    const types = [...fields.map((f) => f.type), ...(el.kind === 'verified' ? [el.verified.of] : [])];
    return types.flatMap((t) => (t.kind === 'ref' ? [t.ref] : []));
}

/** `generate.ts.tests.maxRecursionDepth` when not configured: a binary tree of depth 4 has at most 15 nodes. */
export const DEFAULT_MAX_RECURSION_DEPTH = 4;

/** The per-type settings of the contract tests (`generate.ts.tests.types`), by qualified type name. */
export type TypeTestsOptions = Readonly<Record<string, { readonly maxRecursionDepth?: number }>>;

/**
 * Types on one cycle of field types (M012 lets value objects and unions be recursive), whose arbitraries are defined
 * together (ADR 0028, decision 8).
 */
export interface Cycle {
    /** Its first type in declaration order (qualified), which names it. */
    readonly id: string;
    /** Its types, qualified, in declaration order (possibly of several contexts). */
    readonly members: readonly string[];
    /** The greatest depth its types ask for (`types.<T>.maxRecursionDepth`, else `maxRecursionDepth`). */
    readonly maxRecursionDepth: number;
    /** Per union of the cycle, the variant drawn once the depth is reached: one whose values end the cycle. */
    readonly ending: ReadonlyMap<string, string>;
}

/** Whether a field of a type on a cycle may end it: not of a type of the cycle, optional, or a list that may be empty. */
const endsCycle = (f: FieldModel, members: ReadonlySet<string>): boolean =>
    f.type.kind !== 'ref' || !members.has(f.type.ref) || f.cardinality === 'optional' || bounds(f).lower === 0;

/**
 * The cycles of the model's types, by each of their types (qualified names). A cycle uses the greatest of the depths
 * of its types: a per-type setting asks to reach at least that depth.
 */
export function recursiveCycles(model: DomainModel, maxRecursionDepth: number = DEFAULT_MAX_RECURSION_DEPTH, types: TypeTestsOptions = {}): Map<string, Cycle> {
    const parts = new Map<string, string[]>(model.elements.map((e) => [e.id, arbitraryParts(e)]));
    // Tarjan's strongly connected components of the graph of parts
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const components: string[][] = [];
    const visit = (id: string): void => {
        index.set(id, index.size);
        low.set(id, index.get(id)!);
        stack.push(id);
        for (const next of parts.get(id) ?? []) {
            if (!parts.has(next)) continue;
            if (!index.has(next)) {
                visit(next);
                low.set(id, Math.min(low.get(id)!, low.get(next)!));
            } else if (stack.includes(next)) low.set(id, Math.min(low.get(id)!, index.get(next)!));
        }
        if (low.get(id) !== index.get(id)) return;
        const component: string[] = [];
        for (let top = stack.pop()!; ; top = stack.pop()!) {
            component.push(top);
            if (top === id) break;
        }
        components.push(component);
    };
    for (const id of parts.keys()) if (!index.has(id)) visit(id);
    const order = new Map([...parts.keys()].map((id, i) => [id, i]));
    const out = new Map<string, Cycle>();
    for (const component of components) {
        if (component.length === 1 && !parts.get(component[0])!.includes(component[0])) continue;
        const members = component.sort((x, y) => order.get(x)! - order.get(y)!);
        const set = new Set(members);
        const els = members.map((id) => elementOf(model, id)!);
        // the types whose values end the cycle once the depth is reached, as M012 finds that they have a finite value
        const ended = new Set<string>();
        const ending = new Map<string, string>();
        const ends = (fields: readonly FieldModel[]): boolean => fields.every((f) => endsCycle(f, set) || (f.type.kind === 'ref' && ended.has(f.type.ref)));
        for (let grew = true; grew;) {
            grew = false;
            for (const el of els) {
                if (ended.has(el.id)) continue;
                const variant = el.kind === 'union' ? el.variants.find((v) => ends(v.fields)) : undefined;
                if (el.kind === 'union' ? !variant : !ends(fieldsOf(el))) continue;
                if (variant) ending.set(el.id, variant.name);
                ended.add(el.id);
                grew = true;
            }
        }
        const depth = Math.max(...members.map((id) => types[id]?.maxRecursionDepth ?? maxRecursionDepth));
        const cycle: Cycle = { id: members[0], members, maxRecursionDepth: depth, ending };
        for (const id of members) out.set(id, cycle);
    }
    return out;
}

/**
 * The warnings of `dt generate ts` about the contract tests: a type in `generate.ts.tests.types` that is on no cycle,
 * whose `maxRecursionDepth` is then unused (a name that is no type of the model is a configuration error).
 */
export function testsWarnings(model: DomainModel, types: TypeTestsOptions = {}): string[] {
    const cycles = recursiveCycles(model);
    const unused = Object.keys(types).filter((t) => elementOf(model, t) && !cycles.has(t));
    return unused.map((t) => `'generate.ts.tests.types' names '${t}', which is not a recursive type: its 'maxRecursionDepth' is not used.`);
}

/**
 * The contract tests (ADR 0020): per context a module with fast-check arbitraries of its types and `contract(impl)`,
 * the runner-agnostic suite, an index, and an adapter for the runner if one is configured. The generic helpers are
 * `domaintrail/testing`, which each module imports and, when loaded, checks to be compatible with the version of
 * domaintrail that generated it. `moduleOf(from, ctx)` is the import specifier of a context's module from directory
 * `from`.
 */
export function generateTests(model: DomainModel, header: string, opts: TestsOptions, moduleOf: (from: string, ctx: string) => string): File[] {
    const cycles = recursiveCycles(model, opts.maxRecursionDepth, opts.types);
    const dirOf = (ctx: string): string => posix.normalize(opts.dirs?.[ctx] ?? opts.dir);
    // the tests of another context: next to these, from its package (`<module>/tests`), or by relative path
    const testsOf = (from: string, ctx: string): string => {
        if (dirOf(ctx) === from) return `./${ctx}.js`;
        if (opts.modules?.[ctx]) return `${opts.modules[ctx]}/tests`;
        const rel = posix.relative(from, dirOf(ctx));
        return `${rel.startsWith('../') ? '' : './'}${rel}/${ctx}.js`;
    };
    const files: File[] = [];
    for (const dir of new Set(contextNames(model).map(dirOf))) {
        const contexts: string[] = contextNames(model).filter((c) => dirOf(c) === dir);
        for (const ctx of contexts) {
            files.push({
                path: posix.join(dir, `${ctx}.ts`),
                content: new TestsEmitter(
                    model,
                    ctx,
                    header,
                    (c) => moduleOf(dir, c),
                    opts.policies?.[ctx] === 'required',
                    cycles,
                    (c) => testsOf(dir, c),
                    (c) => contexts.includes(c),
                ).emit(),
            });
        }
        if (opts.runner) files.push({ path: posix.join(dir, '_register.ts'), content: adapter(header, opts.runner) });
        const index = [
            header,
            ...(opts.runner ? [`export { register } from './_register.js';`] : []),
            ...contexts.map((c) => `export * as ${c} from './${c}.js';`),
            '',
        ];
        files.push({ path: posix.join(dir, 'index.ts'), content: index.join('\n') });
    }
    return files;
}

/** Bounds read from the invariants of a domain primitive (`value in 1..999`, `length(value) <= 8`, `matches`). */
export function hintsOf(invs: readonly InvariantModel[]): Record<string, number | string> {
    const h: Record<string, number | string> = {};
    const num = (e: ExprModel): number | undefined => (e.k === 'int' ? e.value : e.k === 'decimal' ? Number(e.value) : undefined);
    const isValue = (e: ExprModel): boolean => e.k === 'name' && e.name === 'value';
    const isLength = (e: ExprModel): boolean => e.k === 'length' && isValue(e.operand);
    const set = (key: string, v: number | undefined, keep: (a: number, b: number) => number): void => {
        if (v === undefined) return;
        const was = h[key];
        h[key] = typeof was === 'number' ? keep(was, v) : v;
    };
    const flip: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' };
    const bound = (subject: 'value' | 'length', op: string, v: number | undefined): void => {
        const [lo, hi] =
            subject === 'value'
                ? [
                      ['ge', 'gt'],
                      ['le', 'lt'],
                  ]
                : [
                      ['minLength', 'minLength'],
                      ['maxLength', 'maxLength'],
                  ];
        const strict = subject === 'length' && v !== undefined ? 1 : 0;
        if (op === '>=') set(lo[0], v, Math.max);
        else if (op === '>') set(lo[1], v === undefined ? v : v + strict, Math.max);
        else if (op === '<=') set(hi[0], v, Math.min);
        else if (op === '<') set(hi[1], v === undefined ? v : v - strict, Math.min);
        else if (op === '==') {
            set(lo[0], v, Math.max);
            set(hi[0], v, Math.min);
        }
    };
    const visit = (e: ExprModel): void => {
        if (e.k === 'binary' && e.op === 'and') {
            visit(e.left);
            visit(e.right);
        } else if (e.k === 'range' && (isValue(e.operand) || isLength(e.operand))) {
            const s = isValue(e.operand) ? 'value' : 'length';
            bound(s, '>=', num(e.lower));
            bound(s, '<=', num(e.upper));
        } else if (e.k === 'binary' && BINARY_OP_TEXT[e.op] in flip) {
            const text = BINARY_OP_TEXT[e.op];
            for (const [x, y, op] of [
                [e.left, e.right, text],
                [e.right, e.left, flip[text]],
            ] as const) {
                if (isValue(x)) bound('value', op, num(y));
                else if (isLength(x)) bound('length', op, num(y));
            }
        } else if (e.k === 'binary' && e.op === 'eq') {
            if (isLength(e.left)) bound('length', '==', num(e.right));
        } else if (e.k === 'matches' && isValue(e.operand) && !('pattern' in h)) {
            h.pattern = e.pattern;
        }
    };
    for (const i of invs) if (i.expr) visit(i.expr);
    return h;
}

const literal = (h: Record<string, number | string>): string =>
    `{ ${Object.entries(h)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? quote(v) : String(v)}`)
        .join(', ')} }`.replace('{  }', '{}');

/** `lower` and `upper` of a field's multiplicity (`upper` absent: unbounded). */
function bounds(f: FieldModel): { lower: number; upper?: number } {
    const m = /^\[(\d+)\.\.(\d+|\*)\]$/.exec(f.multiplicity);
    if (m) return { lower: Number(m[1]), ...(m[2] !== '*' && { upper: Number(m[2]) }) };
    return f.cardinality === 'nonEmpty' ? { lower: 1 } : { lower: 0 };
}

/** How often an `emits` entry emits its event, when the types do not express it (other than `?`, `[0..*]`, `[1..*]`). */
const counted = (e: { lower: number; upper?: number }): boolean =>
    !((e.lower === 1 && e.upper === 1) || (e.lower === 0 && e.upper === 1) || (e.lower <= 1 && e.upper === undefined));

class TestsEmitter {
    private readonly els: ElementModel[];
    /** Other contexts whose arbitraries are used. */
    private readonly others = new Set<string>();
    /** Contexts whose types the policy cases check. */
    private readonly checked = new Set<string>();
    /** The cycle whose arbitraries are being written: its types are `tie`d, and its ends drawn with the depth. */
    private cycle: Cycle | undefined;

    constructor(
        private readonly model: DomainModel,
        private readonly ctx: string,
        private readonly header: string,
        private readonly moduleOf: (ctx: string) => string,
        /** Whether the context's policies are required: `contract` then tests their handlers. */
        private readonly policiesRequired: boolean,
        /** The cycles of recursive types (`recursiveCycles`), by each of their types. */
        private readonly cycles: ReadonlyMap<string, Cycle> = new Map(),
        /** Import specifier of another context's tests. */
        private readonly testsOf: (ctx: string) => string = (c) => `./${c}.js`,
        /** Whether another context's tests are in the same directory as these. */
        private readonly nextTo: (ctx: string) => boolean = () => true,
    ) {
        this.els = elementsIn(model, ctx);
    }

    private type(name: string): string {
        return `${this.ctx}.${name}`;
    }

    /** The arbitrary of a type by qualified name. */
    private arb(qname: string): string {
        const [c, name] = [qname.slice(0, qname.indexOf('.')), qname.slice(qname.indexOf('.') + 1)];
        if (c === this.ctx) return `a.${name}`;
        this.others.add(c);
        return `${c}Arbs().${name}`;
    }

    private baseArb(f: FieldModel): string {
        if (f.type.kind === 'primitive') return `testing.cast<${this.tsBase(f.type.name)}>(scalar.${f.type.name})`;
        if (this.onCycle(f)) {
            const el = elementOf(this.model, f.type.ref);
            // a type of the cycle in another context: asked for when drawn (that context's arbitraries use this one's)
            return el?.context === this.ctx ? `tie('${el.name}')` : `testing.defer(() => ${this.arb(f.type.ref)})`;
        }
        return this.arb(f.type.ref);
    }

    /** Whether a field holds a type of the cycle being written. */
    private onCycle(f: FieldModel): boolean {
        return f.type.kind === 'ref' && !!this.cycle?.members.includes(f.type.ref);
    }

    /** An optional field of the cycle: drawn with the depth, absent once it is reached (in a `compact`ed record). */
    private optionalAt(f: FieldModel): boolean {
        return f.cardinality === 'optional' && this.onCycle(f);
    }

    private tsBase(name: string): string {
        return { String: 'string', Int: 'number', Decimal: 'Decimal', Bool: 'boolean', Timestamp: 'Date', UUID: 'string' }[name] ?? 'unknown';
    }

    /** The arbitrary of a field in a record (optional fields are left out of `requiredKeys`, or drawn with the depth). */
    private fieldArb(f: FieldModel): string {
        const b = this.baseArb(f);
        if (f.cardinality === 'one') return b;
        if (this.optionalAt(f)) return `testing.optionalAt(depth, ${b})`;
        if (f.cardinality === 'optional') return b;
        const { lower, upper } = bounds(f);
        if (lower === 0 && this.onCycle(f)) return `testing.manyAt(depth, ${b}${upper !== undefined ? `, ${upper}` : ''})`;
        return `testing.many(${b}, ${lower}${upper !== undefined ? `, ${upper}` : ''})`;
    }

    private record(head: string[], fields: readonly FieldModel[]): string {
        const props = [...head, ...fields.map((f) => `${f.name}: ${this.fieldArb(f)}`)];
        const isOptional = (f: FieldModel): boolean => f.cardinality === 'optional' && !this.optionalAt(f);
        const optional = fields.some(isOptional);
        const required = [...head.map((h) => h.slice(0, h.indexOf(':'))), ...fields.filter((f) => !isOptional(f)).map((f) => f.name)];
        const record = `fc.record({ ${props.join(', ')} }${optional ? `, { requiredKeys: [${required.map((n) => `'${n}'`).join(', ')}] }` : ''})`;
        return fields.some((f) => this.optionalAt(f)) ? `testing.compact(${record})` : record;
    }

    /** `(v) => <check>(v).length === 0`, with the declared checks of the options (others assumed to hold). */
    private holds(typeName: string, checkOwner: string, invs: readonly InvariantModel[]): string {
        return `(v) => ${this.violated(typeName, checkOwner, invs)}(v).length === 0`;
    }

    private violated(typeName: string, checkOwner: string, invs: readonly InvariantModel[]): string {
        if (!hasDeclared(invs)) return `${this.ctx}.${checkName(typeName)}`;
        const names = invs.filter((i) => !i.expr).map((i) => `'${i.name}'`);
        return `${this.ctx}.${checkWithName(typeName)}(testing.declared<${this.ctx}.${declaredChecksName(checkOwner)}>([${names.join(', ')}], declared.${checkOwner}))`;
    }

    /** The name of the arbitraries of a cycle's types in this context (`testing.recursive`). */
    private cycleName(cycle: Cycle): string {
        const first = cycle.members.map((id) => elementOf(this.model, id)!).find((el) => el.context === this.ctx)!;
        return `cycle${first.name}`;
    }

    /**
     * The entries of `Arbitraries`, their definitions, and those of the cycles of recursive types: the arbitraries of a
     * cycle's types are built together (`testing.recursive`), and the entries read them from there.
     */
    private arbitraries(): { members: string[]; defs: string[]; cycles: string[] } {
        const members: string[] = [];
        const defs: string[] = [];
        const cycles: string[] = [];
        const written = new Set<Cycle>();
        for (const el of this.els) {
            const cycle = this.cycles.get(el.id);
            if (!cycle) {
                this.define(el, (name, def) => {
                    members.push(`readonly ${name}: fc.Arbitrary<${this.type(name)}>;`);
                    defs.push(`${name}: () => ${def},`);
                });
                continue;
            }
            members.push(`readonly ${el.name}: fc.Arbitrary<${this.type(el.name)}>;`);
            defs.push(`${el.name}: () => ${this.cycleName(cycle)}().${el.name},`);
            if (written.has(cycle)) continue;
            written.add(cycle);
            cycles.push(this.cycleDef(cycle));
        }
        return { members, defs, cycles };
    }

    /** The arbitraries of a cycle's types in this context, built together with `fc.letrec`. */
    private cycleDef(cycle: Cycle): string {
        const els = cycle.members.map((id) => elementOf(this.model, id)!).filter((el) => el.context === this.ctx);
        const entries: string[] = [];
        this.cycle = cycle;
        for (const el of els) this.define(el, (name, def) => entries.push(`    ${name}: ${def},`));
        this.cycle = undefined;
        const text = entries.join('\n');
        const params = `${/\btie\(/.test(text) ? 'tie' : '_tie'}, ${/\bdepth\b/.test(text) ? 'depth' : '_depth'}`;
        const types = els.map((el) => `${el.name}: ${this.type(el.name)}`).join('; ');
        return `const ${this.cycleName(cycle)} = testing.recursive<{ ${types} }>('${cycle.id}', ${cycle.maxRecursionDepth}, (${params}) => ({\n${text}\n}));`;
    }

    /** The arbitraries an element defines (an aggregate's per state, too), passed to `add` with their names. */
    private define(el: ElementModel, add: (name: string, def: string) => void): void {
        const ctx = this.ctx;
        const valid = (name: string, raw: string, holds: string | undefined): string =>
            holds ? `testing.valid(given.${name} ?? ${raw}, ${holds}, '${ctx}.${name}')` : `given.${name} ?? ${raw}`;
        {
            switch (el.kind) {
                case 'id':
                case 'primitive': {
                    const raw = `testing.collide(testing.cast<${this.type(el.name)}>(testing.base('${el.base}', ${literal(hintsOf(el.invariants))})), seed)`;
                    const invs = primitiveInvariants(el);
                    add(el.name, valid(el.name, raw, invs.length ? this.holds(el.name, el.name, invs) : undefined));
                    break;
                }
                case 'verified': {
                    // the check is the factory's, outside the contract tests: any value of the base passed it
                    const base = this.baseArb({ name: el.name, kind: 'param', type: el.verified.of, cardinality: 'one', multiplicity: '' });
                    add(el.name, `given.${el.name} ?? testing.cast<${this.type(el.name)}>(${base})`);
                    break;
                }
                case 'event':
                    add(
                        el.name,
                        `given.${el.name} ?? testing.cast<${this.type(el.name)}>(${this.record([`type: fc.constant('${el.name}' as const)`], el.fields)})`,
                    );
                    break;
                case 'enum':
                    add(
                        el.name,
                        `given.${el.name} ?? ${el.values.length ? `fc.constantFrom<${this.type(el.name)}>(${el.values.map((v) => `'${v.name}'`).join(', ')})` : `fc.constant(undefined as never)`}`,
                    );
                    break;
                case 'valueObject':
                case 'entity': {
                    const raw = `testing.cast<${this.type(el.name)}>(${this.record([], el.fields)})`;
                    add(el.name, valid(el.name, raw, el.invariants.length ? this.holds(el.name, el.name, el.invariants) : undefined));
                    break;
                }
                case 'union': {
                    const tag = el.discriminator;
                    // on a cycle, the variant that ends it comes first: the one drawn once the depth is reached
                    const ending = this.cycle?.ending.get(el.id);
                    const ordered = ending ? [...el.variants.filter((v) => v.name === ending), ...el.variants.filter((v) => v.name !== ending)] : el.variants;
                    const variants = ordered.map((v) => this.record([`${tag}: fc.constant('${v.name}' as const)`], v.fields));
                    const choice = this.cycle ? `testing.variants(depth, ${variants.join(', ')})` : `fc.oneof(${variants.join(', ')})`;
                    const raw = variants.length ? `testing.cast<${this.type(el.name)}>(${choice})` : 'fc.constant(undefined as never)';
                    const invs = unionInvariants(el);
                    add(el.name, valid(el.name, raw, invs.length ? this.holds(el.name, el.name, invs) : undefined));
                    break;
                }
                case 'aggregate': {
                    const states = el.states;
                    const invs = aggregateInvariants(el);
                    const examples = (key: string): string => `options.examples?.${el.name}?.${key}`;
                    if (!states.length) {
                        const check = invs.length ? this.violated(el.name, el.name, invs) : '() => []';
                        const raw = `testing.cast<${this.type(el.name)}>(${this.record([], el.fields)})`;
                        add(
                            el.name,
                            `testing.withExamples(${valid(el.name, raw, invs.length ? this.holds(el.name, el.name, invs) : undefined)}, ${examples('aggregates')}, ${check}, '${ctx}.${el.name}')`,
                        );
                        break;
                    }
                    for (const s of states) {
                        const type = stateTypeName(el, s);
                        const check = invs.length ? this.violated(type, el.name, invs) : '() => []';
                        const allKinds = el.lifecycleField ? el.validStates.filter((v) => v.states.includes(s.name)).map((v) => v.kind) : [];
                        const base = `testing.cast<${this.type(type)}>(${this.record([`state: fc.constant('${s.name}' as const)`], [...el.fields, ...s.fields])})`;
                        const raw = el.lifecycleField
                            ? `${base}.filter((value) => ([${allKinds.map((k) => `'${k}'`).join(', ')}] as readonly string[]).includes(value.${el.lifecycleField}))`
                            : base;
                        add(
                            type,
                            `testing.withExamples(${valid(type, raw, invs.length ? this.holds(type, el.name, invs) : undefined)}, ${examples(`states?.${s.name}`)}, ${check}, '${ctx}.${type}')`,
                        );
                    }
                    add(el.name, `given.${el.name} ?? fc.oneof(${states.map((s) => `a.${stateTypeName(el, s)}`).join(', ')})`);
                    break;
                }
            }
        }
    }

    /** Names of the slots for constraints without an expression, by the type or command they belong to. */
    private declaredMembers(): string[] {
        const out: string[] = [];
        for (const el of this.els) {
            const invs =
                el.kind === 'aggregate'
                    ? aggregateInvariants(el)
                    : el.kind === 'union'
                      ? unionInvariants(el)
                      : ['id', 'primitive', 'valueObject', 'entity'].includes(el.kind)
                        ? invariantsOf(el)
                        : [];
            if (hasDeclared(invs)) out.push(`readonly ${el.name}?: Partial<${this.ctx}.${declaredChecksName(el.name)}>;`);
            if (el.kind !== 'aggregate') continue;
            for (const c of el.commands) {
                const t = commandTypeName(el, c);
                const requirements = [...c.requires, ...el.groups.flatMap((g) => g.cases.filter((x) => x.command === c.name).flatMap((x) => x.requires))];
                if (hasDeclared(requirements)) out.push(`readonly ${t}?: Partial<${this.ctx}.${declaredRequiresName(t)}>;`);
            }
        }
        return out;
    }

    private examplesMembers(): string[] {
        const out: string[] = [];
        for (const agg of this.els.filter((e) => e.kind === 'aggregate')) {
            const states = agg.states ?? [];
            const values = states.length
                ? `readonly states?: { ${states.map((s) => `readonly ${s.name}?: readonly ${this.type(stateTypeName(agg, s))}[]`).join('; ')} };`
                : `readonly aggregates?: readonly ${this.type(agg.name)}[];`;
            const commands = (agg.commands ?? []).map(
                (c) => `readonly ${c.name}?: readonly Parameters<${this.ctx}.${commandsInterfaceName(agg)}['${c.name}']>[]`,
            );
            out.push(`readonly ${agg.name}?: {`, `    ${values}`, ...(commands.length ? [`    readonly commands?: { ${commands.join('; ')} };`] : []), '};');
        }
        return out;
    }

    private primitiveCase(p: DomainPrimitive): string {
        const invs = primitiveInvariants(p);
        const declared = invs.filter((i) => !i.expr).map((i) => `'${i.name}'`);
        const check = !invs.length ? '() => () => []' : declared.length ? `${this.ctx}.${checkWithName(p.name)}` : `() => ${this.ctx}.${checkName(p.name)}`;
        return [
            `...(impl.make.${p.name} ? testing.primitiveCases({`,
            `    type: '${this.ctx}.${p.name}',`,
            `    base: '${p.base}',`,
            `    hints: ${literal(hintsOf(p.invariants))},`,
            `    invariants: [${invs.map((i) => `'${i.name}'`).join(', ')}],`,
            `    declared: [${declared.join(', ')}],`,
            `    check: ${check},`,
            `    make: impl.make.${p.name},`,
            ...(declared.length ? [`    given: declared.${p.name},`] : []),
            `}, options) : []),`,
        ].join('\n');
    }

    private commandCase(agg: AggregateModel, c: CommandModel): string {
        if (!c.legacy) return this.namedCommandCase(agg, c);
        const states = agg.states;
        const sources = [...new Set(c.transitions.flatMap((t) => t.from))];
        const subject = c.factory ? [] : [states.length ? `fc.oneof(${sources.map((s) => `a.${stateTypeName(agg, s)}`).join(', ')})` : `a.${agg.name}`];
        // the parameters as one record, an optional one left out or given (none without parameters)
        const input = `fc.tuple(${[...subject, ...(c.params.length ? [this.record([], c.params)] : [])].join(', ')})`;
        const t = commandTypeName(agg, c);
        const declaredReqs = c.requires.filter((r) => !r.expr).map((r) => `'${r.name}'`);
        const invs = aggregateInvariants(agg);
        const declaredInvs = invs.filter((i) => !i.expr).map((i) => `'${i.name}'`);
        const simple = (q: string): string => q.slice(q.indexOf('.') + 1);
        const emits = c.emits.filter(counted).map((e) => {
            const parts = [
                `key: '${simple(e.event)}'`,
                `lower: ${e.lower}`,
                ...(e.upper !== undefined ? [`upper: ${e.upper}`] : []),
                `from: [${(e.when?.from ?? []).map((s) => `'${s}'`).join(', ')}]`,
                `to: [${(e.when?.to ?? []).map((s) => `'${s}'`).join(', ')}]`,
            ];
            return `{ ${parts.join(', ')} }`;
        });
        return [
            `...testing.commandCases({`,
            `    name: '${agg.name}.${c.name}',`,
            `    run: impl.${agg.name}.${c.name},`,
            `    input: () => ${input},`,
            `    examples: options.examples?.${agg.name}?.commands?.${c.name} ?? [],`,
            `    factory: ${c.factory},`,
            `    requires: [${c.requires.map((r) => `{ name: '${r.name}', error: '${simple(r.error)}' }`).join(', ')}],`,
            `    declaredRequires: [${declaredReqs.join(', ')}],`,
            ...(c.requires.length
                ? [`    firstFailing: ${declaredReqs.length ? `${this.ctx}.${requiresWithName(t)}` : `() => ${this.ctx}.${requiresName(t)}`},`]
                : []),
            ...(declaredReqs.length ? [`    givenRequires: declared.${t},`] : []),
            ...(invs.length
                ? [`    invariants: ${declaredInvs.length ? `${this.ctx}.${checkWithName(agg.name)}` : `() => ${this.ctx}.${checkName(agg.name)}`},`]
                : []),
            `    declaredInvariants: [${declaredInvs.join(', ')}],`,
            ...(declaredInvs.length ? [`    givenInvariants: declared.${agg.name},`] : []),
            `    stateful: ${states.length > 0},`,
            `    counted: [${emits.join(', ')}],`,
            `}, options),`,
        ].join('\n');
    }

    private namedCommandCase(agg: AggregateModel, c: CommandModel): string {
        const kinds = agg.lifecycleField ? agg.validStates.map((v) => v.kind) : ['*'];
        const all = [...c.outcomes, ...agg.groups.flatMap((g) => g.cases.filter((x) => x.command === c.name).flatMap((x) => x.outcomes))];
        const sources = [...new Set(all.flatMap((o) => o.from))];
        const subject = c.factory ? [] : [agg.states.length ? `fc.oneof(${sources.map((s) => `a.${stateTypeName(agg, s)}`).join(', ')})` : `a.${agg.name}`];
        const tuple = `fc.tuple(${[...subject, ...(c.params.length ? [this.record([], c.params)] : [])].join(', ')})`;
        const allowed = kinds.flatMap((kind) => applicableOutcomes(agg, c, kind).flatMap((o) => o.from.map((from) => `${kind}:${from}`)));
        const input = c.factory || !agg.lifecycleField ? tuple : `${tuple}.filter(([subject]) => [${allowed.map((x) => `'${x}'`).join(', ')}].includes(String((subject as ${this.ctx}.${agg.name}).${agg.lifecycleField}) + ':' + String((subject as ${this.ctx}.${agg.name}).state)))`;
        const invs = aggregateInvariants(agg);
        const declaredInvs = invs.filter((i) => !i.expr).map((i) => `'${i.name}'`);
        const requirements = [
            ...c.requires.map((r) => ({ key: r.name, requirement: r })),
            ...agg.groups.flatMap((g, i) => g.cases.filter((x) => x.command === c.name).flatMap((x) => x.requires.map((r) => ({ key: `group${i}_${r.name}`, requirement: r })))),
        ];
        const declaredReqs = requirements.filter((x) => !x.requirement.expr).map((x) => `'${x.key}'`);
        const t = commandTypeName(agg, c);
        const outcomes = all.map((o) => {
            const applies = agg.lifecycleField ? kinds.filter((kind) => applicableOutcomes(agg, c, kind).includes(o)) : [];
            return `{ name: '${o.name}', to: '${o.to}', from: [${o.from.map((s) => `'${s}'`).join(', ')}], kinds: [${applies.map((k) => `'${k}'`).join(', ')}] }`;
        });
        const counts = all.flatMap((o) => o.emits.filter(counted).map((e) => `{ key: '${e.event.slice(e.event.indexOf('.') + 1)}', lower: ${e.lower}, ${e.upper !== undefined ? `upper: ${e.upper}, ` : ''}from: [${o.from.map((s) => `'${s}'`).join(', ')}], to: ['${o.name}'] }`));
        return [
            `...testing.commandCases({`,
            `    name: '${agg.name}.${c.name}',`,
            `    run: impl.${agg.name}.${c.name},`,
            `    input: () => ${input},`,
            `    examples: options.examples?.${agg.name}?.commands?.${c.name} ?? [],`,
            `    factory: ${c.factory},`,
            `    requires: [${requirements.map((x) => `{ name: '${x.key}', error: '${x.requirement.error.slice(x.requirement.error.indexOf('.') + 1)}' }`).join(', ')}],`,
            `    declaredRequires: [${declaredReqs.join(', ')}],`,
            ...(requirements.length ? [`    firstFailing: ${declaredReqs.length ? `${this.ctx}.${requiresWithName(t)}` : `() => ${this.ctx}.${requiresName(t)}`},`] : []),
            ...(declaredReqs.length ? [`    givenRequires: declared.${t},`] : []),
            ...(invs.length ? [`    invariants: ${declaredInvs.length ? `${this.ctx}.${checkWithName(agg.name)}` : `() => ${this.ctx}.${checkName(agg.name)}`},`] : []),
            `    declaredInvariants: [${declaredInvs.join(', ')}],`,
            ...(declaredInvs.length ? [`    givenInvariants: declared.${agg.name},`] : []),
            `    stateful: ${agg.states.length > 0},`,
            `    counted: [${counts.join(', ')}],`,
            `    outcomes: [${outcomes.join(', ')}],`,
            ...(agg.lifecycleField ? [`    kindField: '${agg.lifecycleField}',`, `    validStates: ${JSON.stringify(agg.validStates)},`] : []),
            `    choices: ${this.ctx}.${choiceCheckName(agg, c)}(${all.some((o) => o.select?.kind === 'external') ? `options.external.${agg.name}.${c.name}` : '{}'}),`,
            `}, options),`,
        ].join('\n');
    }

    /**
     * Whether a value is one of type `f`, as an arrow function for the generated policy cases: its base type or enum
     * value; for a value object or entity, an object whose fields are valid in turn; and the invariants of its type
     * (the check of another context's type is that context's). A union, an aggregate and a type met again inside itself
     * are checked as objects with their invariants only.
     */
    private validOf(f: FieldModel, outer: ReadonlySet<string> = new Set()): string {
        if (f.type.kind === 'primitive') return `(v) => testing.isBase(v, '${f.type.name}')`;
        const el = elementOf(this.model, f.type.ref);
        if (!el) return '() => true';
        const ctx = el.context;
        const invs =
            el.kind === 'union'
                ? unionInvariants(el)
                : el.kind === 'aggregate'
                  ? []
                  : el.kind === 'id' || el.kind === 'primitive'
                    ? primitiveInvariants(el)
                    : invariantsOf(el);
        const inner = new Set([...outer, el.id]);
        const shape =
            el.kind === 'enum'
                ? `[${el.values.map((v) => `'${v.name}'`).join(', ')}].includes(v as string)`
                : el.kind === 'id' || el.kind === 'primitive'
                  ? `testing.isBase(v, '${el.base}')`
                  : (el.kind === 'valueObject' || el.kind === 'entity') && !outer.has(el.id)
                    ? `testing.validFields(v, [${el.fields.map((g) => this.inputField(g, inner)).join(', ')}])`
                    : 'testing.isObject(v)';
        if (!invs.length) return `(v) => ${shape}`;
        this.checked.add(ctx);
        const names = invs.filter((i) => !i.expr).map((i) => `'${i.name}'`);
        const check = names.length
            ? `${ctx}.${checkWithName(el.name)}(testing.declared<${ctx}.${declaredChecksName(el.name)}>([${names.join(', ')}], options.declared?.${ctx}?.${el.name}))`
            : `${ctx}.${checkName(el.name)}`;
        return `(v) => ${shape} && ${check}(v as ${ctx}.${el.name}).length === 0`;
    }

    /** A field of the input of a policy's command (or of a value in it), for `testing.policyCases`. */
    private inputField(f: FieldModel, outer: ReadonlySet<string> = new Set()): string {
        const { lower, upper } = bounds(f);
        const many = f.cardinality === 'many' || f.cardinality === 'nonEmpty';
        return `{ name: '${f.name}', optional: ${f.cardinality === 'optional'}, many: ${many}${many ? `, lower: ${lower}${upper !== undefined ? `, upper: ${upper}` : ''}` : ''}, valid: ${this.validOf(f, outer)} }`;
    }

    /** The case of a required policy: every event resolves to an input that the command accepts. */
    private policyCase(p: PolicyElement): string {
        const { event, aggregate, command } = p.policy;
        const target = elementOf(this.model, aggregate);
        const agg = target?.kind === 'aggregate' ? target : undefined;
        const c = agg?.commands.find((x) => x.name === command);
        const id = agg?.fields.find((f) => f.name === 'id');
        const fields = [...(agg && c && !c.factory && id ? [{ ...id, name: aggregateParamName(agg) }] : []), ...(c?.params ?? [])];
        const simple = (q: string): string => (q.startsWith(`${this.ctx}.`) ? q.slice(this.ctx.length + 1) : q);
        return [
            `...testing.policyCases({`,
            `    name: '${p.name}',`,
            `    reaction: 'when ${simple(event)} -> ${simple(aggregate)}.${command}',`,
            `    handler: impl.policies.${p.name},`,
            `    event: () => ${this.arb(event)},`,
            `    input: [${fields.map((f) => this.inputField(f)).join(', ')}],`,
            `}, options),`,
        ].join('\n');
    }

    emit(): string {
        const ctx = this.ctx;
        const { members, defs, cycles } = this.arbitraries();
        const primitives = this.els.filter((e) => e.kind === 'id' || e.kind === 'primitive');
        const aggregates = this.els.filter((e): e is AggregateModel => e.kind === 'aggregate' && e.commands.length > 0);
        const policies = this.policiesRequired ? this.els.filter((e): e is PolicyElement => e.kind === 'policy') : [];
        const indent = (text: string, pad: string): string =>
            text
                .split('\n')
                .map((l) => `${pad}${l}`)
                .join('\n');
        const groups = [
            ...(primitives.length
                ? [`impl.make && testing.suite('domain primitives', [\n${primitives.map((p) => indent(this.primitiveCase(p), '    ')).join('\n')}\n]),`]
                : []),
            ...aggregates.map(
                (agg) =>
                    `impl.${agg.name} && testing.suite('${agg.name}', [\n${agg.commands.map((c) => indent(this.commandCase(agg, c), '    ')).join('\n')}\n]),`,
            ),
            ...(policies.length ? [`testing.suite('policies', [\n${policies.map((p) => indent(this.policyCase(p), '    ')).join('\n')}\n]),`] : []),
        ];
        // the contexts of the options: those whose tests are next to these, and those of another package that are used
        // (a package's tests import only the packages it depends on)
        const all: string[] = contextNames(this.model).filter((c) => c === ctx || this.nextTo(c) || this.others.has(c));
        const defsText = [...cycles, ...defs].join('\n');
        const groupsText = groups.join('\n');
        // the helpers a function body uses (for `noUnusedLocals`)
        const locals = (text: string, declaredToo: boolean): string[] => {
            const others = all.filter((c) => c !== ctx && text.includes(`${c}Arbs()`));
            return [
                ...(/\bseed\b/.test(text) ? [`    const seed = options.seed ?? testing.DEFAULT_SEED;`] : []),
                ...(text.includes('given.') ? [`    const given: Partial<Arbitraries> = options.arbitraries?.${ctx} ?? {};`] : []),
                ...(declaredToo && text.includes('declared.') ? [`    const declared: DeclaredChecks = options.declared?.${ctx} ?? {};`] : []),
                ...(text.includes('scalar.') ? [`    const scalar = testing.scalars(options.seed ?? testing.DEFAULT_SEED);`] : []),
                ...(others.length
                    ? [
                          `    const generation: Generation = { ...(options.seed !== undefined && { seed: options.seed }), ...(options.arbitraries && { arbitraries: options.arbitraries }), ...(options.declared && { declared: options.declared }) };`,
                      ]
                    : []),
                ...others.map(
                    (c) =>
                        `    let ${c}Of: ${c}Tests.Arbitraries | undefined;\n    const ${c}Arbs = (): ${c}Tests.Arbitraries => (${c}Of ??= ${c}Tests.arbitraries(generation));`,
                ),
            ];
        };
        const declared = this.declaredMembers();
        const examples = this.examplesMembers();
        const externalChoices = aggregates.flatMap((agg) => agg.commands.filter((c) => !c.legacy && [
            ...c.outcomes,
            ...agg.groups.flatMap((g) => g.cases.filter((x) => x.command === c.name).flatMap((x) => x.outcomes)),
        ].some((o) => o.select?.kind === 'external')).map((c) => ({ agg, c })));
        const externalDeclared = this.els.flatMap((el) => {
            const invs = el.kind === 'aggregate' ? aggregateInvariants(el) : el.kind === 'union' ? unionInvariants(el) : 'invariants' in el ? el.invariants : [];
            const names = invs.filter((i) => !i.expr && i.externalReason).map((i) => i.name);
            const entries = names.length ? [{ key: el.name, type: `${ctx}.${declaredChecksName(el.name)}`, names }] : [];
            if (el.kind === 'aggregate') for (const c of el.commands) {
                const required = [
                    ...c.requires.filter((r) => !r.expr && r.externalReason).map((r) => r.name),
                    ...el.groups.flatMap((g, i) => g.cases.filter((x) => x.command === c.name).flatMap((x) => x.requires.filter((r) => !r.expr && r.externalReason).map((r) => `group${i}_${r.name}`))),
                ];
                if (required.length) entries.push({ key: commandTypeName(el, c), type: `${ctx}.${declaredRequiresName(commandTypeName(el, c))}`, names: required });
            }
            return entries;
        });
        const needsExternal = externalChoices.length > 0 || externalDeclared.length > 0;
        const usesDecimal = /<Decimal>/.test(defsText + groupsText);
        const body = [
            `// generated by domaintrail ${VERSION}: loading these tests with an incompatible domaintrail/testing fails`,
            `testing.checkVersion('${VERSION}');`,
            '',
            `/** fast-check arbitraries of the value types and aggregates of ${ctx}: only values that hold their invariants. */`,
            `export interface Arbitraries {`,
            ...members.map((m) => `    ${m}`),
            `}`,
            '',
            `/** Checks of the invariants and requirements of ${ctx} that the DSL does not express, as your code implements them. */`,
            declared.length ? `export interface DeclaredChecks {\n${declared.map((m) => `    ${m}`).join('\n')}\n}` : `export interface DeclaredChecks {}`,
            '',
            `/** Examples run before the generated inputs: aggregates per state (mixed into the generated ones) and arguments per command. */`,
            examples.length ? `export interface Examples {\n${examples.map((m) => `    ${m}`).join('\n')}\n}` : `export interface Examples {}`,
            '',
            `/** How inputs are generated; the same for every context, so that one value serves them all. */`,
            `export interface Generation extends testing.RunOptions {`,
            `    /** Arbitraries replacing the generated ones, by context and type (still filtered by the invariants). */`,
            `    readonly arbitraries?: { ${all.map((c) => `readonly ${c}?: Partial<${c === ctx ? '' : `${c}Tests.`}Arbitraries>`).join('; ')} };`,
            `    /** Checks of the constraints without an expression, by context; those not given are not tested. */`,
            `    readonly declared?: { ${all.map((c) => `readonly ${c}?: ${c === ctx ? '' : `${c}Tests.`}DeclaredChecks`).join('; ')} };`,
            `}`,
            '',
            `export interface Options extends Generation {`,
            `    readonly examples?: Examples;`,
            ...(externalChoices.length ? [`    readonly external: { ${[...new Set(externalChoices.map(({ agg }) => agg.name))].map((name) => `readonly ${name}: { ${externalChoices.filter(({ agg }) => agg.name === name).map(({ c, agg }) => `readonly ${c.name}: ${ctx}.${commandTypeName(agg, c)}ChoiceChecks`).join('; ')} }`).join('; ')} };`] : []),
            ...(externalDeclared.length ? [`    readonly declared: { readonly ${ctx}: { ${externalDeclared.map((entry) => `readonly ${entry.key}: Pick<${entry.type}, ${entry.names.map((n) => `'${n}'`).join(' | ')}>`).join('; ')} } };`] : []),
            `}`,
            '',
            policies.length
                ? `/** What \`contract\` tests: the constructors of domain primitives and the commands of aggregates, each optional, and the handlers of the policies, required (\`generate.ts.policies\`). */`
                : `/** What \`contract\` tests: the constructors of domain primitives and the commands of aggregates, each optional. */`,
            `export interface Implementation {`,
            ...(primitives.length ? [`    readonly make?: { ${primitives.map((p) => `readonly ${p.name}?: ${ctx}.${makeTypeName(p)}`).join('; ')} };`] : []),
            ...aggregates.map((agg) => `    readonly ${agg.name}?: ${ctx}.${commandsInterfaceName(agg)};`),
            ...(policies.length ? [`    readonly policies: ${ctx}.${policyHandlersName(ctx)};`] : []),
            `}`,
            '',
            `/** The arbitraries of ${ctx}, with the overrides, declared checks and examples of the options. */`,
            `export function arbitraries(options: Partial<Options> = {}): Arbitraries {`,
            ...locals(defsText, true),
            ...cycles.map((c) => indent(c, '    ')),
            `    const a: Arbitraries = testing.lazy<Arbitraries>({`,
            ...defs.map((d) => `        ${d}`),
            `    });`,
            `    return a;`,
            `}`,
            '',
            `/**`,
            ` * The contract tests of ${ctx} (ADR 0020), as a suite of named cases for any runner: for every \`make<Name>\` passed,`,
            ` * that it accepts exactly the values that hold the invariants; for every aggregate's commands passed, the error of the`,
            ` * first requirement that does not hold, the invariants of the aggregate made, event counts the types do not express,`,
            ` * and purity.${policies.length ? ' For every policy, that its handler resolves each event to an input the command accepts (with the' : ''}`,
            ...(policies.length ? [` * handlers as your code wired them).`] : []),
            ` * Inputs are generated from the types (deterministic: a fixed seed unless one is passed).`,
            ` */`,
            `export function contract(impl: Implementation, options: Options${needsExternal ? '' : ' = {}'}): testing.Suite {`,
            ...externalDeclared.flatMap((entry) => entry.names.map((name) => `    if (typeof options?.declared?.${ctx}?.${entry.key}?.${name} !== 'function') throw new Error('Missing external check ${ctx}.${entry.key}.${name}');`)),
            ...externalChoices.flatMap(({ agg, c }) => [
                ...c.outcomes,
                ...agg.groups.flatMap((g) => g.cases.filter((x) => x.command === c.name).flatMap((x) => x.outcomes)),
            ].filter((o) => o.select?.kind === 'external').map((o) => `    if (typeof options?.external?.${agg.name}?.${c.name}?.${o.name} !== 'function') throw new Error('Missing external choice check ${agg.name}.${c.name}.${o.name}');`)),
            ...(aggregates.length || /\ba\./.test(groupsText) ? [`    const a = arbitraries(options);`] : []),
            ...locals(groupsText, true),
            `    return testing.suite('${ctx}', [`,
            ...groups.map((g) => indent(g, '        ')),
            `    ]);`,
            `}`,
            '',
        ];
        const text = body.join('\n');
        // modules used only for types are imported as types
        const used = (prefix: string): boolean => text.includes(prefix);
        // other contexts whose checks the policy cases call
        const checked = contextNames(this.model).filter((c) => c !== ctx && this.checked.has(c));
        const imports = [
            this.header,
            `import * as fc from 'fast-check';`,
            ...(usesDecimal ? [`import type { Decimal } from '${this.moduleOf(ctx).replace(/[^/]+\.js$/, '_runtime.js')}';`] : []),
            `import * as testing from '${TESTING}';`,
            `import ${used(`${ctx}.check`) ? '' : 'type '}* as ${ctx} from '${this.moduleOf(ctx)}';`,
            ...checked.map((c) => `import ${used(`${c}.check`) ? '' : 'type '}* as ${c} from '${this.moduleOf(c)}';`),
            ...all.filter((c) => c !== ctx).map((c) => `import ${used(`${c}Tests.arbitraries(`) ? '' : 'type '}* as ${c}Tests from '${this.testsOf(c)}';`),
            '',
        ];
        return [...imports, text].join('\n');
    }
}
