import type { RuleSink } from '../diagnostics.js';
import { contextLabel, fieldLabel, termFor } from '../labels.js';
import {
    commandsOf,
    commonFields,
    elementsOf,
    fieldsOf,
    includedFields,
    invariantsOf,
    isShared,
    statesOf,
    variantFields,
    type FieldDecl,
    type ParamDecl,
    type Site,
    type SourceModel,
    type WithFieldSets,
} from '../source-model.js';
import { didYouMean } from '@domaintrail/kernel';

/** A field or parameter with the context it is declared in (its label may come from a term of that context). */
interface InContext {
    field: FieldDecl | ParamDecl;
    context: string;
}

/**
 * Japanese names (all warnings, except duplicate terms):
 *   M002  a term is defined more than once in a context
 *   L001  an inline field label disagrees with the context's term, or context fragments disagree on its label
 *   L002  a term is not used by any field or parameter of its context
 *   L003  two things in the same scope have the same Japanese name
 */
export function checkLabels(model: SourceModel, rules: RuleSink): void {
    for (const ctx of model.contexts) {
        const fragments = model.fragments.filter((c) => c.name === ctx);
        const label = contextLabel(model, ctx);
        for (const f of fragments) {
            if (f.label && f.label !== label) {
                rules.warning(
                    'L001',
                    `Context '${ctx}' is named '${label}' elsewhere, but '${f.label}' here.`,
                    f.labelAt,
                    `use one name for the context in every file, or omit it here`,
                );
            }
        }

        // Terms: duplicates and usage.
        const seen = new Set<string>();
        // Terms of a shared context may be used by fields of any context.
        const used = new Set(isShared(model, ctx) ? allFields(model).map((f) => f.field.name) : fieldNamesIn(model, ctx));
        for (const entry of fragments.flatMap((c) => c.terms)) {
            if (seen.has(entry.name)) {
                rules.error('M002', `Term '${entry.name}' is defined more than once in context '${ctx}'.`, entry.nameAt);
                continue;
            }
            seen.add(entry.name);
            if (!used.has(entry.name)) {
                const hint = didYouMean(entry.name, [...used]) ?? `remove the term, or use the name for a field or parameter`;
                rules.warning('L002', `Term '${entry.name}' ("${entry.label}") is not used by any field or parameter in context '${ctx}'.`, entry.nameAt, hint);
            }
        }

        // Context-level declarations share one namespace of Japanese names.
        sameLabel(
            elementsOf(model, ctx).map((e) => ({ at: e.labelAt, name: e.name, label: e.label })),
            `context '${ctx}'`,
            rules,
        );
    }

    for (const { field, context } of allFields(model)) {
        if (!field.label) continue;
        const term = termFor(model, context, field.name);
        if (term && term.label !== field.label) {
            rules.warning(
                'L001',
                `'${field.name}' is named '${field.label}' here, but the term '${field.name}' is '${term.label}'.`,
                field.labelAt,
                `remove the label to use the term, or rename the field if it means something else`,
            );
        }
    }

    /** `inherited` fields were already checked in their own scope (common fields seen from a state). */
    const fieldScope = (fields: InContext[], where: string, inherited: InContext[] = []): void =>
        sameLabel(
            [...inherited.map((f) => ({ f, inherited: true })), ...fields.map((f) => ({ f, inherited: false }))].map(
                ({ f: { field, context }, inherited }) => ({
                    at: field.label ? field.labelAt : field.nameAt,
                    name: field.name,
                    label: fieldLabel(model, context, field)?.label,
                    inherited,
                }),
            ),
            where,
            rules,
        );

    for (const el of model.elements) {
        const own = (fields: (FieldDecl | ParamDecl)[]): InContext[] => fields.map((field) => ({ field, context: el.context }));
        const fromFieldSets = (e: WithFieldSets): InContext[] => includedFields(e).map((x) => ({ field: x.field, context: x.fieldSet.context }));
        if (el.kind === 'enum') {
            sameLabel(
                el.values.map((v) => ({ at: v.labelAt, name: v.name, label: v.label })),
                `enum '${el.name}'`,
                rules,
            );
        } else if (el.kind === 'union') {
            sameLabel(
                el.variants.map((v) => ({ at: v.labelAt, name: v.name, label: v.label })),
                `union '${el.name}'`,
                rules,
            );
            for (const v of el.variants) {
                fieldScope(own(fieldsOf(v.members)), `variant '${el.name}.${v.name}'`);
                sameLabel(
                    invariantsOf(v.members).map((i) => ({ at: i.labelAt, name: i.name, label: i.label })),
                    `the invariants of '${el.name}.${v.name}'`,
                    rules,
                );
            }
        } else if (el.kind === 'aggregate') {
            const included = fromFieldSets(el);
            const common = own(commonFields(el));
            const states = statesOf(el);
            fieldScope(common, `'${el.name}'`, included);
            for (const s of states) fieldScope(own(fieldsOf(s.members)), `state '${el.name}.${s.name}'`, [...included, ...common]);
            sameLabel(
                states.map((s) => ({ at: s.labelAt, name: s.name, label: s.label })),
                `the states of '${el.name}'`,
                rules,
            );
            sameLabel(
                commandsOf(el).map((c) => ({ at: c.labelAt, name: c.name, label: c.label })),
                `the commands of '${el.name}'`,
                rules,
            );
            const invariants = [...invariantsOf(el.members), ...states.flatMap((s) => invariantsOf(s.members))];
            sameLabel(
                invariants.map((i) => ({ at: i.labelAt, name: i.name, label: i.label })),
                `the invariants of '${el.name}'`,
                rules,
            );
            for (const c of commandsOf(el)) fieldScope(own(c.params), `command '${el.name}.${c.name}'`);
        } else if ('members' in el) {
            // fields of field sets were checked in the field set
            fieldScope(own(fieldsOf(el.members)), `'${el.name}'`, fromFieldSets(el));
            if (el.kind === 'entity' || el.kind === 'valueObject') {
                sameLabel(
                    invariantsOf(el.members).map((i) => ({ at: i.labelAt, name: i.name, label: i.label })),
                    `the invariants of '${el.name}'`,
                    rules,
                );
            }
        }
    }
}

interface Labeled {
    at: Site;
    name: string;
    label: string | undefined;
    inherited?: boolean;
}

/** L003: different names in one scope must not share a Japanese name. */
function sameLabel(items: Labeled[], where: string, rules: RuleSink): void {
    const byLabel = new Map<string, Labeled>();
    for (const item of items) {
        if (!item.label) continue;
        const first = byLabel.get(item.label);
        if (!first) {
            byLabel.set(item.label, item);
        } else if (first.name !== item.name && !(first.inherited && item.inherited)) {
            const hint = `give one of them another Japanese name (with a label, or a term)`;
            rules.warning('L003', `'${item.name}' and '${first.name}' are both named '${item.label}' in ${where}.`, item.at, hint);
        }
    }
}

/** Every field and parameter with its context, in the order of the sources. */
function allFields(model: SourceModel): InContext[] {
    const out: InContext[] = [];
    for (const el of model.elements) {
        const fields: (FieldDecl | ParamDecl)[] = [];
        if (el.kind === 'aggregate') {
            fields.push(...commonFields(el), ...statesOf(el).flatMap((s) => fieldsOf(s.members)), ...commandsOf(el).flatMap((c) => c.params));
        } else if (el.kind === 'union') {
            fields.push(...variantFields(el));
        } else if ('members' in el) {
            fields.push(...fieldsOf(el.members));
        }
        out.push(...fields.map((field) => ({ field, context: el.context })));
    }
    return out;
}

function fieldNamesIn(model: SourceModel, ctx: string): string[] {
    return allFields(model)
        .filter((f) => f.context === ctx)
        .map((f) => f.field.name);
}
