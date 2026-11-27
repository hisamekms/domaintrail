import type {
    SemanticAggregate,
    SemanticChoice,
    SemanticDeclaration,
    SemanticExpression,
    SemanticIR,
    SemanticKindLifecycle,
    SemanticObligation,
    SemanticOutcome,
    SemanticPresenceFact,
    SemanticRequirement,
    SemanticSpan,
    SemanticScopeFact,
    SemanticUnspecified,
} from '../generated/Modeling.js';
import type { AggregateModel, CommandModel, DomainModel, OutcomeModel, FieldModel } from './model.js';
import { applicableOutcomes, outcomeFields, outcomesBySource, outcomesOfCommand } from './model.js';
import { lifecyclesOf } from './lifecycle.js';
import { checkInvariants, type ExpressionFact } from './rules/expressions.js';
import { RuleSink } from './diagnostics.js';
import { enumValueId, fieldId, invariantId, kindId, onCaseId, outcomeId, shorthandOutcomeId, parameterId, requirementId, stateId, variantId } from './ids.js';
import {
    commandsOf,
    fieldsOf,
    invariantsOf,
    kindsOf,
    statesOf,
    type AggregateDecl,
    type AggregateMember,
    type CommandDecl,
    type DataMember,
    type Expr,
    type OutcomeDecl,
    type RequirementDecl,
    type SourceModel,
    type Site,
} from './source-model.js';

/** @internal Beta Semantic IR; its shape has no compatibility promise before 1.0. */
export const SEMANTIC_IR_VERSION = 1;

/** Convert a source-model site to the Semantic IR span shape. */
const span = (site: Site): SemanticSpan => ({
    file: site.file,
    startLine: site.start.line,
    startColumn: site.start.column,
    endLine: site.end.line,
    endColumn: site.end.column,
});

const symbolKind = (kind: NonNullable<ExpressionFact['symbol']>['kind']): NonNullable<SemanticExpression['symbol']>['kind'] => {
    switch (kind) {
        case 'lambdaVariable':
            return 'lambda';
        case 'field':
        case 'parameter':
        case 'state':
        case 'kind':
        case 'enumValue':
        case 'type':
            return kind;
    }
};

const expressionChildren = (expr: Expr): Expr[] => {
    switch (expr.k) {
        case 'member':
            return [expr.receiver];
        case 'not':
        case 'exists':
        case 'length':
        case 'matches':
            return [expr.operand];
        case 'count':
            return [expr.collection];
        case 'binary':
            return [expr.left, expr.right];
        case 'range':
            return [expr.operand, expr.lower, expr.upper];
        case 'unique':
            return [expr.collection, ...expr.keys];
        case 'contains':
            return [expr.collection, expr.element];
        case 'quantifier':
            return [expr.collection, expr.body];
        default:
            return [];
    }
};

const semanticTypeName = (ty: NonNullable<ExpressionFact['type']>, declarationIds?: Map<object, string>): string | undefined => {
    while (ty.k === 'opt' || ty.k === 'list') ty = ty.k === 'opt' ? ty.inner : ty.elem;
    switch (ty.k) {
        case 'prim':
            return ty.name;
        case 'id':
        case 'dp':
        case 'enum':
        case 'struct':
        case 'union':
        case 'tag':
            return declarationIds?.get(ty.decl) ?? ty.decl.id;
        case 'enumType':
        case 'unionType':
        case 'ctx':
        case 'error':
            return undefined;
    }
};

/** Project an expression tree, assigning each node a source-location identity. */
function expression(
    expr: Expr,
    path = 'root',
    facts?: Map<Expr, ExpressionFact>,
    declarationIds?: Map<object, string>,
    expressionIds?: Map<Expr, string>,
    rootId: string = expr.at.elementId ?? '',
    childPath = '',
): SemanticExpression {
    const children = expressionChildren(expr);
    const fact = facts?.get(expr);
    const found = fact?.symbol;
    const id = found?.declaration ? declarationIds?.get(found.declaration) : undefined;
    const symbol =
        found?.kind === 'lambdaVariable'
            ? { id: found.binding ? (expressionIds?.get(found.binding) ?? '') : '', kind: 'lambda' as const, name: found.name }
            : id && found
              ? { id, kind: symbolKind(found.kind), name: found.name }
              : undefined;
    const rawMultiplicity = found?.declaration && 'multiplicity' in found.declaration ? found.declaration.multiplicity : undefined;
    const nonEmptyMultiplicity =
        rawMultiplicity &&
        typeof rawMultiplicity === 'object' &&
        'lower' in rawMultiplicity &&
        typeof rawMultiplicity.lower === 'number' &&
        'optional' in rawMultiplicity &&
        typeof rawMultiplicity.optional === 'boolean'
            ? !rawMultiplicity.optional && rawMultiplicity.lower >= 1
            : undefined;
    const isNonEmpty = fact?.type?.k === 'list' && nonEmptyMultiplicity === true;
    const typeName = fact?.type && semanticTypeName(fact.type, declarationIds);
    const type =
        fact?.type && typeName
            ? {
                  name: typeName,
                  cardinality: isNonEmpty
                      ? ('nonEmpty' as const)
                      : fact.type.k === 'opt'
                        ? ('optional' as const)
                        : fact.type.k === 'list'
                          ? ('many' as const)
                          : ('one' as const),
              }
            : undefined;
    return {
        id: `${expr.at.elementId ?? ''}:expression:${expr.at.file}:${expr.at.start.line}:${expr.at.start.column}:${path}`,
        owner: expr.at.elementId ?? '',
        root: rootId,
        path: childPath,
        site: span(expr.at),
        syntaxKind: expr.k,
        source: expr.text,
        ...(symbol ? { symbol } : {}),
        ...(type ? { type } : {}),
        ...(fact?.comparison ? { comparison: fact.comparison } : {}),
        children: children.map((child, index) =>
            expression(child, `${path}.${index}`, facts, declarationIds, expressionIds, rootId, childPath ? `${childPath}.${index}` : `${index}`),
        ),
    };
}

/** Collect source declarations in source order, keeping the first declaration for each declaration ID. */
const declarationsOf = (model: SourceModel): SemanticDeclaration[] => {
    const result: SemanticDeclaration[] = [];
    const seen = new Set<string>();
    const add = (id: string, kind: SemanticDeclaration['kind'], name: string, at: Site) => {
        if (seen.has(id)) return;
        seen.add(id);
        result.push({ id, kind, name, site: span(at) });
    };
    for (const el of model.elements) {
        add(el.id, el.kind, el.name, el.at);
        const owner = el.id;
        if ('members' in el) {
            for (const f of fieldsOf(el.members)) add(fieldId(owner, f.name), 'field', f.name, f.at);
            for (const inv of invariantsOf(el.members)) add(invariantId(owner, inv.name), 'invariant', inv.name, inv.at);
        }
        if (el.kind === 'id' || el.kind === 'primitive') {
            for (const inv of el.invariants) add(invariantId(owner, inv.name), 'invariant', inv.name, inv.at);
        }
        if (el.kind === 'aggregate') {
            for (const state of statesOf(el)) {
                add(state.id, 'state', state.name, state.at);
                for (const f of fieldsOf(state.members)) add(fieldId(state.id, f.name), 'field', f.name, f.at);
                for (const inv of invariantsOf(state.members)) add(invariantId(state.id, inv.name), 'invariant', inv.name, inv.at);
            }
            for (const cmd of commandsOf(el)) {
                add(cmd.id, 'command', cmd.name, cmd.at);
                for (const p of cmd.params) add(parameterId(cmd.id, p.name), 'parameter', p.name, p.at);
                for (const req of cmd.requirements) add(requirementId(cmd.id, req.name), 'requirement', req.name, req.at);
                for (const o of cmd.outcomes) add(outcomeId(cmd.id, o.name), 'outcome', o.name, o.at);
            }
            for (const kind of kindsOf(el)) {
                const id = kindId(el.id, kind.name);
                add(id, 'kind', kind.name, kind.at);
                for (const f of fieldsOf(kind.members)) add(fieldId(id, f.name), 'field', f.name, f.at);
                for (const inv of invariantsOf(kind.members)) add(invariantId(id, inv.name), 'invariant', inv.name, inv.at);
                for (const c of kind.cases) {
                    const command = commandsOf(el).find((candidate) => candidate.name === c.command.text);
                    if (!command) continue;
                    const scopedCommandId = onCaseId(id, command.name);
                    add(scopedCommandId, 'onCase', command.name, c.at);
                    for (const req of c.requirements) add(requirementId(scopedCommandId, req.name), 'requirement', req.name, req.at);
                    for (const o of c.outcomes) add(outcomeId(scopedCommandId, o.name), 'outcome', o.name, o.at);
                }
            }
        } else if (el.kind === 'union') {
            for (const variant of el.variants) {
                const id = variantId(el.id, variant.name);
                add(id, 'variant', variant.name, variant.at);
                for (const f of fieldsOf(variant.members)) add(fieldId(id, f.name), 'variantField', f.name, f.at);
                for (const inv of invariantsOf(variant.members)) add(invariantId(id, inv.name), 'invariant', inv.name, inv.at);
            }
        }
        if (el.kind === 'enum') for (const value of el.values) add(enumValueId(el.id, value.name), 'enumValue', value.name, value.at);
        if (el.kind === 'id' || el.kind === 'primitive') {
            if (el.constraint) add(invariantId(el.id, 'valid'), 'invariant', 'valid', el.constraint.at);
        }
    }
    return result;
};

/** Project a typed outcome with its source declaration and frame facts. */
const outcome = (
    command: CommandModel,
    o: OutcomeModel,
    source: OutcomeDecl | undefined,
    at: Site,
    aggregateId: string,
    ownerId: string = command.id,
    kind?: string,
    frames: { set: FieldModel[]; carried: FieldModel[]; dropped: FieldModel[] } = { set: [], carried: [], dropped: [] },
): SemanticOutcome => ({
    id: outcomeId(ownerId, o.name),
    command: command.id,
    ...(kind ? { kind } : {}),
    set: frames.set.map((field) => field.name),
    carried: frames.carried.map((field) => field.name),
    dropped: frames.dropped.map((field) => field.name),
    name: o.name,
    from: o.from.map((s) => stateId(aggregateId, s)),
    ...(o.to ? { to: stateId(aggregateId, o.to) } : {}),
    selectKind:
        o.select?.kind === 'expression'
            ? 'executable'
            : o.select?.kind === 'external'
              ? 'externalCheck'
              : o.select?.kind === 'declared'
                ? 'naturalLanguage'
                : source?.select?.expr
                  ? 'executable'
                  : source?.select?.externalReason
                    ? 'externalCheck'
                    : source?.select?.text
                      ? 'naturalLanguage'
                      : 'absent',
    ...(o.select?.kind === 'expression' && source?.select?.expr
        ? { select: expression(source.select.expr, 'root', undefined, undefined, undefined, outcomeId(ownerId, o.name)) }
        : {}),
    changes: o.changes,
    site: span(at),
});

/** Project a requirement, resolving its error reference when the source model has a target. */
const requirement = (cmd: CommandDecl, r: RequirementDecl, ownerId = cmd.id): SemanticRequirement => ({
    id: requirementId(ownerId, r.name),
    name: r.name,
    ...(r.expr ? { expression: expression(r.expr, 'root', undefined, undefined, undefined, requirementId(ownerId, r.name)) } : {}),
    error: r.error.target?.id ?? r.error.text,
    ...(r.externalReason !== undefined ? { externalReason: r.externalReason } : {}),
    site: span(r.at),
});

/** Project one aggregate's lifecycle, outcomes and requirements. */
function aggregate(agg: AggregateDecl, typed: AggregateModel): SemanticAggregate {
    const commands = commandsOf(agg);
    const kinds: SemanticKindLifecycle[] = lifecyclesOf(agg).map((lifecycle) => {
        const kind = kindsOf(agg).find((item) => item.name === lifecycle.kind);
        const onCases = (kind?.cases ?? []).flatMap((c) => {
            const cmd = commands.find((candidate) => candidate.name === c.command.text);
            const typedCommand = typed.commands.find((candidate) => candidate.name === c.command.text);
            return cmd && typedCommand
                ? c.outcomes.flatMap((sourceOutcome) => {
                      const item = applicableOutcomes(typed, typedCommand, lifecycle.kind).find((candidate) => candidate.name === sourceOutcome.name);
                      if (!item) return [];
                      return (item.from.length ? item.from : ['']).map((from) => {
                          const sourced = { ...item, from: from ? [from] : [] };
                          return outcome(
                              typedCommand,
                              sourced,
                              sourceOutcome,
                              sourceOutcome.at,
                              agg.id,
                              onCaseId(kindId(agg.id, lifecycle.kind), cmd.name),
                              lifecycle.kind,
                              outcomeFields(typed, typedCommand, from || undefined, item.to, item, lifecycle.kind),
                          );
                      });
                  })
                : [];
        });
        const toStateIds = (names: readonly string[]) => names.map((name) => stateId(agg.id, name));
        return {
            kind: lifecycle.kind,
            initialStates: toStateIds([...lifecycle.initial, ...(lifecycle.kind === '*' ? lifecycle.creationTargets : [])]),
            validStates: toStateIds(lifecycle.reachable),
            onCases,
        };
    });
    return {
        id: agg.id,
        initialStates: kinds.find((kind) => kind.kind === '*')?.initialStates ?? [],
        validStates: kinds.find((kind) => kind.kind === '*')?.validStates ?? [],
        kinds,
        outcomes: [
            ...typed.commands
                .flatMap((cmd) =>
                    outcomesOfCommand(
                        cmd,
                        statesOf(agg).length > 0 || kindsOf(agg).some((kind) => kind.cases.some((item) => item.command.text === cmd.name)),
                    ).map((o) => {
                        const declaration = commands.find((candidate) => candidate.name === cmd.name);
                        const source = declaration?.outcomes.find((candidate) => candidate.name === o.name);
                        const transitionIndex = cmd.transitions.findIndex(
                            (transition) =>
                                transition.from.length === o.from.length &&
                                transition.from.every((from) => o.from.includes(from)) &&
                                transition.to.includes(o.to),
                        );
                        const at = source?.at ?? declaration?.transitionsAt[transitionIndex] ?? declaration?.at;
                        return at
                            ? {
                                  ...outcome(
                                      cmd,
                                      o,
                                      source,
                                      at,
                                      agg.id,
                                      cmd.id,
                                      cmd.kind ?? undefined,
                                      outcomeFields(typed, cmd, o.from[0], o.to, o, cmd.kind),
                                  ),
                                  id: source ? outcomeId(cmd.id, o.name) : shorthandOutcomeId(cmd.id, o.to || undefined),
                              }
                            : [];
                    }),
                )
                .flat(),
            ...kindsOf(agg).flatMap((kind) =>
                kind.cases.flatMap((c) => {
                    const cmd = commands.find((candidate) => candidate.name === c.command.text);
                    const typedCommand = typed.commands.find((candidate) => candidate.name === c.command.text);
                    const typedCase = typed.kinds
                        .find((candidate) => candidate.name === kind.name)
                        ?.cases.find((candidate) => candidate.command === c.command.text);
                    if (!cmd || !typedCommand || !typedCase) return [];
                    return outcomesOfCommand({ ...typedCommand, outcomes: typedCase.outcomes, transitions: [] }).flatMap((item) => {
                        const source = c.outcomes.find((candidate) => candidate.name === item.name);
                        return source
                            ? [
                                  outcome(
                                      typedCommand,
                                      item,
                                      source,
                                      source.at,
                                      agg.id,
                                      onCaseId(kindId(agg.id, kind.name), cmd.name),
                                      kind.name,
                                      outcomeFields(typed, typedCommand, item.from[0], item.to, item, kind.name),
                                  ),
                              ]
                            : [];
                    });
                }),
            ),
        ],
        choices: choicesFor(agg, typed),
        requirements: [
            ...commands.flatMap((cmd) => cmd.requirements.map((r) => requirement(cmd, r))),
            ...kindsOf(agg).flatMap((kind) =>
                kind.cases.flatMap((c) => {
                    const cmd = commands.find((candidate) => candidate.name === c.command.text);
                    return cmd ? c.requirements.map((r) => requirement(cmd, r, onCaseId(kindId(agg.id, kind.name), cmd.name))) : [];
                }),
            ),
        ],
    };
}

/** Resolve one typed outcome to the source declaration ID, including on-cases and legacy transitions. */
function declaredOutcomeId(agg: AggregateDecl, command: CommandDecl, typedCommand: CommandModel, kind: string, item: OutcomeModel): string {
    const onCase = kindsOf(agg)
        .find((candidate) => candidate.name === kind)
        ?.cases.find((candidate) => candidate.command.text === command.name)
        ?.outcomes.find((candidate) => candidate.name === item.name);
    if (onCase) return outcomeId(onCaseId(kindId(agg.id, kind), command.name), onCase.name);
    const named = command.outcomes.find((candidate) => candidate.name === item.name);
    if (named) return outcomeId(command.id, named.name);
    return shorthandOutcomeId(typedCommand.id, item.to || undefined);
}

/** Compute unresolved competing outcomes for each kind and source state. */
function choicesFor(agg: AggregateDecl, typed: AggregateModel): SemanticChoice[] {
    const result: SemanticChoice[] = [];
    for (const typedCommand of typed.commands) {
        const command = commandsOf(agg).find((candidate) => candidate.name === typedCommand.name);
        if (!command) continue;
        for (const kind of typed.kinds.length ? typed.kinds.map((item) => item.name) : ['*']) {
            const applicable = applicableOutcomes(typed, typedCommand, kind);
            const outcomes = typedCommand.transitions.length ? outcomesOfCommand(typedCommand) : applicable;
            for (const [source, group] of outcomesBySource(outcomes, typedCommand.factory)) {
                if (group.length < 2 || group.some((item) => item.select?.kind === 'expression')) continue;
                const outcomes = [...new Set(group.map((item) => declaredOutcomeId(agg, command, typedCommand, kind, item)))];
                if (outcomes.length < 2) continue;
                result.push({ kind, ...(typedCommand.factory ? {} : { source: stateId(agg.id, source) }), outcomes: [outcomes[0]!, ...outcomes.slice(1)] });
            }
        }
    }
    return result;
}

/** Find expression roots represented by the current step-one IR. */
const expressionRoots = (model: SourceModel): Expr[] => {
    const roots: Expr[] = [];
    const addInvs = (items: readonly (AggregateMember | DataMember)[]) => {
        for (const item of items) if (item.kind === 'invariant' && item.expr) roots.push(item.expr);
    };
    for (const el of model.elements) {
        if (el.kind === 'id' || el.kind === 'primitive') {
            for (const inv of el.invariants) if (inv.expr) roots.push(inv.expr);
            if (el.constraint) roots.push(el.constraint);
        }
        if ('members' in el) addInvs(el.members);
        if (el.kind === 'aggregate') {
            for (const state of statesOf(el)) addInvs(state.members);
            for (const kind of kindsOf(el)) addInvs(kind.members);
            for (const cmd of commandsOf(el)) {
                roots.push(...cmd.requirements.flatMap((r) => (r.expr ? [r.expr] : [])));
                roots.push(...cmd.outcomes.flatMap((o) => (o.select?.expr ? [o.select.expr] : [])));
                for (const kind of kindsOf(el))
                    for (const c of kind.cases.filter((x) => x.command.text === cmd.name)) {
                        roots.push(...c.requirements.flatMap((r) => (r.expr ? [r.expr] : [])));
                        roots.push(...c.outcomes.flatMap((o) => (o.select?.expr ? [o.select.expr] : [])));
                    }
            }
        }
        if (el.kind === 'union') for (const v of el.variants) addInvs(v.members);
    }
    return roots;
};

/** Build external and natural-language obligations from declarations in source order. */
const obligations = (model: SourceModel): SemanticObligation[] => {
    const out: SemanticObligation[] = [];
    const add = (id: string, name: string, at: Site, reason: string | undefined, expr: Expr | undefined) => {
        if (reason !== undefined) out.push({ kind: 'externalCheck', declaration: id, reason, site: span(at) });
        else if (!expr) out.push({ kind: 'naturalLanguage', declaration: id, reason: name, site: span(at) });
    };
    for (const el of model.elements) {
        if ('members' in el) for (const i of invariantsOf(el.members)) add(invariantId(el.id, i.name), i.label ?? i.name, i.at, i.externalReason, i.expr);
        if (el.kind === 'id' || el.kind === 'primitive')
            for (const i of el.invariants) add(invariantId(el.id, i.name), i.label ?? i.name, i.at, i.externalReason, i.expr);
        if (el.kind === 'aggregate') {
            for (const state of statesOf(el))
                for (const i of invariantsOf(state.members)) add(invariantId(state.id, i.name), i.label ?? i.name, i.at, i.externalReason, i.expr);
            for (const cmd of commandsOf(el)) {
                for (const r of cmd.requirements) add(requirementId(cmd.id, r.name), r.label ?? r.name, r.at, r.externalReason, r.expr);
                for (const o of cmd.outcomes)
                    if (o.select) add(outcomeId(cmd.id, o.name), o.select.text ?? o.name, o.select.at, o.select.externalReason, o.select.expr);
            }
            for (const k of kindsOf(el)) {
                const id = kindId(el.id, k.name);
                for (const i of invariantsOf(k.members)) add(invariantId(id, i.name), i.label ?? i.name, i.at, i.externalReason, i.expr);
                for (const c of k.cases) {
                    const owner = onCaseId(id, c.command.text);
                    for (const r of c.requirements) add(requirementId(owner, r.name), r.label ?? r.name, r.at, r.externalReason, r.expr);
                    for (const o of c.outcomes)
                        if (o.select) add(outcomeId(owner, o.name), o.select.text ?? o.name, o.select.at, o.select.externalReason, o.select.expr);
                }
            }
        }
        if (el.kind === 'union')
            for (const v of el.variants) {
                const id = variantId(el.id, v.name);
                for (const i of invariantsOf(v.members)) add(invariantId(id, i.name), i.label ?? i.name, i.at, i.externalReason, i.expr);
            }
    }
    return out;
};

/** Compute unspecified facts from typed outcome frames and expression-free requirements. */
function unspecifiedFor(agg: AggregateDecl, typed: AggregateModel): SemanticUnspecified[] {
    const result: SemanticUnspecified[] = [];
    for (const cmd of commandsOf(agg)) {
        for (const req of cmd.requirements)
            if (!req.expr) result.push({ kind: 'expressionFreeRequirement', declaration: requirementId(cmd.id, req.name), site: span(req.at) });
        const typedCommand = typed.commands.find((candidate) => candidate.name === cmd.name);
        if (!typedCommand) continue;
        for (const o of outcomesOfCommand(
            typedCommand,
            statesOf(agg).length > 0 || kindsOf(agg).some((kind) => kind.cases.some((item) => item.command.text === cmd.name)),
        )) {
            const sourceOutcome = cmd.outcomes.find((item) => item.name === o.name);
            const id = sourceOutcome ? outcomeId(cmd.id, o.name) : shorthandOutcomeId(cmd.id, o.to || undefined);
            const frames = (o.from.length ? o.from : [undefined]).map((from) =>
                outcomeFields(typed, typedCommand, from, o.to || undefined, o, typedCommand.kind),
            );
            const target = statesOf(agg).find((state) => state.name === o.to);
            for (const change of sourceOutcome?.changes ?? cmd.changes)
                result.push({
                    kind: 'changesWithoutExpression',
                    declaration: id,
                    ...(o.from[0] ? { source: stateId(agg.id, o.from[0]) } : {}),
                    field: change.name,
                    site: span(change.at),
                });
            if (typedCommand.factory) {
                for (const field of frames.flatMap((frame) => frame.set))
                    result.push({
                        kind: 'createField',
                        declaration: id,
                        field: field.name,
                        site: span(target?.members.find((member) => member.kind === 'field' && member.name === field.name)?.at ?? cmd.at),
                    });
                continue;
            }
            const changes = new Set((sourceOutcome?.changes ?? cmd.changes).map((field) => field.name));
            const setFields = [
                ...new Map(frames.flatMap((frame) => frame.set.filter((field) => !changes.has(field.name))).map((field) => [field.name, field])).values(),
            ];
            for (const field of setFields) {
                const declaration = target?.members.find((member) => member.kind === 'field' && member.name === field.name);
                if (declaration?.kind === 'field')
                    result.push({
                        kind: 'targetOnlyField',
                        declaration: id,
                        ...(o.from[0] ? { source: stateId(agg.id, o.from[0]) } : {}),
                        field: field.name,
                        site: span(declaration.at),
                    });
            }
        }
    }
    for (const kind of kindsOf(agg)) {
        for (const c of kind.cases) {
            const cmd = commandsOf(agg).find((candidate) => candidate.name === c.command.text);
            const typedCommand = typed.commands.find((candidate) => candidate.name === c.command.text);
            const typedCase = typed.kinds.find((candidate) => candidate.name === kind.name)?.cases.find((candidate) => candidate.command === c.command.text);
            if (!cmd || !typedCommand || !typedCase) continue;
            const owner = onCaseId(kindId(agg.id, kind.name), cmd.name);
            for (const req of c.requirements)
                if (!req.expr) result.push({ kind: 'expressionFreeRequirement', declaration: requirementId(owner, req.name), site: span(req.at) });
            for (const o of outcomesOfCommand({ ...typedCommand, outcomes: typedCase.outcomes, transitions: [] })) {
                const sourceOutcome = c.outcomes.find((item) => item.name === o.name);
                if (!sourceOutcome) continue;
                const id = outcomeId(owner, o.name);
                const frames = (o.from.length ? o.from : [undefined]).map((from) => outcomeFields(typed, typedCommand, from, o.to || undefined, o, kind.name));
                const target = statesOf(agg).find((state) => state.name === o.to);
                for (const change of sourceOutcome.changes)
                    result.push({
                        kind: 'changesWithoutExpression',
                        declaration: id,
                        ...(o.from[0] ? { source: stateId(agg.id, o.from[0]) } : {}),
                        field: change.name,
                        site: span(change.at),
                    });
                if (typedCommand.factory) {
                    for (const field of frames.flatMap((frame) => frame.set))
                        result.push({
                            kind: 'createField',
                            declaration: id,
                            field: field.name,
                            site: span(target?.members.find((member) => member.kind === 'field' && member.name === field.name)?.at ?? cmd.at),
                        });
                } else {
                    const changes = new Set(sourceOutcome.changes.map((field) => field.name));
                    const setFields = [
                        ...new Map(
                            frames.flatMap((frame) => frame.set.filter((field) => !changes.has(field.name))).map((field) => [field.name, field]),
                        ).values(),
                    ];
                    for (const field of setFields) {
                        const declaration = target?.members.find((member) => member.kind === 'field' && member.name === field.name);
                        if (declaration?.kind === 'field')
                            result.push({
                                kind: 'targetOnlyField',
                                declaration: id,
                                ...(o.from[0] ? { source: stateId(agg.id, o.from[0]) } : {}),
                                field: field.name,
                                site: span(declaration.at),
                            });
                    }
                }
            }
        }
    }
    return result;
}

/** Merges two facts about one expression; a field left undefined in the later fact keeps the earlier value. */
const mergeFacts = (earlier: ExpressionFact | undefined, later: ExpressionFact): ExpressionFact =>
    earlier
        ? {
              expression: later.expression,
              type: later.type ?? earlier.type,
              comparison: later.comparison ?? earlier.comparison,
              symbol: later.symbol ?? earlier.symbol,
              paths: later.paths ?? earlier.paths,
              scope: later.scope ?? earlier.scope,
          }
        : later;

/** Build the versioned beta semantic projection from the source model, retaining exact syntax spans. */
export function buildSemanticIR(model: SourceModel, typed: DomainModel): SemanticIR {
    const declarationIds = new Map<object, string>();
    const expressionIds = new Map<Expr, string>();
    const roots = expressionRoots(model);
    const indexExpressions = (expr: Expr, path: string): void => {
        expressionIds.set(expr, `${expr.at.elementId ?? ''}:expression:${expr.at.file}:${expr.at.start.line}:${expr.at.start.column}:${path}`);
        const children = expressionChildren(expr);
        children.forEach((child, i) => indexExpressions(child, `${path}.${i}`));
    };
    roots.forEach((root) => indexExpressions(root, 'root'));
    for (const el of model.elements) {
        declarationIds.set(el, el.id);
        if ('members' in el) for (const field of fieldsOf(el.members)) declarationIds.set(field, fieldId(el.id, field.name));
        if (el.kind === 'enum') for (const value of el.values) declarationIds.set(value, enumValueId(el.id, value.name));
        if (el.kind === 'aggregate') for (const state of statesOf(el)) declarationIds.set(state, state.id);
        if (el.kind === 'union')
            for (const variant of el.variants)
                for (const field of fieldsOf(variant.members)) declarationIds.set(field, fieldId(variantId(el.id, variant.name), field.name));
        if (el.kind === 'aggregate') {
            for (const state of statesOf(el)) for (const field of fieldsOf(state.members)) declarationIds.set(field, fieldId(state.id, field.name));
            for (const command of commandsOf(el)) {
                declarationIds.set(command, command.id);
                for (const param of command.params) declarationIds.set(param, parameterId(command.id, param.name));
                for (const item of command.outcomes) declarationIds.set(item, outcomeId(command.id, item.name));
            }
            for (const kind of kindsOf(el))
                for (const field of fieldsOf(kind.members)) declarationIds.set(field, fieldId(kindId(el.id, kind.name), field.name));
            for (const kind of kindsOf(el)) {
                declarationIds.set(kind, kindId(el.id, kind.name));
                for (const c of kind.cases) {
                    const command = commandsOf(el).find((candidate) => candidate.name === c.command.text);
                    if (!command) continue;
                    const scopedCommandId = onCaseId(kindId(el.id, kind.name), command.name);
                    declarationIds.set(c, scopedCommandId);
                    for (const item of c.outcomes) declarationIds.set(item, outcomeId(scopedCommandId, item.name));
                }
            }
        }
    }
    const facts = new Map<Expr, ExpressionFact>();
    // The checker may report several facts for one expression (its type, then its scope as a root): merge them, so a
    // later fact never drops what an earlier one recorded.
    checkInvariants(model, new RuleSink(), (fact) => facts.set(fact.expression, mergeFacts(facts.get(fact.expression), fact)));
    const scopes: SemanticScopeFact[] = [...facts.values()]
        .filter((fact) => fact.scope)
        .map((fact) => ({
            expression: expressionIds.get(fact.expression) ?? '',
            site: span(fact.expression.at),
            owner: (fact.scope && declarationIds.get(fact.scope.owner)) ?? fact.expression.at.elementId ?? '',
            fields: (fact.scope?.fields ?? []).flatMap((declaration) => {
                const id = declarationIds.get(declaration);
                return id ? [{ id, kind: 'field' as const, name: 'name' in declaration && typeof declaration.name === 'string' ? declaration.name : '' }] : [];
            }),
            parameters: (fact.scope?.parameters ?? []).flatMap((declaration) => {
                const id = declarationIds.get(declaration);
                return id
                    ? [{ id, kind: 'parameter' as const, name: 'name' in declaration && typeof declaration.name === 'string' ? declaration.name : '' }]
                    : [];
            }),
            lambdas: (fact.scope?.lambdas ?? []).map((lambda) => ({
                id: lambda.binding ? (expressionIds.get(lambda.binding) ?? '') : (expressionIds.get(fact.expression) ?? ''),
                kind: 'lambda' as const,
                name: lambda.name,
            })),
            sourceStates: (fact.scope?.sourceStates ?? []).flatMap((declaration) => {
                const id = declarationIds.get(declaration);
                return id ? [id] : [];
            }),
            ...(fact.scope?.targetOutcome && declarationIds.get(fact.scope.targetOutcome)
                ? { targetOutcome: declarationIds.get(fact.scope.targetOutcome)! }
                : {}),
            ...(fact.scope?.kind && declarationIds.get(fact.scope.kind) ? { kind: declarationIds.get(fact.scope.kind)! } : {}),
            ...(fact.scope?.command && declarationIds.get(fact.scope.command) ? { command: declarationIds.get(fact.scope.command)! } : {}),
            ...(fact.scope?.onCase && declarationIds.get(fact.scope.onCase) ? { onCase: declarationIds.get(fact.scope.onCase)! } : {}),
        }));
    const presence: SemanticPresenceFact[] = [...facts.values()].flatMap((fact) =>
        (fact.paths ?? []).map((path) => ({ expression: expressionIds.get(fact.expression) ?? '', path })),
    );
    const aggregates = model.elements
        .filter((e): e is AggregateDecl => e.kind === 'aggregate')
        .flatMap((agg) => {
            const model = typed.elements.find((el): el is AggregateModel => el.kind === 'aggregate' && el.id === agg.id);
            return model ? [aggregate(agg, model)] : [];
        });
    const unspecified = model.elements
        .filter((e): e is AggregateDecl => e.kind === 'aggregate')
        .flatMap((agg) => {
            const typedAggregate = typed.elements.find((element): element is AggregateModel => element.kind === 'aggregate' && element.id === agg.id);
            return typedAggregate ? unspecifiedFor(agg, typedAggregate) : [];
        });
    // `parameter` and `explicitAssignment` remain unused until Phase 2 adds `changes x = expr`.
    const provenance: SemanticIR['provenance'][number][] = [];
    for (const aggregate of aggregates) {
        const choiceOutcomes = new Set(aggregate.choices.flatMap((choice) => choice.outcomes));
        for (const item of aggregate.outcomes) {
            const sources = item.from.length ? item.from : [undefined];
            for (const source of sources) {
                for (const field of item.carried)
                    provenance.push({ kind: 'carried', declaration: item.id, field, ...(source ? { source } : {}), site: item.site });
                for (const fact of unspecified) {
                    if (fact.declaration !== item.id || fact.source !== source || !fact.field) continue;
                    provenance.push({ kind: 'unspecified', declaration: item.id, field: fact.field, ...(source ? { source } : {}), site: fact.site });
                }
                if (choiceOutcomes.has(item.id))
                    provenance.push({ kind: 'selectedChoice', declaration: item.id, ...(source ? { source } : {}), site: item.site });
            }
        }
    }
    return {
        version: SEMANTIC_IR_VERSION,
        declarations: declarationsOf(model),
        expressions: roots.map((expr) => expression(expr, 'root', facts, declarationIds, expressionIds)),
        scopes,
        presence,
        aggregates,
        obligations: obligations(model),
        unspecified,
        provenance,
    };
}

/** Find an IR expression by its declaration root and ExprModel child-index path. */
export function irExpressionAt(ir: SemanticIR, root: string, path: string): SemanticExpression | undefined {
    const parts = path === '' ? [] : path.split('.').map(Number);
    let current = ir.expressions.find((item) => item.root === root);
    for (const index of parts) current = current?.children[index];
    return current;
}
