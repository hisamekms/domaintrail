/**
 * The `.dt` linker of the Event Storming DSL (ADR 0024, spec §2, §5): resolves the fully qualified `ref`s of events,
 * aggregates and commands against the Typed Model of the `.dt` sources (S010, S011), and reports the only contract
 * mismatches that are provable (S012, S013). It reads the storming IR and the model, and never changes either file.
 *
 * Missing `ref`s are never diagnosed (§2, ES07), nor are policies whose `on` and `issues` span contexts (ES09).
 * Clauses the validator rejects (a `ref` where none is allowed, a second `ref` or `target`, a relation to the wrong kind)
 * are left to it: the contract warnings only use what is valid.
 */
import type { Diagnostic } from '../core/diagnostics.js';
import { didYouMean, type Candidate } from '../core/suggest.js';
import { commandId } from '../model/ids.js';
import { elementList, emittedEvents, type CommandModel, type DomainModel, type ElementModel } from '../model/model.js';
import { esDiagnostic, esElementId, REF_KINDS, type Clause, type NodeElement, type Storming } from './ir.js';

export type DtRefKind = 'event' | 'aggregate' | 'command';

export type DtRefResolution = { ok: true; id: string } | { ok: false; code: 'S010' | 'S011'; message: string; hint?: string };

/** The fully qualified form of a `ref` per element kind, for messages. */
const REF_FORM: Record<DtRefKind, string> = {
    event: 'Context.Event',
    aggregate: 'Context.Aggregate',
    command: 'Context.Aggregate.command',
};

const SEGMENTS: Record<DtRefKind, number> = { event: 2, aggregate: 2, command: 3 };

/** `an aggregate`, `an event`, `a policy`, … for the `.dt` element kinds. */
const article = (kind: string): string => `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}`;

/** The qualified paths a `ref` of `kind` may name: `Ctx.Name`, or `Ctx.Aggregate.command`. */
function refPaths(kind: DtRefKind, model: DomainModel): string[] {
    const elements = elementList(model);
    if (kind !== 'command') return elements.filter((e) => e.kind === kind).map((e) => e.id);
    return elements.flatMap((e) => (e.kind === 'aggregate' ? (e.commands ?? []).map((c) => `${e.id}.${c.name}`) : []));
}

/**
 * Resolves a `ref` of an element of `kind` against the `.dt` model (ADR 0024, "`.dt` symbol resolution"). Nothing is
 * resolved by simple name or by guessing a context: a path with the wrong number of segments is S010, with a hint when
 * the written segments are the tail of exactly fitting qualified names.
 */
export function resolveDtRef(kind: DtRefKind, path: string, model: DomainModel): DtRefResolution {
    const segments = path.split('.');
    const paths = refPaths(kind, model);
    if (segments.length !== SEGMENTS[kind]) {
        // `ref ShipmentCancelled` → `Delivery.ShipmentCancelled`: compare with the same number of trailing segments.
        const candidates: Candidate[] =
            segments.length < SEGMENTS[kind] ? paths.map((p) => ({ name: p, key: p.split('.').slice(-segments.length).join('.') })) : [];
        const hint = didYouMean(path, candidates);
        return {
            ok: false,
            code: 'S010',
            message: `The ${kind} ref '${path}' is not fully qualified: write '${REF_FORM[kind]}'.`,
            ...(hint ? { hint } : {}),
        };
    }
    const elementPath = kind === 'command' ? segments.slice(0, 2).join('.') : path;
    const element: ElementModel | undefined = model.elements[elementPath];
    if (!element) {
        const hint = suggestPath(path, paths);
        return { ok: false, code: 'S010', message: `The ${kind} ref '${path}' names nothing in the .dt model.`, ...(hint ? { hint } : {}) };
    }
    if (kind !== 'command') {
        if (element.kind === kind) return { ok: true, id: element.id };
        return { ok: false, code: 'S011', message: `The ${kind} ref '${path}' names ${article(element.kind)}, not ${article(kind)}.`, ...hintOf(path, paths) };
    }
    if (element.kind !== 'aggregate') {
        return {
            ok: false,
            code: 'S011',
            message: `The command ref '${path}' names a member of ${article(element.kind)} '${elementPath}': a command belongs to an aggregate.`,
            ...hintOf(path, paths),
        };
    }
    const name = segments[2];
    const command: CommandModel | undefined = element.commands?.find((c) => c.name === name);
    if (command) return { ok: true, id: commandId(element.id, command.name) };
    const commands = (element.commands ?? []).map((c) => ({ name: `${element.id}.${c.name}`, key: c.name }));
    const hint = didYouMean(name, commands) ?? (commands.length ? `use a command of '${element.id}': ${commands.map((c) => c.name).join(', ')}` : undefined);
    return { ok: false, code: 'S011', message: `The aggregate '${elementPath}' has no command '${name}'.`, ...(hint ? { hint } : {}) };
}

/**
 * `did you mean …` for a qualified path, comparing what follows the context: a typo in a name is not drowned by the
 * length of the path, and a name of another context (or a mistyped context) is suggested by its exact name.
 */
function suggestPath(path: string, paths: readonly string[]): string | undefined {
    const tail = (p: string): string => p.slice(p.indexOf('.') + 1);
    return didYouMean(
        tail(path),
        paths.filter((p) => p !== path).map((p) => ({ name: p, key: tail(p) })),
    );
}

const hintOf = (path: string, paths: readonly string[]): { hint?: string } => {
    const hint = suggestPath(path, paths);
    return hint ? { hint } : {};
};

type RefClause = Extract<Clause, { type: 'ref' }>;
type RelationClause = Extract<Clause, { type: 'relation' }>;

const refClauses = (el: NodeElement): RefClause[] => el.clauses.filter((c): c is RefClause => c.type === 'ref');
const relations = (el: NodeElement, keyword: RelationClause['keyword']): RelationClause[] =>
    el.clauses.filter((c): c is RelationClause => c.type === 'relation' && c.keyword === keyword);

const isRefKind = (kind: NodeElement['kind']): kind is DtRefKind => REF_KINDS.includes(kind);

/**
 * S010–S013 for the stormings of a workspace. Without a model (the `.dt` sources do not parse) nothing is reported:
 * the `ref`s cannot be checked, and guessing would give false errors.
 */
export function linkStormings(stormings: readonly Storming[], model: DomainModel | undefined): Diagnostic[] {
    if (!model) return [];
    const diagnostics: Diagnostic[] = [];
    for (const storming of stormings) {
        const nodes = storming.elements.filter((el): el is NodeElement => el.kind !== 'timeline');
        const byId = new Map(nodes.map((el) => [el.id, el]));
        // The `.dt` ID of each element with exactly one `ref` that resolves; a second `ref` is the validator's S004.
        const resolved = new Map<string, string>();
        for (const el of nodes) {
            if (!isRefKind(el.kind)) continue; // a `ref` on a policy, actor … is the validator's S005
            const refs = refClauses(el);
            for (const ref of refs) {
                const r = resolveDtRef(el.kind, ref.path, model);
                if (r.ok) {
                    if (refs.length === 1) resolved.set(el.id, r.id);
                } else {
                    diagnostics.push(esDiagnostic('error', r.code, r.message, ref.range, { hint: r.hint, elementId: esElementId(storming.id, el.id) }));
                }
            }
        }
        for (const el of nodes) {
            const dtCommand = el.kind === 'command' ? resolved.get(el.id) : undefined;
            if (!dtCommand) continue;
            const [aggregateId, commandName] = splitCommandId(dtCommand);
            const elementId = esElementId(storming.id, el.id);
            const ref = refClauses(el)[0];

            // S012: the `ref` names a command of another aggregate than the `ref` of the (single, valid) target.
            const targets = relations(el, 'target');
            const target = targets.length === 1 ? byId.get(targets[0].target) : undefined;
            const targetAggregate = target?.kind === 'aggregate' ? resolved.get(target.id) : undefined;
            if (targetAggregate && targetAggregate !== aggregateId) {
                diagnostics.push(
                    esDiagnostic(
                        'warning',
                        'S012',
                        `The command ref '${ref.path}' is a command of '${aggregateId}', but its target '${target!.id}' refers to '${targetAggregate}'.`,
                        ref.range,
                        { hint: `correct the ref of '${el.id}' or of '${target!.id}', or the target`, elementId },
                    ),
                );
            }

            // S013: an emitted event whose `ref` the exhaustive `emits` of the `.dt` command does not list (ADR 0018).
            const command = model.elements[aggregateId]?.commands?.find((c) => c.name === commandName);
            if (!command) continue;
            const emitted = new Set(emittedEvents(command));
            for (const emits of relations(el, 'emits')) {
                const event = byId.get(emits.target);
                const dtEvent = event?.kind === 'event' ? resolved.get(event.id) : undefined;
                if (!dtEvent || emitted.has(dtEvent)) continue;
                diagnostics.push(
                    esDiagnostic(
                        'warning',
                        'S013',
                        `'${el.id}' emits '${emits.target}', which refers to '${dtEvent}', but the .dt command '${ref.path}' never emits it: a .dt command emits only the events of its emits.`,
                        emits.range,
                        {
                            hint: `add '${dtEvent}' to the emits of '${ref.path}' (or, for a failure, an error of it), or correct the ref of '${el.id}' or '${emits.target}'`,
                            elementId,
                        },
                    ),
                );
            }
        }
    }
    return diagnostics;
}

/** `Ctx.Agg:cmd` → `['Ctx.Agg', 'cmd']`. */
function splitCommandId(id: string): [string, string] {
    const i = id.lastIndexOf(':');
    return [id.slice(0, i), id.slice(i + 1)];
}
