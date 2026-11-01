// The AST → model as written mapping (domain/source-model.ts): every declaration with its sites, its expressions as
// trees and its references resolved to the declarations they name. A site is what `DiagnosticSink` reports for the
// same node and property (both use `siteOf`), so that a rule moved onto the model reports the same ranges.
import type { AstNode, Reference } from 'langium';
import {
    isAggregate,
    isBinaryExpr,
    isBoolLiteral,
    isCommand,
    isContainsExpr,
    isCountExpr,
    isDecimalLiteral,
    isEntity,
    isEnumDecl,
    isErrorDecl,
    isEventDecl,
    isExistsExpr,
    isFieldSet,
    isIdType,
    isIntLiteral,
    isInvariant,
    isLengthExpr,
    isMatchesExpr,
    isMemberAccess,
    isNameRef,
    isNotExpr,
    isOwnsField,
    isPolicy,
    isPrimitiveDecl,
    isQuantifierExpr,
    isRangeExpr,
    isReferenceField,
    isState,
    isStringLiteral,
    isUnionDecl,
    isUniqueExpr,
    isValueObject,
    isVerifiedDecl,
    type Command,
    type Context,
    type ContextElement,
    type DataMember,
    type Emit,
    type Expression,
    type Field,
    type Invariant,
    type Multiplicity,
    type OutcomePattern,
    type Parameter,
    type Requirement,
    type State,
    type TermEntry,
    type Transition,
    type TypeRef,
} from './generated/ast.js';
import { docComment } from './labels.js';
import type { FieldLike, ModelIndex } from './model-index.js';
import { siteOf, type FileResolver } from './diagnostic-sink.js';
import { regexSource } from './regex-source.js';
import { commandId, elementId, stateId } from '../../domain/ids.js';
import type * as src from '../../domain/source-model.js';

/** Builds the model as written of the elements of `index` (the sources parse: every declaration has its name). */
export function buildSourceModel(index: ModelIndex, fileOf: FileResolver): src.SourceModel {
    /** The declaration built for each AST node that a reference may name. */
    const decls = new Map<AstNode, unknown>();
    /** References to resolve once every declaration is built. */
    const pending: [src.Ref<unknown>, AstNode | undefined][] = [];

    const site = (node: AstNode, property?: string, i?: number): src.Site => siteOf(node, fileOf, property, i);
    const ref = <T>(container: AstNode, property: string, r: Reference, i?: number): src.Ref<T> => {
        const out: src.Ref<T> = { text: r.$refText, at: site(container, property, i) };
        pending.push([out, r.ref]);
        return out;
    };
    const refs = <T>(container: AstNode, property: string, rs: readonly Reference[]): src.Ref<T>[] => rs.map((r, i) => ref<T>(container, property, r, i));
    /** Name, label, description and their sites. */
    const declared = (node: AstNode & { name: string; label?: string }): src.Declared => ({
        name: node.name,
        ...(node.label !== undefined && { label: node.label }),
        ...optionalDoc(node),
        at: site(node),
        nameAt: site(node, 'name'),
        labelAt: site(node, 'label'),
    });

    const typeRef = (t: TypeRef | undefined): src.TypeRef | undefined =>
        t && {
            ...(t.primitive && { primitive: t.primitive }),
            ...(t.decl && { decl: ref<src.TypeDecl>(t, 'decl', t.decl) }),
            at: site(t),
        };

    const expr = (e: Expression): src.Expr => {
        const base = { at: site(e), text: e.$cstNode?.text.replace(/\s+/g, ' ').trim() ?? '' };
        if (isBoolLiteral(e)) return { ...base, k: 'bool', value: e.value === 'true' };
        if (isIntLiteral(e)) return { ...base, k: 'int', value: e.value, negative: e.negative };
        if (isDecimalLiteral(e)) return { ...base, k: 'decimal', value: e.value, negative: e.negative };
        if (isStringLiteral(e)) return { ...base, k: 'string', value: e.value };
        if (isNameRef(e)) return { ...base, k: 'name', name: e.name };
        if (isMemberAccess(e)) return { ...base, k: 'member', receiver: expr(e.receiver), member: e.member, memberAt: site(e, 'member') };
        if (isNotExpr(e)) return { ...base, k: 'not', operand: expr(e.operand) };
        if (isBinaryExpr(e))
            return { ...base, k: 'binary', op: e.op, left: expr(e.left), right: expr(e.right), leftAt: site(e, 'left'), rightAt: site(e, 'right') };
        if (isRangeExpr(e)) return { ...base, k: 'range', operand: expr(e.operand), lower: expr(e.lower), upper: expr(e.upper) };
        if (isCountExpr(e)) return { ...base, k: 'count', collection: expr(e.collection), collectionAt: site(e, 'collection') };
        if (isExistsExpr(e)) return { ...base, k: 'exists', operand: expr(e.operand), operandAt: site(e, 'operand') };
        if (isLengthExpr(e)) return { ...base, k: 'length', operand: expr(e.operand), operandAt: site(e, 'operand') };
        if (isMatchesExpr(e))
            return { ...base, k: 'matches', operand: expr(e.operand), pattern: regexSource(e), operandAt: site(e, 'operand'), patternAt: site(e, 'pattern') };
        if (isUniqueExpr(e))
            return {
                ...base,
                k: 'unique',
                collection: expr(e.collection),
                ...(e.param && { param: e.param.name }),
                keys: e.keys.map(expr),
                collectionAt: site(e, 'collection'),
                keysAt: e.keys.map((_, i) => site(e, 'keys', i)),
            };
        if (isContainsExpr(e))
            return {
                ...base,
                k: 'contains',
                collection: expr(e.collection),
                element: expr(e.element),
                collectionAt: site(e, 'collection'),
                elementAt: site(e, 'element'),
            };
        if (isQuantifierExpr(e))
            return {
                ...base,
                k: 'quantifier',
                quantifier: e.quantifier,
                collection: expr(e.collection),
                param: e.param.name,
                body: expr(e.body),
                collectionAt: site(e, 'collection'),
                bodyAt: site(e, 'body'),
            };
        throw new Error(`unknown expression ${(e as AstNode).$type}`);
    };

    const field = (f: FieldLike): src.FieldDecl => ({
        ...declared(f),
        kind: isOwnsField(f) ? 'owns' : isReferenceField(f) ? 'references' : 'field',
        ...withType(f),
        ...(isReferenceField(f) && f.target && { aggregate: ref<src.AggregateDecl>(f, 'target', f.target) }),
        typeAt: site(f, 'type'),
    });
    const withType = (f: FieldLike | Parameter): { type?: src.TypeRef; multiplicity?: src.Multiplicity } => {
        const type = typeRef(f.type);
        return { ...(type && { type }), ...(f.multiplicity && { multiplicity: multiplicity(f.multiplicity) }) };
    };
    const param = (p: Parameter): src.ParamDecl => ({ ...declared(p), kind: 'param', ...withType(p), typeAt: site(p, 'type') });
    const invariant = (i: Invariant): src.InvariantDecl => ({
        ...declared(i),
        kind: 'invariant',
        ...(i.expr && { expr: expr(i.expr) }),
        exprAt: site(i, 'expr'),
    });
    const dataMember = (m: DataMember): src.DataMember => (isInvariant(m) ? invariant(m) : field(m));

    const state = (aggId: string, s: State): src.StateDecl => {
        const out: src.StateDecl = { ...declared(s), kind: 'state', id: stateId(aggId, s.name), members: s.members.map(dataMember) };
        decls.set(s, out);
        return out;
    };
    const transition = (t: Transition | OutcomePattern): { from: src.Ref<src.StateDecl>[]; to: src.Ref<src.StateDecl>[]; at: src.Site } => ({
        from: refs<src.StateDecl>(t, 'from', t.from),
        to: refs<src.StateDecl>(t, 'to', t.to),
        at: site(t),
    });
    const emit = (e: Emit): src.EmitDecl => ({
        event: ref<src.EventDecl>(e, 'event', e.event),
        ...(e.multiplicity && { multiplicity: multiplicity(e.multiplicity) }),
        ...(e.when && { when: transition(e.when) }),
        at: site(e),
        whenAt: site(e, 'when'),
    });
    const requirement = (r: Requirement): src.RequirementDecl => ({
        ...declared(r),
        ...(r.expr && { expr: expr(r.expr) }),
        error: ref<src.ErrorDecl>(r, 'error', r.error),
        exprAt: site(r, 'expr'),
    });
    const command = (aggId: string, c: Command): src.CommandDecl => {
        const out: src.CommandDecl = {
            ...declared(c),
            kind: 'command',
            id: commandId(aggId, c.name),
            factory: c.factory,
            params: c.params.map(param),
            transitions: c.transitions.map(transition),
            transitionsAt: c.transitions.map((_, i) => site(c, 'transitions', i)),
            requirements: c.requirements.map(requirement),
            changes: c.changes.map((name, i) => ({ name, at: site(c, 'changes', i) })),
            emits: c.emits.map(emit),
            errors: refs<src.ErrorDecl>(c, 'errors', c.errors),
        };
        decls.set(c, out);
        return out;
    };

    const element = (el: ContextElement): src.ElementDecl => {
        const ctx = el.$container.name;
        const id = elementId(ctx, el.name);
        const base = { ...declared(el), id, context: ctx };
        const fieldSets = (): { fieldSets: src.Ref<src.FieldSetDecl>[] } =>
            'fieldSets' in el ? { fieldSets: refs<src.FieldSetDecl>(el, 'fieldSets', el.fieldSets) } : { fieldSets: [] };
        if (isIdType(el) || isPrimitiveDecl(el))
            return {
                ...base,
                kind: isIdType(el) ? 'id' : 'primitive',
                ...(el.base && { base: el.base }),
                invariants: el.invariants.map(invariant),
                ...(el.constraint && { constraint: expr(el.constraint) }),
            };
        if (isVerifiedDecl(el)) {
            const of = typeRef(el.base);
            const context = typeRef(el.context);
            return {
                ...base,
                kind: 'verified',
                ...(of && { base: of }),
                ...(context && { for: context }),
                forOptional: el.contextOptional,
                errors: refs<src.ErrorDecl>(el, 'errors', el.errors),
                baseAt: site(el, 'base'),
                forAt: site(el, 'context'),
            };
        }
        if (isEnumDecl(el)) return { ...base, kind: 'enum', values: el.values.map((v) => ({ ...declared(v) })) };
        if (isUnionDecl(el))
            return {
                ...base,
                kind: 'union',
                ...(el.discriminator !== undefined && { discriminator: el.discriminator }),
                ...(el.tagType && { tagType: ref<src.EnumDecl>(el, 'tagType', el.tagType) }),
                variants: el.variants.map((v) => ({ ...declared(v), members: v.members.map(dataMember) })),
            };
        if (isAggregate(el))
            return {
                ...base,
                kind: 'aggregate',
                ...fieldSets(),
                members: el.members.map((m) => (isState(m) ? state(id, m) : isCommand(m) ? command(id, m) : dataMember(m))),
            };
        if (isPolicy(el))
            return {
                ...base,
                kind: 'policy',
                event: ref<src.EventDecl>(el, 'event', el.event),
                aggregate: ref<src.AggregateDecl>(el, 'aggregate', el.aggregate),
                command: ref<src.CommandDecl>(el, 'command', el.command),
            };
        if (isEventDecl(el)) return { ...base, kind: 'event', ...fieldSets(), persistent: el.persistent, members: el.members.map((f: Field) => field(f)) };
        if (isErrorDecl(el)) return { ...base, kind: 'error', ...fieldSets(), members: el.members.map((f: Field) => field(f)) };
        if (isEntity(el)) return { ...base, kind: 'entity', ...fieldSets(), members: el.members.map(dataMember) };
        if (isValueObject(el)) return { ...base, kind: 'valueObject', ...fieldSets(), members: el.members.map(dataMember) };
        if (isFieldSet(el)) return { ...base, kind: 'fieldSet', ...fieldSets(), members: el.members.map(dataMember) };
        throw new Error(`unknown element ${(el as AstNode).$type}`);
    };

    const term = (t: TermEntry): src.TermDecl => ({
        name: t.name,
        label: t.label,
        ...optionalDoc(t),
        at: site(t),
        nameAt: site(t, 'name'),
        labelAt: site(t, 'label'),
    });
    const fragment = (c: Context): src.ContextFragment => ({
        name: c.name,
        shared: c.shared,
        ...(c.label !== undefined && { label: c.label }),
        ...optionalDoc(c),
        terms: c.terms.flatMap((block) => block.entries.map(term)),
        at: site(c),
        nameAt: site(c, 'name'),
        labelAt: site(c, 'label'),
    });

    const fragments = index.fragments.map(fragment);
    const elements = index.elements.map((el) => {
        const out = element(el);
        decls.set(el, out);
        return out;
    });
    for (const [r, target] of pending) {
        const decl = target && decls.get(target);
        if (decl) r.target = decl;
    }
    const byName = new Map<string, src.ElementDecl[]>();
    for (const el of elements) byName.set(el.id, [...(byName.get(el.id) ?? []), el]);
    return { fragments, elements, contexts: index.contextNames, sharedContexts: index.sharedContexts, byName };
}

const multiplicity = (m: Multiplicity): src.Multiplicity => ({
    optional: m.optional,
    ...(m.lower !== undefined && { lower: m.lower }),
    ...(m.upper !== undefined && { upper: m.upper }),
    unbounded: m.unbounded,
});

function optionalDoc(node: AstNode): { doc?: string } {
    const doc = docComment(node);
    return doc ? { doc } : {};
}
