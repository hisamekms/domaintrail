import {
    isAggregate,
    isCommand,
    isFieldSet,
    isInvariant,
    isState,
    type Aggregate,
    type Command,
    type Context,
    type ContextElement,
    type DataMember,
    type Entity,
    type Expression,
    type ErrorDecl,
    type EventDecl,
    type Field,
    type FieldSet,
    type IdType,
    type Invariant,
    type Model,
    type OwnsField,
    type PrimitiveDecl,
    type ReferenceField,
    type State,
    type UnionDecl,
    type ValueObject,
} from './generated/ast.js';

export type FieldLike = Field | OwnsField | ReferenceField;

/** Workspace-wide lookup over all parsed documents. Contexts may be split across files. */
export class ModelIndex {
    readonly fragments: Context[] = [];
    readonly elements: ContextElement[] = [];
    private readonly byQName = new Map<string, ContextElement[]>();

    constructor(models: readonly Model[]) {
        for (const model of models) {
            for (const ctx of model.contexts ?? []) {
                if (!ctx.name) continue;
                this.fragments.push(ctx);
                for (const el of ctx.elements) {
                    if (!el.name) continue;
                    this.elements.push(el);
                    const q = `${ctx.name}.${el.name}`;
                    const list = this.byQName.get(q) ?? [];
                    list.push(el);
                    this.byQName.set(q, list);
                }
            }
        }
    }

    get contextNames(): string[] {
        return [...new Set(this.fragments.map((c) => c.name))].sort();
    }

    /** Contexts declared `shared` (in any of their fragments; disagreements are reported by M014). */
    get sharedContexts(): string[] {
        return [...new Set(this.fragments.filter((c) => c.shared).map((c) => c.name))].sort();
    }

    isShared(ctx: string): boolean {
        return this.fragments.some((c) => c.name === ctx && c.shared);
    }

    lookup(qname: string): ContextElement | undefined {
        return this.byQName.get(qname)?.[0];
    }

    get aggregates(): Aggregate[] {
        return this.elements.filter(isAggregate);
    }
}

/** Elements that may name field sets with `with` (only aggregates, entities and events may, see M016). */
export type WithFieldSets = Aggregate | Entity | EventDecl | ValueObject | ErrorDecl | FieldSet;

/** The field sets an element names with `with`, resolved, each once, in order. */
export function fieldSetsOf(el: WithFieldSets): FieldSet[] {
    return [...new Set(el.fieldSets.map((r) => r.ref).filter((f): f is FieldSet => !!f))];
}

/** The fields an element takes from its field sets, with the field set of each, before its own fields. */
export function includedFields(el: WithFieldSets): { field: FieldLike; fieldSet: FieldSet }[] {
    if (isFieldSet(el)) return [];
    return fieldSetsOf(el).flatMap((fieldSet) => fieldsOf(fieldSet.members).map((field) => ({ field, fieldSet })));
}

export const fieldsOf = (members: readonly DataMember[]): FieldLike[] => members.filter((m): m is FieldLike => !isInvariant(m));

export const invariantsOf = (members: readonly (DataMember | State | Command)[]): Invariant[] => members.filter(isInvariant);

export const commonFields = (agg: Aggregate): FieldLike[] => agg.members.filter((m): m is FieldLike => !isInvariant(m) && !isState(m) && !isCommand(m));

export const statesOf = (agg: Aggregate): State[] => agg.members.filter(isState);
export const commandsOf = (agg: Aggregate): Command[] => agg.members.filter(isCommand);

/** Discriminator property of a union declared without `by`. */
const DEFAULT_DISCRIMINATOR = 'kind';

export const discriminatorOf = (u: UnionDecl): string => u.discriminator ?? DEFAULT_DISCRIMINATOR;

type DomainPrimitive = IdType | PrimitiveDecl;

/** Name used for the anonymous constraint form `primitive X: Int { value > 0 }`. */
const ANONYMOUS_CONSTRAINT = 'valid';

interface PrimitiveInvariant {
    name: string;
    label?: string;
    expr: Expression | undefined;
    /** Node to report diagnostics on. */
    node: Invariant | Expression;
}

/** Invariants of a domain primitive, including the anonymous `{ expr }` form. */
export function primitiveInvariants(p: DomainPrimitive): PrimitiveInvariant[] {
    if (p.constraint) return [{ name: ANONYMOUS_CONSTRAINT, expr: p.constraint, node: p.constraint }];
    return p.invariants.map((i) => ({ name: i.name, label: i.label, expr: i.expr, node: i }));
}
