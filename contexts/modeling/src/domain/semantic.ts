import type {
    SemanticAggregate,
    SemanticDeclaration,
    SemanticExpression,
    SemanticIR,
    SemanticKindLifecycle,
    SemanticObligation,
    SemanticOutcome,
    SemanticRequirement,
    SemanticSpan,
    SemanticUnspecified,
} from '../generated/Modeling.js';
import type { AggregateModel, CommandModel, DomainModel, OutcomeModel, FieldModel } from './model.js';
import { applicableOutcomes, outcomeFields, outcomesBySource, outcomesOfCommand } from './model.js';
import { lifecyclesOf } from './lifecycle.js';
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

export const SEMANTIC_IR_VERSION = 1;

/** @internal Beta Semantic IR; its shape has no compatibility promise before 1.0. */

/** Convert a source-model site to the Semantic IR span shape. */
const span = (site: Site): SemanticSpan => ({
    file: site.file,
    startLine: site.start.line,
    startColumn: site.start.column,
    endLine: site.end.line,
    endColumn: site.end.column,
});

/** Project an expression tree, assigning each node a source-location identity. */
function expression(expr: Expr, path = 'root'): SemanticExpression {
    const children: Expr[] = [];
    switch (expr.k) {
        case 'member':
            children.push(expr.receiver);
            break;
        case 'not':
            children.push(expr.operand);
            break;
        case 'binary':
            children.push(expr.left, expr.right);
            break;
        case 'range':
            children.push(expr.operand, expr.lower, expr.upper);
            break;
        case 'count':
        case 'exists':
        case 'length':
            children.push(expr.k === 'count' ? expr.collection : expr.operand);
            break;
        case 'matches':
            children.push(expr.operand);
            break;
        case 'unique':
            children.push(expr.collection, ...expr.keys);
            break;
        case 'contains':
            children.push(expr.collection, expr.element);
            break;
        case 'quantifier':
            children.push(expr.collection, expr.body);
            break;
    }
    return {
        id: `${expr.at.elementId ?? ''}:expression:${expr.at.file}:${expr.at.start.line}:${expr.at.start.column}:${path}`,
        owner: expr.at.elementId ?? '',
        site: span(expr.at),
        syntaxKind: expr.k,
        source: expr.text,
        children: children.map((child, index) => expression(child, `${path}.${index}`)),
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
    ownerId: string = command.id,
    kind?: string,
    frames: { set: FieldModel[]; carried: FieldModel[]; dropped: FieldModel[] } = { set: [], carried: [], dropped: [] },
): SemanticOutcome => ({
    id: ownerId.endsWith(':') ? outcomeId(ownerId, o.name) : outcomeId(ownerId, o.name),
    command: command.id,
    ...(kind ? { kind } : {}),
    set: frames.set.map((field) => field.name),
    carried: frames.carried.map((field) => field.name),
    dropped: frames.dropped.map((field) => field.name),
    name: o.name,
    from: o.from.map((s) => stateId(command.id.split(':')[0]!, s)),
    to: o.to ? stateId(command.id.split(':')[0] ?? command.id, o.to) : '',
    selectKind: source?.select?.expr
        ? 'executable'
        : source?.select?.externalReason
          ? 'externalCheck'
          : source?.select?.text
            ? 'naturalLanguage'
            : o.select?.kind === 'expression'
              ? 'executable'
              : o.select?.kind === 'external'
                ? 'externalCheck'
                : o.select?.kind === 'declared'
                  ? 'naturalLanguage'
                  : 'absent',
    ...(source?.select?.expr ? { select: expression(source.select.expr) } : {}),
    changes: o.changes,
    site: span(at),
});

/** Project a requirement, resolving its error reference when the source model has a target. */
const requirement = (cmd: CommandDecl, r: RequirementDecl, ownerId = cmd.id): SemanticRequirement => ({
    id: requirementId(ownerId, r.name),
    name: r.name,
    ...(r.expr ? { expression: expression(r.expr) } : {}),
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
                ? c.outcomes
                      .map((sourceOutcome) => {
                          const item = applicableOutcomes(typed, typedCommand, lifecycle.kind).find((candidate) => candidate.name === sourceOutcome.name);
                          return item
                              ? outcome(
                                    typedCommand,
                                    item,
                                    sourceOutcome,
                                    sourceOutcome.at,
                                    onCaseId(kindId(agg.id, lifecycle.kind), cmd.name),
                                    lifecycle.kind,
                                    mergeFrames(typed, typedCommand, item, lifecycle.kind),
                                )
                              : undefined;
                      })
                      .filter((item): item is SemanticOutcome => item !== undefined)
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
                    outcomesOfCommand(cmd).map((o) => {
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
                                  ...outcome(cmd, o, source, at, cmd.id, cmd.kind ?? undefined, mergeFrames(typed, cmd, o, cmd.kind)),
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
                                      onCaseId(kindId(agg.id, kind.name), cmd.name),
                                      kind.name,
                                      mergeFrames(typed, typedCommand, item, kind.name),
                                  ),
                              ]
                            : [];
                    });
                }),
            ),
        ],
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

/** Merge source-specific frames for a multi-source outcome while retaining each field name once. */
function mergeFrames(agg: AggregateModel, command: CommandModel, outcomeModel: OutcomeModel, kind?: string) {
    const frames = outcomeModel.from.length
        ? outcomeModel.from.map((from) => outcomeFields(agg, command, from, outcomeModel.to, outcomeModel, kind))
        : [outcomeFields(agg, command, undefined, outcomeModel.to, outcomeModel, kind)];
    const unique = (key: 'set' | 'carried' | 'dropped'): FieldModel[] => [
        ...new Map(frames.flatMap((frame) => frame[key]).map((field) => [field.name, field])).values(),
    ];
    return { set: unique('set'), carried: unique('carried'), dropped: unique('dropped') };
}

/** Find expression roots represented by the current step-one IR. */
const expressionRoots = (model: SourceModel): Expr[] => {
    const roots: Expr[] = [];
    const addInvs = (items: readonly (AggregateMember | DataMember)[]) => {
        for (const item of items) if (item.kind === 'invariant' && item.expr) roots.push(item.expr);
    };
    for (const el of model.elements) {
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
        for (const o of outcomesOfCommand(typedCommand)) {
            const sourceOutcome = cmd.outcomes.find((item) => item.name === o.name);
            const id = sourceOutcome ? outcomeId(cmd.id, o.name) : shorthandOutcomeId(cmd.id, o.to || undefined);
            const frames = (o.from.length ? o.from : [undefined]).map((from) =>
                outcomeFields(typed, typedCommand, from, o.to || undefined, o, typedCommand.kind),
            );
            const target = statesOf(agg).find((state) => state.name === o.to);
            for (const change of sourceOutcome?.changes ?? cmd.changes)
                result.push({ kind: 'changesWithoutExpression', declaration: id, field: change.name, site: span(change.at) });
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
                if (declaration?.kind === 'field') result.push({ kind: 'targetOnlyField', declaration: id, field: field.name, site: span(declaration.at) });
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
                    result.push({ kind: 'changesWithoutExpression', declaration: id, field: change.name, site: span(change.at) });
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
                            result.push({ kind: 'targetOnlyField', declaration: id, field: field.name, site: span(declaration.at) });
                    }
                }
            }
        }
    }
    for (const typedCommand of typed.commands) {
        for (const choiceKind of typed.kinds.length ? typed.kinds.map((item) => item.name) : ['*']) {
            const groups = outcomesBySource(applicableOutcomes(typed, typedCommand, choiceKind), typedCommand.factory);
            const declaration = commandsOf(agg).find((item) => item.name === typedCommand.name);
            for (const [source, group] of groups) {
                if (group.length < 2 || group.some((candidate) => candidate.select?.kind === 'expression')) continue;
                const outcomes = group.map((candidate) => {
                    const onCase = kindsOf(agg).find((kind) => kind.name === choiceKind)?.cases
                        .find((item) => item.command.text === typedCommand.name)?.outcomes
                        .find((item) => item.name === candidate.name);
                    const sourceOutcome = onCase ?? declaration?.outcomes.find((item) => item.name === candidate.name);
                    const owner = onCase ? onCaseId(kindId(agg.id, choiceKind), typedCommand.name) : typedCommand.id;
                    return sourceOutcome ? outcomeId(owner, sourceOutcome.name) : shorthandOutcomeId(typedCommand.id, candidate.to || undefined);
                });
                const first = group[0]!;
                const onCase = kindsOf(agg).find((kind) => kind.name === choiceKind)?.cases
                    .find((item) => item.command.text === typedCommand.name)?.outcomes
                    .find((item) => item.name === first.name);
                const sourceOutcome = onCase ?? declaration?.outcomes.find((item) => item.name === first.name);
                const owner = onCase ? onCaseId(kindId(agg.id, choiceKind), typedCommand.name) : typedCommand.id;
                result.push({
                    kind: 'nondeterministicChoice',
                    declaration: outcomes[0]!,
                    site: span(sourceOutcome?.select?.at ?? sourceOutcome?.at ?? declaration?.at ?? agg.at),
                });
            }
        }
    }
    return result;
}

/** Build the versioned semantic projection from the source model, retaining the syntax's exact source spans. */
export function buildSemanticIR(model: SourceModel, typed: DomainModel): SemanticIR {
    return {
        version: SEMANTIC_IR_VERSION,
        declarations: declarationsOf(model),
        expressions: expressionRoots(model).map((expr) => expression(expr)),
        scopes: [],
        aggregates: model.elements
            .filter((e): e is AggregateDecl => e.kind === 'aggregate')
            .flatMap((agg) => {
                const model = typed.elements.find((el): el is AggregateModel => el.kind === 'aggregate' && el.id === agg.id);
                return model ? [aggregate(agg, model)] : [];
            }),
        obligations: obligations(model),
        unspecified: model.elements
            .filter((e): e is AggregateDecl => e.kind === 'aggregate')
            .flatMap((agg) => {
                const typedAggregate = typed.elements.find((element): element is AggregateModel => element.kind === 'aggregate' && element.id === agg.id);
                return typedAggregate ? unspecifiedFor(agg, typedAggregate) : [];
            }),
        provenance: [],
    };
}
