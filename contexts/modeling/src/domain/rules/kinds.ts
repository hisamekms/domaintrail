import type { RuleSink } from '../diagnostics.js';
import {
    commonCommandsOf,
    commonFields,
    commandsOf,
    fieldsOf,
    includedFields,
    invariantsOf,
    kindFields,
    kindsOf,
    statesOf,
    type AggregateDecl,
    type CommandDecl,
    type Expr,
    type FieldDecl,
    type KindDecl,
    type SourceModel,
} from '../source-model.js';
import { sameType, memberType } from '../types.js';

/** The discriminator of an aggregate with kinds in the generated code (ADR 0037). */
const KIND_TAG = 'kind';

const quoted = (names: readonly string[]): string => names.map((n) => `'${n}'`).join(', ');

/**
 * The kinds of an aggregate (ADR 0037): a discriminated sum of its kinds, fixed when it is made.
 *
 * M030 (errors):
 *   - a common command has its behaviour in exactly one place: common (outcomes, transitions, `changes`, `emits`), or an
 *     `on` case in every kind; never both, never a kind without its case;
 *   - an `on` case names a common command that is not a factory, once per kind;
 *   - with kinds, the factories are the kinds' (`create command` inside a kind), and every kind has one when the
 *     aggregate has factories at all;
 *   - `kind` names the discriminator: no field of an aggregate with kinds is named `kind`, and no kind like a state;
 *   - with kinds and states, commands use named outcomes (`outcome name: A -> B`), not the transition shorthand.
 *
 * M031 (warnings):
 *   - kinds of which none declares anything: a readonly enum field says the same;
 *   - a field every kind declares with the same type: a common field;
 *   - a state no kind reaches;
 *   - an aggregate without kinds whose invariants require optional fields for some values of an enum field (`kind ==
 *     Kind.STORE implies exists(storeCode)`): the shape of kinds.
 */
export function checkKinds(model: SourceModel, rules: RuleSink): void {
    for (const agg of model.elements) {
        if (agg.kind !== 'aggregate') continue;
        const kinds = kindsOf(agg);
        if (!kinds.length) {
            checkKindShapedInvariants(agg, rules);
            continue;
        }
        checkCommonCommands(agg, kinds, rules);
        checkFactories(agg, kinds, rules);
        checkTag(agg, kinds, rules);
        if (statesOf(agg).length)
            for (const cmd of commandsOf(agg).filter((c) => c.transitions.length))
                rules.error(
                    'M030',
                    `Command '${cmd.name}' of '${agg.name}' uses the transition shorthand; with kinds and states, a command names its outcomes.`,
                    cmd.transitionsAt[0]!,
                    `write '${cmd.name}(…) { outcome <name>: ${cmd.transitions[0]!.from.map((r) => r.text).join(' | ')} -> ${cmd.transitions[0]!.to.map((r) => r.text).join(' | ')} … }'`,
                );
        checkIdioms(agg, kinds, rules);
    }
}

/** Whether a common command has behaviour of its own (as opposed to only a signature that the kinds' cases complete). */
const hasBehaviour = (c: CommandDecl): boolean => c.outcomes.length > 0 || c.transitions.length > 0 || c.changes.length > 0 || c.emits.length > 0;

function checkCommonCommands(agg: AggregateDecl, kinds: KindDecl[], rules: RuleSink): void {
    const common = new Set(commonCommandsOf(agg));
    for (const k of kinds) {
        const seen = new Set<string>();
        for (const c of k.cases) {
            const target = c.command.target;
            if (!target) continue; // unresolved: M001
            if (!common.has(target)) {
                rules.error(
                    'M030',
                    `'on ${c.command.text}' in kind '${k.name}' names a command of kind '${target.ofKind}'; an 'on' case gives the outcomes of a common command.`,
                    c.command.at,
                    `put the outcomes in '${target.name}' itself, or declare '${target.name}' outside the kinds`,
                );
                continue;
            }
            if (target.factory) {
                rules.error(
                    'M030',
                    `'on ${c.command.text}' in kind '${k.name}' names a create command; the create commands of '${agg.name}' are declared in its kinds.`,
                    c.command.at,
                    `move '${target.name}' into the kinds as one 'create command' per kind`,
                );
                continue;
            }
            if (seen.has(target.name)) rules.error('M030', `Kind '${k.name}' has more than one 'on ${target.name}' case.`, c.at, 'merge the cases into one');
            seen.add(target.name);
        }
    }
    for (const cmd of common) {
        if (cmd.factory) continue;
        const withCase = kinds.filter((k) => k.cases.some((c) => c.command.target === cmd));
        if (!withCase.length) continue; // a common behaviour (possibly none)
        if (hasBehaviour(cmd))
            for (const k of withCase)
                for (const c of k.cases.filter((x) => x.command.target === cmd))
                    rules.error(
                        'M030',
                        `Command '${cmd.name}' has a common behaviour, and kind '${k.name}' gives it its own in 'on ${cmd.name}'; a command's behaviour is either common or in every kind's 'on' case.`,
                        c.at,
                        `remove the outcomes (and transitions, changes, emits) of '${cmd.name}' and give each kind an 'on ${cmd.name}' case, or remove this case`,
                    );
        const missing = kinds.filter((k) => !withCase.includes(k)).map((k) => k.name);
        if (missing.length && !hasBehaviour(cmd))
            rules.error(
                'M030',
                `Command '${cmd.name}' has its behaviour in the kinds' 'on' cases, but kind ${quoted(missing)} has no 'on ${cmd.name}'.`,
                cmd.nameAt,
                `add 'on ${cmd.name} { outcome … }' to kind ${quoted(missing)}; there is no fallback to a common behaviour`,
            );
    }
}

function checkFactories(agg: AggregateDecl, kinds: KindDecl[], rules: RuleSink): void {
    for (const cmd of commonCommandsOf(agg).filter((c) => c.factory))
        rules.error(
            'M030',
            `Create command '${cmd.name}' is common, but '${agg.name}' has kinds: the kind is fixed by the create command that makes the aggregate.`,
            cmd.nameAt,
            `declare a create command in each kind (e.g. 'kind ${kinds[0]!.name} { create command ${cmd.name}${kinds[0]!.name}(…) … }')`,
        );
    const factories = commandsOf(agg).filter((c) => c.factory);
    if (!factories.length) return; // the aggregate is made elsewhere
    for (const k of kinds)
        if (!factories.some((c) => c.ofKind === k.name))
            rules.error(
                'M030',
                `Kind '${k.name}' of '${agg.name}' has no create command, so no '${agg.name}' of that kind can be made.`,
                k.nameAt,
                `add 'create command …' to kind '${k.name}'`,
            );
}

function checkTag(agg: AggregateDecl, kinds: KindDecl[], rules: RuleSink): void {
    const states = new Set(statesOf(agg).map((st) => st.name));
    for (const k of kinds.filter((x) => states.has(x.name)))
        rules.error(
            'M030',
            `Kind '${k.name}' of '${agg.name}' has the name of one of its states.`,
            k.nameAt,
            `rename the kind or the state; kinds and states are told apart by name`,
        );
    const fields = [
        ...includedFields(agg).map((x) => x.field),
        ...commonFields(agg),
        ...kinds.flatMap(kindFields),
        ...statesOf(agg).flatMap((s) => fieldsOf(s.members)),
    ];
    for (const f of fields.filter((x) => x.name === KIND_TAG))
        rules.error(
            'M030',
            `Field '${KIND_TAG}' of '${agg.name}' has the name of the discriminator of its kinds.`,
            f.nameAt,
            `rename the field; the kind of a '${agg.name}' is its 'kind' block`,
        );
}

function checkIdioms(agg: AggregateDecl, kinds: KindDecl[], rules: RuleSink): void {
    const empty = (k: KindDecl): boolean => !k.members.length && !k.cases.length;
    if (kinds.every(empty))
        rules.warning(
            'M031',
            `No kind of '${agg.name}' declares a field, an invariant, a command or an 'on' case: a classification fixed at creation is a readonly enum field.`,
            agg.nameAt,
            `write 'readonly kind: …Kind' with an enum, and remove the kinds; use kinds when they differ in fields, rules or commands`,
        );
    if (kinds.length > 1) {
        const [first, ...rest] = kinds;
        for (const f of kindFields(first!)) {
            const t = memberType(f);
            const same = (k: KindDecl): FieldDecl | undefined =>
                kindFields(k).find((g) => g.name === f.name && sameType(memberType(g), t) && !!g.multiplicity === !!f.multiplicity);
            if (rest.every(same))
                rules.warning(
                    'M031',
                    `Every kind of '${agg.name}' declares field '${f.name}' with the same type: it is a common field.`,
                    f.nameAt,
                    `declare '${f.name}' once among the common fields of '${agg.name}', and remove it from the kinds`,
                );
        }
    }
    const states = statesOf(agg);
    if (states.length && commandsOf(agg).some((c) => c.factory)) {
        const reached = reachedStates(agg, kinds);
        for (const s of states)
            if (!reached.has(s.name))
                rules.warning(
                    'M031',
                    `No kind of '${agg.name}' reaches state '${s.name}'.`,
                    s.nameAt,
                    `add an outcome that ends in '${s.name}', or remove the state`,
                );
    }
}

/** The states some kind reaches from where its create commands end (as `validStates` derives them). */
function reachedStates(agg: AggregateDecl, kinds: KindDecl[]): Set<string> {
    const commands = commandsOf(agg);
    const out = new Set<string>();
    for (const k of kinds) {
        const mine = commands.filter((c) => !c.ofKind || c.ofKind === k.name);
        const outcomes = (c: CommandDecl) => [...c.outcomes, ...k.cases.filter((x) => x.command.text === c.name).flatMap((x) => x.outcomes)];
        const initials = [
            ...agg.members.flatMap((m) => (m.kind === 'initial' ? [m.state.text] : [])),
            ...k.members.flatMap((m) => (m.kind === 'initial' ? [m.state.text] : [])),
            ...mine.filter((c) => c.factory).flatMap((c) => [...c.transitions.flatMap((t) => t.to.map((r) => r.text)), ...outcomes(c).map((o) => o.to.text)]),
        ];
        const seen = new Set(initials);
        let changed = true;
        while (changed) {
            changed = false;
            for (const c of mine.filter((x) => !x.factory)) {
                const targets = [
                    ...c.transitions.filter((t) => t.from.some((f) => seen.has(f.text))).flatMap((t) => t.to.map((r) => r.text)),
                    ...outcomes(c)
                        .filter((o) => o.from.some((f) => seen.has(f.text)))
                        .map((o) => o.to.text),
                ];
                for (const t of targets)
                    if (!seen.has(t)) {
                        seen.add(t);
                        changed = true;
                    }
            }
        }
        for (const s of seen) out.add(s);
    }
    return out;
}

/**
 * M031 for an aggregate without kinds: invariants that require optional fields only for some values of an enum field
 * (`kind == Kind.STORE implies exists(storeCode)`), for at least two values. The fields of such an aggregate depend on
 * a classification: kinds say it, and the generated type then has no optional fields to check.
 */
function checkKindShapedInvariants(agg: AggregateDecl, rules: RuleSink): void {
    const fields = [...includedFields(agg).map((x) => x.field), ...commonFields(agg)];
    const enumField = (name: string): FieldDecl | undefined => fields.find((f) => f.name === name && !f.multiplicity && f.type?.decl?.target?.kind === 'enum');
    const optional = (name: string): boolean => fields.some((f) => f.name === name && !!f.multiplicity?.optional);
    /** For `F == E.V implies …exists(f)…`: the enum field, the value and the optional fields it requires. */
    const shapes = invariantsOf(agg.members).flatMap((inv) => {
        const e = inv.expr;
        if (e?.k !== 'binary' || e.op !== 'implies') return [];
        const cond = e.left;
        if (cond.k !== 'binary' || cond.op !== '==' || cond.left.k !== 'name' || cond.right.k !== 'member') return [];
        const field = enumField(cond.left.name);
        if (!field) return [];
        const required = existsNames(e.right).filter(optional);
        return required.length ? [{ field: field.name, value: cond.right.member, required, at: inv.nameAt }] : [];
    });
    const byField = new Map<string, typeof shapes>();
    for (const s of shapes) byField.set(s.field, [...(byField.get(s.field) ?? []), s]);
    for (const [field, items] of byField) {
        const values = [...new Set(items.map((i) => i.value))];
        if (values.length < 2) continue;
        const required = [...new Set(items.flatMap((i) => i.required))];
        rules.warning(
            'M031',
            `The invariants of '${agg.name}' require optional field ${quoted(required)} only for some values of '${field}' (${quoted(values)}): fields that depend on a classification fixed at creation are the fields of kinds.`,
            items[0]!.at,
            `declare 'kind ${values[0]} { … }' (one per value) with the fields each needs, not optional, and remove '${field}' and these invariants (dt guide kinds)`,
        );
    }
}

/** The fields named by `exists(f)` in a conjunction. */
function existsNames(e: Expr): string[] {
    if (e.k === 'exists' && e.operand.k === 'name') return [e.operand.name];
    if (e.k === 'binary' && e.op === 'and') return [...existsNames(e.left), ...existsNames(e.right)];
    return [];
}
