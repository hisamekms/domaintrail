// The AST → model as written mapping (domain/source-model.ts): every declaration with its sites, its expressions as
// trees and its references resolved to the declarations they name. A site is the range of a node or of one of its
// properties (`siteOf`), where Modeling's rules report.
import { methodForm, nullComparison, patternSource } from './methods.js';
import type { AstNode, Reference } from 'langium';
import {
    isAggregate,
    isInitial,
    isKind,
    isCommandCase,
    isBinaryExpr,
    isBoolLiteral,
    isCommand,
    isCallExpr,
    isConditionalExpr,
    isListLiteral,
    isMatchExpr,
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
    isNullLiteral,
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
    type Outcome,
    type Kind,
    type Context,
    type ContextElement,
    type DataMember,
    type Emit,
    type Expression,
    type Field,
    type Invariant,
    type Initial,
    type Multiplicity,
    type OutcomePattern,
    type Parameter,
    type Requirement,
    type State,
    type TermEntry,
    type Transition,
    type TypeRef,
} from './generated/ast.js';
import { docComment, docCommentBlock } from './labels.js';
import type { FieldLike, ModelIndex } from './model-index.js';
import { rangeSiteOf, siteOf, type FileResolver } from './site.js';
import { regexSource } from './regex-source.js';
import { commandId, elementId, kindId, stateId } from '../../domain/ids.js';
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
            ...(t.scale !== undefined && { scale: t.scale }),
            ...(t.decl && { decl: ref<src.TypeDecl>(t, 'decl', t.decl) }),
            at: site(t),
        };

    // M3 (trial): the parameters of the `.with` handlers being lowered, each with the variant's fields it reads
    const handlers: { readonly param: string; readonly fields: string[] }[] = [];
    /** A `.with` handler `v => value`: `v.field` reads the field of the matched variant, as A0's binding does. */
    const narrowedHandler = (param: string, body: () => src.Expr): { body: src.Expr; bindings: string[] } => {
        const handler = { param, fields: [] as string[] };
        handlers.push(handler);
        try {
            return { body: body(), bindings: handler.fields };
        } finally {
            handlers.pop();
        }
    };

    const expr = (e: Expression): src.Expr => {
        const base = { at: site(e), text: e.$cstNode?.text.replace(/\s+/g, ' ').trim() ?? '' };
        if (isBoolLiteral(e)) return { ...base, k: 'bool', value: e.value === 'true' };
        if (isIntLiteral(e)) return { ...base, k: 'int', value: e.value, negative: e.negative };
        if (isDecimalLiteral(e)) return { ...base, k: 'decimal', value: e.value, negative: e.negative };
        if (isStringLiteral(e)) return { ...base, k: 'string', value: e.value };
        if (isNameRef(e)) return { ...base, k: 'name', name: e.name };
        const handler = handlers.at(-1);
        if (handler && isMemberAccess(e) && !e.call && !e.optional && isNameRef(e.receiver) && e.receiver.name === handler.param) {
            if (!handler.fields.includes(e.member)) handler.fields.push(e.member);
            return { ...base, k: 'name', name: e.member };
        }
        if (isMemberAccess(e)) {
            // the method forms of Phase 2 (`xs.every(x => p)`, `x.length`, …) are the expressions their functions were
            const m = methodForm(e);
            const receiver = expr(e.receiver);
            const receiverAt = site(e, 'receiver');
            if (m.k === 'length') return { ...base, k: 'length', operand: receiver, operandAt: receiverAt };
            if (m.k === 'quantifier')
                return {
                    ...base,
                    k: 'quantifier',
                    quantifier: m.quantifier,
                    method: m.method,
                    collection: receiver,
                    param: m.param,
                    body: expr(m.body),
                    collectionAt: receiverAt,
                    bodyAt: site(e, 'args', 0),
                };
            if (m.k === 'contains')
                return { ...base, k: 'contains', collection: receiver, element: expr(m.element), collectionAt: receiverAt, elementAt: site(e, 'args', 0) };
            if (m.k === 'unique')
                return {
                    ...base,
                    k: 'unique',
                    collection: receiver,
                    ...(m.param !== undefined && { param: m.param }),
                    keys: m.keys.map(expr),
                    collectionAt: receiverAt,
                    keysAt: m.keys.map((_, i) => site(e, 'args', i)),
                };
            if (m.k === 'matches')
                return { ...base, k: 'matches', operand: receiver, pattern: patternSource(m.pattern), operandAt: receiverAt, patternAt: site(e, 'args', 0) };
            if (m.k === 'round') return { ...base, k: 'round', operand: receiver, scale: expr(m.scale), operandAt: receiverAt, scaleAt: site(e, 'args', 0) };
            if (m.k === 'listMethod')
                return {
                    ...base,
                    k: 'listMethod',
                    method: m.method,
                    collection: receiver,
                    ...(m.param !== undefined && { param: m.param }),
                    ...(m.body && { body: expr(m.body), bodyAt: site(e, 'args', 0) }),
                    collectionAt: receiverAt,
                };
            // a call that is no method form is reported as such (parse.ts); it checks as nothing more
            if (m.k === 'invalid') return { ...base, k: 'bool', value: false };
            return { ...base, k: 'member', receiver, member: e.member, memberAt: site(e, 'member'), ...(e.optional && { optional: true }) };
        }
        const nullCompared = nullComparison(e);
        if (nullCompared) {
            const exists: src.Expr = { ...base, k: 'exists', operand: expr(nullCompared.operand), operandAt: site(nullCompared.operand) };
            return nullCompared.present ? exists : { ...base, k: 'not', operand: exists };
        }
        if (isNullLiteral(e)) return { ...base, k: 'bool', value: false }; // `null` alone is reported (parse.ts)
        if (isNotExpr(e)) return { ...base, k: 'not', operand: expr(e.operand) };
        if (isBinaryExpr(e))
            return {
                ...base,
                k: 'binary',
                op: e.op === '&&' ? 'and' : e.op === '||' ? 'or' : e.op,
                left: expr(e.left),
                right: expr(e.right),
                leftAt: site(e, 'left'),
                rightAt: site(e, 'right'),
            };
        if (isMatchExpr(e))
            return {
                ...base,
                k: 'match',
                subject: expr(e.subject),
                subjectAt: site(e, 'subject'),
                // the trial's M2 and M3 spellings (trial-arm.ts) build the same cases as A0's
                cases: [
                    ...e.cases.map((c) => ({ variant: c.variant, bindings: [...c.bindings], body: expr(c.body), at: site(c), variantAt: site(c, 'variant') })),
                    ...e.whenCases.map((c) => ({
                        variant: c.variant,
                        bindings: [...c.bindings],
                        body: expr(c.body),
                        at: site(c),
                        variantAt: site(c, 'variant'),
                        tag: { key: c.tagKey, union: c.tagType, at: site(c, 'tagKey') },
                    })),
                    ...e.withCases.map((c) => {
                        const { body, bindings } = narrowedHandler(c.param.name, () => expr(c.body));
                        return {
                            variant: c.variant,
                            bindings,
                            body,
                            at: site(c),
                            variantAt: site(c, 'variant'),
                            tag: { key: c.tagKey, union: c.tagType, at: site(c, 'tagKey') },
                        };
                    }),
                ],
            };
        if (isCallExpr(e))
            return {
                ...base,
                k: 'call',
                name: e.function,
                args: e.args.map(expr),
                nameAt: site(e, 'function'),
                argsAt: e.args.map((_, i) => site(e, 'args', i)),
            };
        if (isListLiteral(e)) return { ...base, k: 'list', items: e.items.map((i) => ({ spread: i.spread, value: expr(i.value) })) };
        if (isConditionalExpr(e))
            return {
                ...base,
                k: 'conditional',
                test: expr(e.test),
                ifTrue: expr(e.ifTrue),
                ifFalse: expr(e.ifFalse),
                testAt: site(e, 'test'),
                ifTrueAt: site(e, 'ifTrue'),
                ifFalseAt: site(e, 'ifFalse'),
            };
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
        readonly: 'readonly' in f && f.readonly === true,
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
        ...(i.external && { externalReason: i.external.reason }),
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
        ...(r.external && { externalReason: r.external.reason }),
    });
    const outcome = (o: Outcome): src.OutcomeDecl => ({
        ...declared(o),
        from: refs<src.StateDecl>(o, 'from', o.from),
        to: ref<src.StateDecl>(o, 'to', o.to),
        changes: o.changes.map((c, i) => ({ name: c.field, at: site(o, 'changes', i), ...(c.value && { value: expr(c.value) }) })),
        emits: o.emits.map(emit),
        ...(o.ensures && { ensures: expr(o.ensures) }),
        ...((o.selectExpr || o.selectText !== undefined) && {
            select: {
                ...(o.selectExpr && { expr: expr(o.selectExpr) }),
                ...(o.selectText !== undefined && { text: o.selectText }),
                ...(o.external && { externalReason: o.external.reason }),
                at: site(o, 'selectExpr'),
            },
        }),
    });
    const initial = (i: Initial): src.InitialDecl => ({
        state: ref<src.StateDecl>(i, 'state', i.state),
        at: site(i),
    });
    const kind = (aggId: string, k: Kind): src.KindDecl => ({
        ...declared(k),
        kind: 'kind',
        id: kindId(aggId, k.name),
        members: k.members.flatMap((m): src.KindMember[] =>
            isCommand(m)
                ? [command(aggId, m)]
                : isInitial(m)
                  ? [{ ...initial(m), kind: 'initial', name: m.state.$refText }]
                  : isCommandCase(m)
                    ? []
                    : [dataMember(m)],
        ),
        cases: k.members.filter(isCommandCase).map((c) => ({
            command: ref<src.CommandDecl>(c, 'command', c.command),
            requirements: c.requirements.map(requirement),
            outcomes: c.outcomes.map(outcome),
            at: site(c),
        })),
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
            changes: c.changes.map((ch, i) => ({ name: ch.field, at: site(c, 'changes', i), ...(ch.value && { value: expr(ch.value) }) })),
            emits: c.emits.map(emit),
            ...(c.ensures && { ensures: expr(c.ensures) }),
            errors: refs<src.ErrorDecl>(c, 'errors', c.errors),
            outcomes: c.outcomes.map(outcome),
            ...(isKind(c.$container) && { ofKind: c.$container.name }),
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
                ...(el.scale !== undefined && { scale: el.scale }),
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
                members: el.members.map((m) =>
                    isState(m)
                        ? state(id, m)
                        : isCommand(m)
                          ? command(id, m)
                          : isInitial(m)
                            ? { ...initial(m), kind: 'initial', name: m.state.$refText }
                            : isKind(m)
                              ? kind(id, m)
                              : dataMember(m),
                ),
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
    const fragment = (c: Context): src.ContextFragment => {
        const doc = docCommentBlock(c);
        return {
            name: c.name,
            shared: c.shared,
            ...(c.label !== undefined && { label: c.label }),
            ...(doc && { doc: doc.text, docAt: rangeSiteOf(c, fileOf, doc.range) }),
            terms: c.terms.flatMap((block) => block.entries.map(term)),
            functions: c.functions.map((f) => ({
                ...declared(f),
                kind: 'function' as const,
                id: `${c.name}.${f.name}`,
                context: c.name,
                params: f.params.map(param),
                ...(typeRef(f.returns) && { returns: typeRef(f.returns) }),
                ...(f.multiplicity && { multiplicity: multiplicity(f.multiplicity) }),
                returnsAt: site(f, 'returns'),
                expr: expr(f.body),
            })),
            at: site(c),
            nameAt: site(c, 'name'),
            labelAt: site(c, 'label'),
        };
    };

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
