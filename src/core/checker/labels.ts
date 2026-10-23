import type { AstNode } from 'langium';
import { isAggregate, isEntity, isEnumDecl, isUnionDecl, isValueObject, type Parameter } from '../../language/generated/ast.js';
import type { DiagnosticSink } from '../diagnostics.js';
import { LabelResolver } from '../labels.js';
import { commandsOf, commonFields, fieldsOf, includedFields, invariantsOf, statesOf, variantFields, type FieldLike, type ModelIndex } from '../model-index.js';
import { didYouMean } from '../suggest.js';

/**
 * Japanese names (all warnings, except duplicate terms):
 *   M002  a term is defined more than once in a context
 *   L001  an inline field label disagrees with the context's term, or context fragments disagree on its label
 *   L002  a term is not used by any field or parameter of its context
 *   L003  two things in the same scope have the same Japanese name
 */
export function checkLabels(index: ModelIndex, sink: DiagnosticSink): void {
    const labels = new LabelResolver(index);

    for (const ctx of index.contextNames) {
        const fragments = index.fragments.filter((c) => c.name === ctx);
        const contextLabel = labels.contextLabel(ctx);
        for (const f of fragments) {
            if (f.label && f.label !== contextLabel) {
                sink.warning('L001', `Context '${ctx}' is named '${contextLabel}' elsewhere, but '${f.label}' here.`, f, 'label', undefined, `use one name for the context in every file, or omit it here`);
            }
        }

        // Terms: duplicates and usage.
        const seen = new Set<string>();
        // Terms of a shared context may be used by fields of any context.
        const used = new Set(index.isShared(ctx) ? allFields(index).map((f) => f.name) : fieldNamesIn(index, ctx));
        for (const block of fragments.flatMap((c) => c.terms)) {
            for (const entry of block.entries) {
                if (seen.has(entry.name)) {
                    sink.error('M002', `Term '${entry.name}' is defined more than once in context '${ctx}'.`, entry, 'name');
                    continue;
                }
                seen.add(entry.name);
                if (!used.has(entry.name)) {
                    const hint = didYouMean(entry.name, [...used]) ?? `remove the term, or use the name for a field or parameter`;
                    sink.warning('L002', `Term '${entry.name}' ("${entry.label}") is not used by any field or parameter in context '${ctx}'.`, entry, 'name', undefined, hint);
                }
            }
        }

        // Context-level declarations share one namespace of Japanese names.
        sameLabel(index.elementsOf(ctx).map((e) => ({ node: e, name: e.name, label: e.label })), `context '${ctx}'`, sink);
    }

    for (const field of allFields(index)) {
        if (!field.label) continue;
        const ctx = ctxOf(field);
        const term = ctx ? labels.termFor(ctx, field.name) : undefined;
        if (term && term.label !== field.label) {
            sink.warning(
                'L001',
                `'${field.name}' is named '${field.label}' here, but the term '${field.name}' is '${term.label}'.`,
                field,
                'label',
                undefined,
                `remove the label to use the term, or rename the field if it means something else`,
            );
        }
    }

    /** `inherited` fields were already checked in their own scope (common fields seen from a state). */
    const fieldScope = (fields: (FieldLike | Parameter)[], where: string, inherited: (FieldLike | Parameter)[] = []): void =>
        sameLabel(
            [...inherited.map((f) => ({ f, inherited: true })), ...fields.map((f) => ({ f, inherited: false }))].map(({ f, inherited }) => ({
                node: f,
                name: f.name,
                label: labels.fieldLabel(f)?.label,
                property: f.label ? 'label' : 'name',
                inherited,
            })),
            where,
            sink,
        );

    for (const el of index.elements) {
        if (isEnumDecl(el)) {
            sameLabel(el.values.map((v) => ({ node: v, name: v.name, label: v.label })), `enum '${el.name}'`, sink);
        } else if (isUnionDecl(el)) {
            sameLabel(el.variants.map((v) => ({ node: v, name: v.name, label: v.label })), `union '${el.name}'`, sink);
            for (const v of el.variants) {
                fieldScope(fieldsOf(v.members), `variant '${el.name}.${v.name}'`);
                sameLabel(invariantsOf(v.members).map((i) => ({ node: i, name: i.name, label: i.label })), `the invariants of '${el.name}.${v.name}'`, sink);
            }
        } else if (isAggregate(el)) {
            const included = includedFields(el).map((x) => x.field);
            const common = commonFields(el);
            const states = statesOf(el);
            fieldScope(common, `'${el.name}'`, included);
            for (const s of states) fieldScope(fieldsOf(s.members), `state '${el.name}.${s.name}'`, [...included, ...common]);
            sameLabel(states.map((s) => ({ node: s, name: s.name, label: s.label })), `the states of '${el.name}'`, sink);
            sameLabel(commandsOf(el).map((c) => ({ node: c, name: c.name, label: c.label })), `the commands of '${el.name}'`, sink);
            const invariants = [...invariantsOf(el.members), ...states.flatMap((s) => invariantsOf(s.members))];
            sameLabel(invariants.map((i) => ({ node: i, name: i.name, label: i.label })), `the invariants of '${el.name}'`, sink);
            for (const c of commandsOf(el)) fieldScope(c.params, `command '${el.name}.${c.name}'`);
        } else if ('members' in el) {
            // fields of field sets were checked in the field set
            fieldScope(fieldsOf(el.members), `'${el.name}'`, includedFields(el).map((x) => x.field));
            if (isEntity(el) || isValueObject(el)) {
                sameLabel(invariantsOf(el.members).map((i) => ({ node: i, name: i.name, label: i.label })), `the invariants of '${el.name}'`, sink);
            }
        }
    }
}

interface Labeled {
    node: AstNode;
    name: string;
    label: string | undefined;
    property?: string;
    inherited?: boolean;
}

/** L003: different names in one scope must not share a Japanese name. */
function sameLabel(items: Labeled[], where: string, sink: DiagnosticSink): void {
    const byLabel = new Map<string, Labeled>();
    for (const item of items) {
        if (!item.label) continue;
        const first = byLabel.get(item.label);
        if (!first) {
            byLabel.set(item.label, item);
        } else if (first.name !== item.name && !(first.inherited && item.inherited)) {
            const hint = `give one of them another Japanese name (with a label, or a term)`;
            sink.warning('L003', `'${item.name}' and '${first.name}' are both named '${item.label}' in ${where}.`, item.node, item.property ?? 'label', undefined, hint);
        }
    }
}

function ctxOf(node: AstNode): string | undefined {
    let n: AstNode | undefined = node;
    while (n && n.$type !== 'Context') n = n.$container;
    return (n as { name?: string } | undefined)?.name;
}

function allFields(index: ModelIndex): (FieldLike | Parameter)[] {
    const out: (FieldLike | Parameter)[] = [];
    for (const el of index.elements) {
        if (isAggregate(el)) {
            out.push(...commonFields(el), ...statesOf(el).flatMap((s) => fieldsOf(s.members)), ...commandsOf(el).flatMap((c) => c.params));
        } else if (isUnionDecl(el)) {
            out.push(...variantFields(el));
        } else if ('members' in el) {
            out.push(...fieldsOf(el.members));
        }
    }
    return out;
}

function fieldNamesIn(index: ModelIndex, ctx: string): string[] {
    return allFields(index)
        .filter((f) => ctxOf(f) === ctx)
        .map((f) => f.name);
}
