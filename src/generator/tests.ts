import * as posix from 'node:path/posix';
import * as testingSource from './testing/_testing.js' with { type: 'text' };
import type { CommandModel, DomainModel, ElementModel, ExprModel, FieldModel, InvariantModel } from '../model/model.js';
import { elementsIn } from '../model/model.js';
import { aggregateInvariants, checkName, checkWithName, declaredChecksName, declaredRequiresName, hasDeclared, requiresName, requiresWithName, unionInvariants } from './checks.js';
import { aggregateParamName, commandTypeName, commandsInterfaceName, makeTypeName, policyHandlersName, stateTypeName } from './naming.js';
import type { PolicyMode } from './typescript.js';

/** The test runners `dt` writes an adapter for (`generate.ts.tests.runner`). */
export const RUNNERS = ['bun', 'vitest', 'jest', 'node'] as const;
export type Runner = (typeof RUNNERS)[number];

export interface TestsOptions {
    /** Directory of the test modules (`/`-separated, relative to the output root). */
    dir: string;
    runner?: Runner;
    /** The mode of each context's policies (absent: `optional`); `required` adds `policies` to `contract(impl)`. */
    policies?: Readonly<Record<string, PolicyMode>>;
}

interface File {
    path: string;
    content: string;
}

/** The generic helpers of the tests (`_testing.ts`), the same for every model. Imported as text, see `./testing`. */
const TESTING = (testingSource as unknown as { default: string }).default;

/** `register(suite)` per runner: one `describe` per suite, one test per case. */
const ADAPTERS: Record<Runner, string> = {
    bun: `import { describe, test } from 'bun:test';`,
    vitest: `import { describe, test } from 'vitest';`,
    jest: `import { describe, test } from '@jest/globals';`,
    node: `import { describe, test } from 'node:test';`,
};

function adapter(header: string, runner: Runner): string {
    const todo = runner === 'node' ? `test(c.name, { todo: true })` : `test.todo(c.name)`;
    return `${header}
${ADAPTERS[runner]}
import { isSuite, type Suite } from './_testing.js';

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

/**
 * The contract tests (ADR 0020): per context a module with fast-check arbitraries of its types and `contract(impl)`,
 * the runner-agnostic suite; `_testing.ts` with the generic helpers, an index, and an adapter for the runner if one is
 * configured. `moduleOf(from, ctx)` is the import specifier of a context's module from directory `from`.
 */
export function generateTests(model: DomainModel, header: string, opts: TestsOptions, moduleOf: (from: string, ctx: string) => string): File[] {
    const dir = opts.dir;
    const files: File[] = [{ path: posix.join(dir, '_testing.ts'), content: `${header}\n${TESTING}` }];
    for (const ctx of model.contexts) {
        files.push({ path: posix.join(dir, `${ctx}.ts`), content: new TestsEmitter(model, ctx, header, (c) => moduleOf(dir, c), opts.policies?.[ctx] === 'required').emit() });
    }
    if (opts.runner) files.push({ path: posix.join(dir, '_register.ts'), content: adapter(header, opts.runner) });
    const index = [
        header,
        `export * from './_testing.js';`,
        ...(opts.runner ? [`export { register } from './_register.js';`] : []),
        ...model.contexts.map((c) => `export * as ${c} from './${c}.js';`),
        '',
    ];
    files.push({ path: posix.join(dir, 'index.ts'), content: index.join('\n') });
    return files;
}

/** Bounds read from the invariants of a domain primitive (`value in 1..999`, `length(value) <= 8`, `matches`). */
export function hintsOf(invs: InvariantModel[]): Record<string, number | string> {
    const h: Record<string, number | string> = {};
    const num = (e: ExprModel): number | undefined => (e.k === 'int' ? e.value : e.k === 'decimal' ? Number(e.value) : undefined);
    const isValue = (e: ExprModel): boolean => e.k === 'name' && e.name === 'value';
    const isLength = (e: ExprModel): boolean => e.k === 'length' && isValue(e.operand);
    const set = (key: string, v: number | undefined, keep: (a: number, b: number) => number): void => {
        if (v === undefined) return;
        h[key] = key in h ? keep(h[key] as number, v) : v;
    };
    const flip: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' };
    const bound = (subject: 'value' | 'length', op: string, v: number | undefined): void => {
        const [lo, hi] = subject === 'value' ? [['ge', 'gt'], ['le', 'lt']] : [['minLength', 'minLength'], ['maxLength', 'maxLength']];
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
        } else if (e.k === 'binary' && e.op in flip) {
            for (const [x, y, op] of [[e.left, e.right, e.op], [e.right, e.left, flip[e.op]]] as const) {
                if (isValue(x)) bound('value', op, num(y));
                else if (isLength(x)) bound('length', op, num(y));
            }
        } else if (e.k === 'binary' && e.op === '==') {
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
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
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

    constructor(
        private readonly model: DomainModel,
        private readonly ctx: string,
        private readonly header: string,
        private readonly moduleOf: (ctx: string) => string,
        /** Whether the context's policies are required: `contract` then tests their handlers. */
        private readonly policiesRequired: boolean,
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
        return this.arb(f.type.ref);
    }

    private tsBase(name: string): string {
        return { String: 'string', Int: 'number', Decimal: 'Decimal', Bool: 'boolean', Timestamp: 'Date', UUID: 'string' }[name] ?? 'unknown';
    }

    /** The arbitrary of a field in a record (optional fields are left out of `requiredKeys`) or of a parameter. */
    private fieldArb(f: FieldModel, param: boolean): string {
        const b = this.baseArb(f);
        if (f.cardinality === 'one') return b;
        if (f.cardinality === 'optional') return param ? `testing.optional(${b})` : b;
        const { lower, upper } = bounds(f);
        return `testing.many(${b}, ${lower}${upper !== undefined ? `, ${upper}` : ''})`;
    }

    private record(head: string[], fields: FieldModel[]): string {
        const props = [...head, ...fields.map((f) => `${f.name}: ${this.fieldArb(f, false)}`)];
        const optional = fields.some((f) => f.cardinality === 'optional');
        const required = [...head.map((h) => h.slice(0, h.indexOf(':'))), ...fields.filter((f) => f.cardinality !== 'optional').map((f) => f.name)];
        return `fc.record({ ${props.join(', ')} }${optional ? `, { requiredKeys: [${required.map((n) => `'${n}'`).join(', ')}] }` : ''})`;
    }

    /** `(v) => <check>(v).length === 0`, with the declared checks of the options (others assumed to hold). */
    private holds(typeName: string, checkOwner: string, invs: InvariantModel[]): string {
        return `(v) => ${this.violated(typeName, checkOwner, invs)}(v).length === 0`;
    }

    private violated(typeName: string, checkOwner: string, invs: InvariantModel[]): string {
        if (!hasDeclared(invs)) return `${this.ctx}.${checkName(typeName)}`;
        const names = invs.filter((i) => !i.expr).map((i) => `'${i.name}'`);
        return `${this.ctx}.${checkWithName(typeName)}(testing.declared<${this.ctx}.${declaredChecksName(checkOwner)}>([${names.join(', ')}], declared.${checkOwner}))`;
    }

    /** The entries of `Arbitraries` and their definitions. */
    private arbitraries(): { members: string[]; defs: string[] } {
        const members: string[] = [];
        const defs: string[] = [];
        const ctx = this.ctx;
        const add = (name: string, def: string): void => {
            members.push(`readonly ${name}: fc.Arbitrary<${this.type(name)}>;`);
            defs.push(`${name}: () => ${def},`);
        };
        const valid = (name: string, raw: string, holds: string | undefined): string =>
            holds ? `testing.valid(given.${name} ?? ${raw}, ${holds}, '${ctx}.${name}')` : `given.${name} ?? ${raw}`;
        for (const el of this.els) {
            switch (el.kind) {
                case 'id':
                case 'primitive': {
                    const raw = `testing.collide(testing.cast<${this.type(el.name)}>(testing.base('${el.base ?? 'String'}', ${literal(hintsOf(el.invariants))})), seed)`;
                    add(el.name, valid(el.name, raw, el.invariants.length ? this.holds(el.name, el.name, el.invariants) : undefined));
                    break;
                }
                case 'verified': {
                    // the check is the factory's, outside the contract tests: any value of the base passed it
                    const base = this.baseArb({ name: el.name, kind: 'param', type: el.verified!.of, cardinality: 'one', multiplicity: '' });
                    add(el.name, `given.${el.name} ?? testing.cast<${this.type(el.name)}>(${base})`);
                    break;
                }
                case 'event':
                    add(el.name, `given.${el.name} ?? testing.cast<${this.type(el.name)}>(${this.record([`type: fc.constant('${el.name}' as const)`], el.fields)})`);
                    break;
                case 'enum':
                    add(el.name, `given.${el.name} ?? ${el.values?.length ? `fc.constantFrom<${this.type(el.name)}>(${el.values.map((v) => `'${v}'`).join(', ')})` : `fc.constant(undefined as never)`}`);
                    break;
                case 'valueObject':
                case 'entity': {
                    const raw = `testing.cast<${this.type(el.name)}>(${this.record([], el.fields)})`;
                    add(el.name, valid(el.name, raw, el.invariants.length ? this.holds(el.name, el.name, el.invariants) : undefined));
                    break;
                }
                case 'union': {
                    const tag = el.discriminator ?? 'kind';
                    const variants = (el.variants ?? []).map((v) => this.record([`${tag}: fc.constant('${v.name}' as const)`], v.fields));
                    const raw = variants.length ? `testing.cast<${this.type(el.name)}>(fc.oneof(${variants.join(', ')}))` : 'fc.constant(undefined as never)';
                    const invs = unionInvariants(el);
                    add(el.name, valid(el.name, raw, invs.length ? this.holds(el.name, el.name, invs) : undefined));
                    break;
                }
                case 'aggregate': {
                    const states = el.states ?? [];
                    const invs = aggregateInvariants(el);
                    const examples = (key: string): string => `options.examples?.${el.name}?.${key}`;
                    if (!states.length) {
                        const check = invs.length ? this.violated(el.name, el.name, invs) : '() => []';
                        const raw = `testing.cast<${this.type(el.name)}>(${this.record([], el.fields)})`;
                        add(el.name, `testing.withExamples(${valid(el.name, raw, invs.length ? this.holds(el.name, el.name, invs) : undefined)}, ${examples('aggregates')}, ${check}, '${ctx}.${el.name}')`);
                        break;
                    }
                    for (const s of states) {
                        const type = stateTypeName(el, s);
                        const check = invs.length ? this.violated(type, el.name, invs) : '() => []';
                        const raw = `testing.cast<${this.type(type)}>(${this.record([`state: fc.constant('${s.name}' as const)`], [...el.fields, ...s.fields])})`;
                        add(type, `testing.withExamples(${valid(type, raw, invs.length ? this.holds(type, el.name, invs) : undefined)}, ${examples(`states?.${s.name}`)}, ${check}, '${ctx}.${type}')`);
                    }
                    add(el.name, `given.${el.name} ?? fc.oneof(${states.map((s) => `a.${stateTypeName(el, s)}`).join(', ')})`);
                    break;
                }
            }
        }
        return { members, defs };
    }

    /** Names of the slots for constraints without an expression, by the type or command they belong to. */
    private declaredMembers(): string[] {
        const out: string[] = [];
        for (const el of this.els) {
            const invs = el.kind === 'aggregate' ? aggregateInvariants(el) : el.kind === 'union' ? unionInvariants(el) : ['id', 'primitive', 'valueObject', 'entity'].includes(el.kind) ? el.invariants : [];
            if (hasDeclared(invs)) out.push(`readonly ${el.name}?: Partial<${this.ctx}.${declaredChecksName(el.name)}>;`);
            for (const c of el.commands ?? []) {
                const t = commandTypeName(el, c);
                if (hasDeclared(c.requires)) out.push(`readonly ${t}?: Partial<${this.ctx}.${declaredRequiresName(t)}>;`);
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
            const commands = (agg.commands ?? []).map((c) => `readonly ${c.name}?: readonly Parameters<${this.ctx}.${commandsInterfaceName(agg)}['${c.name}']>[]`);
            out.push(`readonly ${agg.name}?: {`, `    ${values}`, ...(commands.length ? [`    readonly commands?: { ${commands.join('; ')} };`] : []), '};');
        }
        return out;
    }

    private primitiveCase(p: ElementModel): string {
        const declared = p.invariants.filter((i) => !i.expr).map((i) => `'${i.name}'`);
        const check = !p.invariants.length ? '() => () => []' : declared.length ? `${this.ctx}.${checkWithName(p.name)}` : `() => ${this.ctx}.${checkName(p.name)}`;
        return [
            `...(impl.make.${p.name} ? testing.primitiveCases({`,
            `    type: '${this.ctx}.${p.name}',`,
            `    base: '${p.base ?? 'String'}',`,
            `    hints: ${literal(hintsOf(p.invariants))},`,
            `    invariants: [${p.invariants.map((i) => `'${i.name}'`).join(', ')}],`,
            `    declared: [${declared.join(', ')}],`,
            `    check: ${check},`,
            `    make: impl.make.${p.name},`,
            ...(declared.length ? [`    given: declared.${p.name},`] : []),
            `}, options) : []),`,
        ].join('\n');
    }

    private commandCase(agg: ElementModel, c: CommandModel): string {
        const states = agg.states ?? [];
        const sources = [...new Set(c.transitions.flatMap((t) => t.from))];
        const subject = c.factory ? [] : [states.length ? `fc.oneof(${sources.map((s) => `a.${stateTypeName(agg, s)}`).join(', ')})` : `a.${agg.name}`];
        const input = `fc.tuple(${[...subject, ...c.params.map((p) => this.fieldArb(p, true))].join(', ')})`;
        const t = commandTypeName(agg, c);
        const declaredReqs = c.requires.filter((r) => !r.expr).map((r) => `'${r.name}'`);
        const invs = aggregateInvariants(agg);
        const declaredInvs = invs.filter((i) => !i.expr).map((i) => `'${i.name}'`);
        const simple = (q: string): string => q.slice(q.indexOf('.') + 1);
        const emits = c.emits.filter(counted).map((e) => {
            const parts = [`key: '${simple(e.event)}'`, `lower: ${e.lower}`, ...(e.upper !== undefined ? [`upper: ${e.upper}`] : []), `from: [${(e.when?.from ?? []).map((s) => `'${s}'`).join(', ')}]`, `to: [${(e.when?.to ?? []).map((s) => `'${s}'`).join(', ')}]`];
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
            ...(c.requires.length ? [`    firstFailing: ${declaredReqs.length ? `${this.ctx}.${requiresWithName(t)}` : `() => ${this.ctx}.${requiresName(t)}`},`] : []),
            ...(declaredReqs.length ? [`    givenRequires: declared.${t},`] : []),
            ...(invs.length ? [`    invariants: ${declaredInvs.length ? `${this.ctx}.${checkWithName(agg.name)}` : `() => ${this.ctx}.${checkName(agg.name)}`},`] : []),
            `    declaredInvariants: [${declaredInvs.join(', ')}],`,
            ...(declaredInvs.length ? [`    givenInvariants: declared.${agg.name},`] : []),
            `    stateful: ${states.length > 0},`,
            `    counted: [${emits.join(', ')}],`,
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
        const el = this.model.elements[f.type.ref];
        if (!el) return '() => true';
        const ctx = el.context;
        const invs = el.kind === 'union' ? unionInvariants(el) : el.kind === 'aggregate' ? [] : el.invariants;
        const inner = new Set([...outer, el.id]);
        const shape =
            el.kind === 'enum' ? `[${(el.values ?? []).map((v) => `'${v}'`).join(', ')}].includes(v as string)`
            : el.kind === 'id' || el.kind === 'primitive' ? `testing.isBase(v, '${el.base ?? 'String'}')`
            : (el.kind === 'valueObject' || el.kind === 'entity') && !outer.has(el.id) ? `testing.validFields(v, [${el.fields.map((g) => this.inputField(g, inner)).join(', ')}])`
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
    private policyCase(p: ElementModel): string {
        const { event, aggregate, command } = p.policy!;
        const agg = this.model.elements[aggregate];
        const c = agg?.commands?.find((x) => x.name === command);
        const id = agg?.fields.find((f) => f.name === 'id');
        const fields = [...(c && !c.factory && id ? [{ ...id, name: aggregateParamName(agg!) }] : []), ...(c?.params ?? [])];
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
        const { members, defs } = this.arbitraries();
        const primitives = this.els.filter((e) => e.kind === 'id' || e.kind === 'primitive');
        const aggregates = this.els.filter((e) => e.kind === 'aggregate' && e.commands?.length);
        const policies = this.policiesRequired ? this.els.filter((e) => e.kind === 'policy') : [];
        const indent = (text: string, pad: string): string => text.split('\n').map((l) => `${pad}${l}`).join('\n');
        const groups = [
            ...(primitives.length ? [`impl.make && testing.suite('domain primitives', [\n${primitives.map((p) => indent(this.primitiveCase(p), '    ')).join('\n')}\n]),`] : []),
            ...aggregates.map((agg) => `impl.${agg.name} && testing.suite('${agg.name}', [\n${(agg.commands ?? []).map((c) => indent(this.commandCase(agg, c), '    ')).join('\n')}\n]),`),
            ...(policies.length ? [`testing.suite('policies', [\n${policies.map((p) => indent(this.policyCase(p), '    ')).join('\n')}\n]),`] : []),
        ];
        const all = this.model.contexts;
        const defsText = defs.join('\n');
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
                    ? [`    const generation: Generation = { ...(options.seed !== undefined && { seed: options.seed }), ...(options.arbitraries && { arbitraries: options.arbitraries }), ...(options.declared && { declared: options.declared }) };`]
                    : []),
                ...others.map((c) => `    let ${c}Of: ${c}Tests.Arbitraries | undefined;\n    const ${c}Arbs = (): ${c}Tests.Arbitraries => (${c}Of ??= ${c}Tests.arbitraries(generation));`),
            ];
        };
        const declared = this.declaredMembers();
        const examples = this.examplesMembers();
        const usesDecimal = /<Decimal>/.test(defsText + groupsText);
        const body = [
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
            `export function arbitraries(options: Options = {}): Arbitraries {`,
            ...locals(defsText, true),
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
            `export function contract(impl: Implementation, options: Options = {}): testing.Suite {`,
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
        const checked = all.filter((c) => c !== ctx && this.checked.has(c));
        const imports = [
            this.header,
            `import * as fc from 'fast-check';`,
            ...(usesDecimal ? [`import type { Decimal } from '${this.moduleOf(ctx).replace(/[^/]+\.js$/, '_runtime.js')}';`] : []),
            `import * as testing from './_testing.js';`,
            `import ${used(`${ctx}.check`) ? '' : 'type '}* as ${ctx} from '${this.moduleOf(ctx)}';`,
            ...checked.map((c) => `import ${used(`${c}.check`) ? '' : 'type '}* as ${c} from '${this.moduleOf(c)}';`),
            ...all.filter((c) => c !== ctx).map((c) => `import ${used(`${c}Tests.arbitraries(`) ? '' : 'type '}* as ${c}Tests from './${c}.js';`),
            '',
        ];
        return [...imports, text].join('\n');
    }
}
