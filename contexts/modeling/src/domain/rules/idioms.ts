import type { RuleSink } from '../diagnostics.js';
import type { PrimitiveName } from '../model.js';
import {
    commandsOf,
    fieldsOf,
    identityField,
    lookupVisible,
    statesOf,
    type AggregateDecl,
    type ElementDecl,
    type FieldDecl,
    type IdDecl,
    type ParamDecl,
    type SourceModel,
    type UnionDecl,
} from '../source-model.js';
import { multiplicityText } from '../types.js';

/** The idioms of the DSL that `dt check` warns about: M026 (a union that is an enum), M027 (an ID kept as a primitive). */
export function checkIdioms(model: SourceModel, rules: RuleSink): void {
    checkFieldlessUnions(model, rules);
    checkPrimitiveIds(model, rules);
}

/**
 * M026 (warning): a union none of whose variants has a field is a closed set of values, an `enum`. A union is for
 * variants that carry different fields.
 */
function checkFieldlessUnions(model: SourceModel, rules: RuleSink): void {
    for (const u of model.elements.filter((e): e is UnionDecl => e.kind === 'union')) {
        if (u.variants.length === 0 || u.variants.some((v) => fieldsOf(v.members).length > 0)) continue;
        const bound = u.tagType?.target;
        const hint = bound
            ? `use the enum '${bound.name}' itself where '${u.name}' is used, and remove the union`
            : `write 'enum ${u.name} { ${u.variants.map((v) => v.name).join(' ')} }' instead`;
        rules.warning('M026', `No variant of union '${u.name}' has a field: a closed set of values is an enum.`, u.nameAt, hint);
    }
}

/** `customerId`, `customerID`, `customerIds`, `customerIDs`: the stem (`customer`) and whether it names several. */
const ID_NAME = /^([a-z][A-Za-z0-9]*?)(Id|ID)(s?)$/;

/** What a field or parameter named like an ID matches: an ID type, or an aggregate or entity with its identity's type. */
interface IdMatch {
    /** The ID type as the field would name it (`CustomerId`, `Sales.CustomerId` from another context). */
    idType: string;
    /** Its base type, when known. */
    base?: PrimitiveName;
    /** The aggregate it identifies, as it would be named, when the match is an aggregate (or `<Stem>Id` identifies one). */
    aggregate?: string;
}

/** The types an ID kept as a primitive is usually written as. */
const ID_PRIMITIVES: readonly PrimitiveName[] = ['String', 'UUID'];

/**
 * M027 (warning): a field or command parameter of a built-in type that holds the ID of something the model declares:
 * its name is `<stem>Id` (`ID`; `Ids` / `IDs` for several) and `<Stem>Id` (or `<Stem>ID`) is an ID type, or `<Stem>`
 * an aggregate or entity, seen from its context (its own, then the shared ones) or else, outside a shared context (which
 * depends on no other, M014), in exactly one other context; and its type is `String`, `UUID` or the base type of that ID type. The ID type says what it identifies, and
 * `references` names the aggregate. Fields named otherwise (an external system's `salesforceId`, a stem the model has
 * no type for) are not reported.
 */
function checkPrimitiveIds(model: SourceModel, rules: RuleSink): void {
    const check = (f: FieldDecl | ParamDecl, ctx: string, canReference: boolean): void => {
        const primitive = f.type?.primitive;
        const name = ID_NAME.exec(f.name);
        if (!primitive || !name) return;
        const stem = name[1][0].toUpperCase() + name[1].slice(1);
        const match = idMatch(model, ctx, stem);
        if (!match || !(ID_PRIMITIVES.includes(primitive) || primitive === match.base)) return;
        const what = f.kind === 'param' ? 'Parameter' : 'Field';
        const many = multiplicityText(f.multiplicity);
        const plural = name[3] === 's' ? 's' : '';
        const hint =
            canReference && match.aggregate && f.kind === 'field'
                ? `write 'references ${name[1]}${plural}: ${match.idType}${many} -> ${match.aggregate}'`
                : `write '${f.name}: ${match.idType}${many}'`;
        rules.warning('M027', `${what} '${f.name}' holds an ID but is typed ${primitive}: use the ID type '${match.idType}'.`, f.typeAt, hint);
    };
    for (const el of model.elements) {
        for (const { field, canReference } of fieldsIn(el)) check(field, el.context, canReference);
        if (el.kind === 'aggregate') for (const c of commandsOf(el)) for (const p of c.params) check(p, el.context, false);
    }
}

/** The fields an element declares, and whether `references` may stand there (in an aggregate, its states or an entity). */
function fieldsIn(el: ElementDecl): { field: FieldDecl; canReference: boolean }[] {
    const each = (fields: FieldDecl[], canReference: boolean) => fields.map((field) => ({ field, canReference }));
    switch (el.kind) {
        case 'aggregate':
            return each([...fieldsOf(el.members), ...statesOf(el).flatMap((s) => fieldsOf(s.members))], true);
        case 'entity':
            return each(fieldsOf(el.members), true);
        case 'valueObject':
        case 'fieldSet':
        case 'event':
        case 'error':
            return each(fieldsOf(el.members), false);
        case 'union':
            return each(
                el.variants.flatMap((v) => fieldsOf(v.members)),
                false,
            );
        default:
            return [];
    }
}

/**
 * The ID type a stem names, seen from `ctx` (its own elements, then the shared contexts'), else in exactly one other
 * context (qualified): `<Stem>Id` or `<Stem>ID` as an ID type, else `<Stem>` as an aggregate or entity.
 */
function idMatch(model: SourceModel, ctx: string, stem: string): IdMatch | undefined {
    const names = [`${stem}Id`, `${stem}ID`, stem];
    const fromDecl = (decl: ElementDecl | undefined, qualify: string | undefined): IdMatch | undefined => {
        const q = (n: string): string => (qualify ? `${qualify}.${n}` : n);
        if (decl?.kind === 'id') {
            const owner = identified(model, decl);
            return { idType: q(decl.name), ...(decl.base && { base: decl.base }), ...(owner && { aggregate: q(owner.name) }) };
        }
        if (decl?.kind === 'aggregate' || decl?.kind === 'entity') {
            const id = identityField(decl)?.type?.decl?.target;
            if (id?.kind !== 'id') return undefined; // no identity of its own (M013)
            const qualifyId = id.context === ctx || model.sharedContexts.includes(id.context) ? undefined : id.context;
            return {
                idType: qualifyId ? `${qualifyId}.${id.name}` : id.name,
                ...(id.base && { base: id.base }),
                ...(decl.kind === 'aggregate' && { aggregate: q(decl.name) }),
            };
        }
        return undefined;
    };
    for (const n of names) {
        const match = fromDecl(lookupVisible(model, ctx, n), undefined);
        if (match) return match;
    }
    if (model.sharedContexts.includes(ctx)) return undefined; // a shared context depends on no other context (M014)
    for (const n of names) {
        const found = model.elements.filter((e) => e.name === n && e.context !== ctx && fromDecl(e, e.context));
        const contexts = new Set(found.map((e) => e.context));
        if (contexts.size === 1) return fromDecl(found[0], found[0].context);
        if (contexts.size > 1) return undefined; // several contexts have one: not knowing which, say nothing
    }
    return undefined;
}

/** The aggregate an ID type identifies (the first whose `id` field has it), if any. */
function identified(model: SourceModel, id: IdDecl): AggregateDecl | undefined {
    return model.elements.find((e): e is AggregateDecl => e.kind === 'aggregate' && identityField(e)?.type?.decl?.target === id);
}
