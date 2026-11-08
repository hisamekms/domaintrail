import { compareDiagnostics, type Diagnostic, didYouMean } from '@domaintrail/kernel';
import {
    declarations,
    DESIGN_LEVEL,
    esDiagnostic,
    esElementId,
    isRemovedKeyword,
    RELATION_RULES,
    REF_KINDS,
    REMOVED_KEYWORDS,
    type AnyDeclaration,
    type Clause,
    type ElementKind,
    type EventStepRef,
    type NodeElement,
    type NodeElementKind,
    type RelationKeyword,
    type SourceRange,
    type Stage,
    type Storming,
    type Timeline,
} from './ir.js';
import { labelOverflowsNote } from './sticky-note.js';
import { designGaps, hasDesignLevel, type Gap, type Missing } from './gaps.js';
import { branchPoints, drawnInSections, onCycle, rejoinPoint, topLevel, trunk, type Section } from './stages.js';

/** How an element kind is named in messages. */
const KIND_NAMES: Record<ElementKind, string> = {
    event: 'event',
    actor: 'actor',
    external: 'external',
    command: 'command',
    policy: 'policy',
    aggregate: 'aggregate',
    readmodel: 'read model',
    hotspot: 'hotspot',
    timeline: 'timeline',
    group: 'group',
    stage: 'stage',
};

const NODE_KINDS: readonly NodeElementKind[] = ['event', 'actor', 'external', 'command', 'policy', 'aggregate', 'readmodel', 'hotspot'];

/** At most this many declarations are listed in a hint. */
const MAX_LISTED = 5;

const article = (word: string): string => (/^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`);
const kindList = (kinds: readonly ElementKind[]): string => kinds.map((k) => article(KIND_NAMES[k])).join(' or ');
const line = (range: SourceRange): number => range.start.line;

/**
 * The checks of a `.dtes` storming that need no `.dt` model (spec §11, ADR 0024: S001–S009 and S014–S033), on the storming
 * IR only:
 *   - S001: a local ID declared twice in a storming (across kinds, timelines and groups included), a storming ID twice
 *   - S002: a relation target or timeline step that names no declaration of its storming
 *   - S003: a reference to a declaration of the wrong kind (`RELATION_RULES`; timeline and group steps name events), with
 *     a hint of the relation that says it (`by` an aggregate → `handledBy`, `emits` a command → a policy between, …)
 *   - S004: more than one `handledBy`, `ref`, hotspot `on`, `status`, `resolution` or `level`
 *   - S005: a `ref` on an element other than an event, aggregate or command
 *   - S006: a clause the element kind does not take (a command's `issues`: only a policy connects commands)
 *   - S007: an event twice in one group
 *   - S008: a policy without `on` or without `issues`, unless an open hotspot is `on` it (ADR 0032)
 *   - S009: a hotspot `status` other than `open`/`resolved`, `resolved` without `resolution`, `resolution` when open
 *   - S014 (warning): a type-level cycle policy → command → event → policy
 *   - S015 (warning): a label too long for its sticky note even at its smallest font (`STICKY_NOTE`)
 *   - S016: a `level` other than `design` (`big-picture` included: no `level` already means both levels)
 *   - S017: a stage `after` itself, or stages whose `after`s form a cycle (S002/S003 name no stage, S004 a second `after`)
 *   - S018: a `then` on a main flow (a `timeline`, not an `exception`), or naming an event in no main flow
 *   - S019 (warning): a timeline of a stage (or, in a storming with exceptions, a top-level one) other than its trunk
 *     whose first step is in neither the trunk nor another timeline that branches off
 *   - S020: timelines outside the stages of a storming that has stages
 *   - S021 (warning): a second stage without `after` (the first one without is where the flow starts)
 *   - S022 (warning): a stage without a main flow (a `timeline`)
 *   - S023: `actor` or `target`, the relations of v0.1 (ADR 0032): `by` and `handledBy` replace them
 *   - S024: a command without its issuer (`by`, or a policy that `issues` it), its `handledBy` or its `emits`, unless an
 *     open hotspot is `on` it: the gap is then an open question, never filled by a guess (ADR 0032)
 *   - S025: a command that a policy issues and that also has `by` (the policy is its issuer)
 *   - S026: one relation written twice in an element (`emits A` twice, `emits A, A`)
 *   - S027: an actor, external system, aggregate or read model that no relation names, unless an open hotspot is `on` it
 *   - S028: an event both emitted by a command and arriving `from` an external system
 *   - S029 (info): at Design Level (a command or policy in the storming), an event no command emits and from no external
 *   - S030: `reads` on a command a policy issues (without `by`): whoever decides has the `reads`, here the policy (ADR 0032 §9)
 *   - S031: a policy that issues more than one command: one policy per command, each with its own `reads` (ADR 0032 §9)
 *   - S032: `on` on a command without `by`: only a person issuing it reacts to an event that way; a rule is a policy's
 *     `on` (ADR 0032 §14)
 *   - S033: `on` on a command `by` an external system: an external system reacting to our event is a policy issuing a
 *     command it handles (ADR 0032 §14)
 * Not diagnosed (spec §11): timeline order against causality, Big Picture completeness (unreferenced events, events in
 * no timeline, read models without `from`). A policy with several `issues` is S031 (ADR 0032 §9), not an Info.
 */
export function validateStormings(stormings: readonly Storming[]): Diagnostic[] {
    const out: Diagnostic[] = [];
    const seen = new Map<string, Storming>();
    for (const s of stormings) {
        const prev = seen.get(s.id);
        if (prev) {
            out.push(
                esDiagnostic(
                    'error',
                    'S001',
                    `Storming '${s.id}' is already declared at ${prev.nameRange.file}:${line(prev.nameRange)}; storming IDs are unique in the workspace.`,
                    s.nameRange,
                    { hint: `rename one of the two stormings`, elementId: esElementId(s.id) },
                ),
            );
        } else {
            seen.set(s.id, s);
        }
        out.push(...validateStorming(s));
    }
    return out.sort(compareDiagnostics);
}

function validateStorming(storming: Storming): Diagnostic[] {
    const out: Diagnostic[] = [];
    const elementId = (localId: string): string => esElementId(storming.id, localId);
    const decls = declarations(storming);

    // S001. A later declaration with the ID of an earlier one is the duplicate; references resolve to the first.
    const byId = new Map<string, AnyDeclaration>();
    for (const d of decls) {
        const first = byId.get(d.id);
        if (!first) {
            byId.set(d.id, d);
            continue;
        }
        const same = first.kind === d.kind ? '' : ` (${article(KIND_NAMES[first.kind])})`;
        out.push(
            esDiagnostic(
                'error',
                'S001',
                `${capitalize(KIND_NAMES[d.kind])} '${d.id}' reuses the ID of the ${KIND_NAMES[first.kind]} declared at line ${line(first.nameRange)}${same}; the IDs of a storming are unique across all kinds, timelines and groups included.`,
                d.nameRange,
                { hint: `rename one of them and update the references to it`, elementId: elementId(d.id) },
            ),
        );
    }

    /**
     * The declaration a local reference names, reporting S002/S003 when there is none of an allowed kind; `explain`
     * gives the hint of S003 for a declaration of the wrong kind (the relation that says what was meant).
     */
    const resolve = (
        name: string,
        range: SourceRange,
        allowed: readonly ElementKind[],
        where: string,
        ownerId: string,
        explain?: (target: AnyDeclaration) => string | undefined,
    ): AnyDeclaration | undefined => {
        const target = byId.get(name);
        if (target && allowed.includes(target.kind)) return target;
        const candidates = [...new Set(decls.filter((d) => allowed.includes(d.kind)).map((d) => d.id))];
        const suggestion = didYouMean(name, candidates);
        if (!target) {
            out.push(
                esDiagnostic('error', 'S002', `${where} names '${name}', which is not declared in storming '${storming.id}'.`, range, {
                    hint: suggestion ?? `declare ${article(KIND_NAMES[allowed[0]!])} '${name}' in the storming, or name an existing one`,
                    elementId: elementId(ownerId),
                }),
            );
            return undefined;
        }
        const existing = candidates.length
            ? `name one of ${candidates
                  .slice(0, MAX_LISTED)
                  .map((id) => `'${id}'`)
                  .join(', ')}${candidates.length > MAX_LISTED ? ', …' : ''}`
            : `declare ${article(KIND_NAMES[allowed[0]!])} first and name it here`;
        out.push(
            esDiagnostic('error', 'S003', `${where} names '${name}', which is ${article(KIND_NAMES[target.kind])}; it must name ${kindList(allowed)}.`, range, {
                hint: explain?.(target) ?? suggestion ?? existing,
                elementId: elementId(ownerId),
            }),
        );
        return undefined;
    };

    // ADR 0032: the gaps of the Design Level (S024, S008, S027); an open hotspot `on` an element makes its gap a question
    const gaps = new Map(designGaps(storming).map((g) => [g.elementId, g]));
    /** The gap of an element that no open hotspot asks about: an error. */
    const unasked = (el: NodeElement): Gap | undefined => {
        const g = byId.get(el.id) === el ? gaps.get(el.id) : undefined;
        return g && g.question === undefined ? g : undefined;
    };
    /** An ID for the hotspot a hint suggests, clashing with no declaration (S001). */
    const freeId = (base: string): string => {
        let id = base;
        for (let n = 2; byId.has(id); n++) id = `${base}${n}`;
        return id;
    };
    const dontGuess = (el: NodeElement, question: string): string =>
        `don't guess: if it is not decided yet, add \`hotspot ${freeId(`${el.id}Open`)} "${question}" { on ${el.id} }\`, which records the open question and turns this error off`;
    /** The policies that issue each command, and the commands that emit each event (written, of the right kinds). */
    const issuers = new Map<string, string[]>();
    const emitters = new Map<string, string[]>();
    for (const d of decls) {
        if (byId.get(d.id) !== d || !('clauses' in d) || d.kind === 'hotspot') continue;
        for (const c of d.clauses) {
            if (c.type !== 'relation') continue;
            const target = byId.get(c.target)?.kind;
            if (d.kind === 'policy' && c.keyword === 'issues' && target === 'command') issuers.set(c.target, [...(issuers.get(c.target) ?? []), d.id]);
            if (d.kind === 'command' && c.keyword === 'emits' && target === 'event') emitters.set(c.target, [...(emitters.get(c.target) ?? []), d.id]);
        }
    }
    const designLevel = hasDesignLevel(storming);
    /** The events a policy, or the actor issuing a command, is `on` (ADR 0032 §14). */
    const triggers = new Set(
        decls.flatMap((d) =>
            (d.kind === 'policy' || d.kind === 'command') && byId.get(d.id) === d
                ? d.clauses.flatMap((c) => (c.type === 'relation' && c.keyword === 'on' ? [c.target] : []))
                : [],
        ),
    );

    const stages = storming.elements.filter((el): el is Stage => el.kind === 'stage');
    const top = topLevel(storming);
    for (const el of storming.elements) {
        if (el.kind === 'timeline') {
            checkTimeline(el, top);
            if (stages.length) {
                out.push(
                    esDiagnostic(
                        'error',
                        'S020',
                        `${el.exception ? 'Exception' : 'Timeline'} '${el.id}' is outside the stages of storming '${storming.id}'; once a storming has stages, every timeline is in one.`,
                        el.nameRange,
                        {
                            hint: `move it into the stage it happens in`,
                            elementId: elementId(el.id),
                        },
                    ),
                );
            }
            continue;
        }
        if (el.kind === 'stage') {
            checkStage(el);
            continue;
        }
        checkClauses(el);
    }

    function checkTimeline(t: Timeline, section: Section): void {
        const what = t.exception ? 'exception' : 'timeline';
        for (const step of t.steps) {
            if (step.type === 'event') {
                resolve(step.eventId, step.range, ['event'], `A step of ${what} '${t.id}'`, t.id);
                continue;
            }
            checkGroup(step.id, step.events, t.id);
        }
        if (!t.rejoin) return;
        const target = resolve(t.rejoin.eventId, t.rejoin.range, ['event'], `\`then\` of ${what} '${t.id}'`, t.id);
        if (!target) return;
        const report = (message: string, hint: string): void => {
            out.push(esDiagnostic('error', 'S018', message, t.rejoin!.range, { hint, elementId: elementId(t.id) }));
        };
        if (!t.exception) {
            report(
                `Timeline '${t.id}' is a main flow; only an exception returns to a main flow with \`then\`.`,
                `write it \`exception ${t.id}\` if it is one, or remove \`then ${t.rejoin.eventId}\``,
            );
        } else if (!rejoinPoint(storming, section, t.rejoin.eventId)) {
            report(
                `\`then ${t.rejoin.eventId}\` of exception '${t.id}' names an event in no main flow; an exception returns to a step of a main flow (a \`timeline\`).`,
                `name an event of a \`timeline\`${section.id ? ` of stage '${section.id}' or of another stage` : ''}, or remove \`then\``,
            );
        }
    }

    /** S019: the timelines of a section, but its trunk, that branch off nowhere. */
    function checkBranches(section: Section, where: string): void {
        const points = branchPoints(section);
        const main = trunk(section);
        for (const t of section.timelines) {
            if (!points.has(t.id) || points.get(t.id) || byId.get(t.id) !== t) continue;
            const first = t.steps[0]!;
            const event = first.type === 'event' ? `'${first.eventId}'` : `group ${first.id}`;
            out.push(
                esDiagnostic(
                    'warning',
                    'S019',
                    `${t.exception ? 'Exception' : 'Timeline'} '${t.id}' of ${where} starts with ${event}, which is in neither ${main ? `the main flow '${main.id}'` : 'a main flow'} nor another timeline branching off it; it is drawn apart, not branching off.`,
                    first.range,
                    {
                        hint: main
                            ? `start it with the event of '${main.id}' (or of another timeline) it branches off at, as the shared first step`
                            : `add the main flow it branches off from, a \`timeline\``,
                        elementId: elementId(t.id),
                    },
                ),
            );
        }
    }
    if (!stages.length && drawnInSections(storming)) checkBranches(top, `storming '${storming.id}'`);

    function checkStage(stage: Stage): void {
        const what = `Stage '${stage.id}'`;
        stage.afters.forEach((after, i) => {
            if (i > 0) {
                out.push(
                    esDiagnostic('error', 'S004', `${what} has more than one \`after\`; it takes at most one.`, after.range, {
                        hint: `keep the \`after\` of the stage it comes right after, and remove the others`,
                        elementId: elementId(stage.id),
                    }),
                );
                return;
            }
            if (after.stageId === stage.id) {
                out.push(
                    esDiagnostic('error', 'S017', `${what} comes \`after\` itself.`, after.range, {
                        hint: `name the stage it comes after, or remove \`after\` if it is the first stage`,
                        elementId: elementId(stage.id),
                    }),
                );
                return;
            }
            resolve(after.stageId, after.range, ['stage'], `\`after\` of stage '${stage.id}'`, stage.id);
        });
        const starts = stages.filter((s) => !s.afters.length);
        if (!stage.afters.length && starts[0] !== stage) {
            out.push(
                esDiagnostic(
                    'warning',
                    'S021',
                    `${what} comes after no stage, and neither does stage '${starts[0]!.id}'; it is drawn as a separate start, after the stages written before it, without an arrow from them.`,
                    stage.nameRange,
                    {
                        hint: `add \`after <Stage>\` naming the stage it follows (e.g. \`after ${stages[stages.indexOf(stage) - 1]!.id}\`)`,
                        elementId: elementId(stage.id),
                    },
                ),
            );
        }
        if (!trunk(stage)) {
            out.push(
                esDiagnostic('warning', 'S022', `${what} has no main flow: a \`timeline\` (an \`exception\` is not one).`, stage.nameRange, {
                    hint: `add its main flow, \`timeline Main "通常" { … }\` with the events of this stage, or remove the stage`,
                    elementId: elementId(stage.id),
                }),
            );
        }
        for (const t of stage.timelines) checkTimeline(t, stage);
        checkBranches(stage, `stage '${stage.id}'`);
    }

    // S017: a cycle of `after`s, reported at the `after` of each of its stages
    const after = new Map<string, string>();
    for (const s of stages) {
        const a = s.afters[0]?.stageId;
        if (a !== undefined && a !== s.id && byId.get(a)?.kind === 'stage' && byId.get(s.id) === s) after.set(s.id, a);
    }
    for (const s of stages) {
        if (!after.has(s.id) || !onCycle(s.id, after)) continue;
        const cycle = [s.id];
        for (let at = after.get(s.id)!; at !== s.id; at = after.get(at)!) cycle.push(at);
        out.push(
            esDiagnostic(
                'error',
                'S017',
                `Stage '${s.id}' is on a cycle of \`after\`: ${[...cycle, s.id].join(' after ')}. Stages are in time order, so none comes after a later one.`,
                s.afters[0]!.range,
                {
                    hint: `remove the \`after\` of the stage that comes first`,
                    elementId: elementId(s.id),
                },
            ),
        );
    }

    function checkGroup(groupId: string, events: readonly EventStepRef[], timelineId: string): void {
        const seen = new Map<string, EventStepRef>();
        for (const e of events) {
            resolve(e.eventId, e.range, ['event'], `Group '${groupId}' of timeline '${timelineId}'`, groupId);
            const first = seen.get(e.eventId);
            if (!first) {
                seen.set(e.eventId, e);
                continue;
            }
            out.push(
                esDiagnostic(
                    'error',
                    'S007',
                    `Event '${e.eventId}' appears twice in group '${groupId}' (first at line ${line(first.range)}); a group is an unordered set of events.`,
                    e.range,
                    {
                        hint: `remove this '${e.eventId}'; to show it happening again, put it in another step of the timeline`,
                        elementId: elementId(groupId),
                    },
                ),
            );
        }
    }

    function checkClauses(el: NodeElement): void {
        const kind = KIND_NAMES[el.kind];
        const rules = RELATION_RULES[el.kind] ?? {};
        const what = `${capitalize(kind)} '${el.id}'`;
        const report = (code: 'S004' | 'S005' | 'S006' | 'S016' | 'S023', message: string, range: SourceRange, hint: string) =>
            out.push(esDiagnostic('error', code, message, range, { hint, elementId: elementId(el.id) }));
        /** S004 on every clause after the first of a kind that is allowed at most once. */
        const counts = new Map<string, number>();
        const once = (written: string, clause: Clause): boolean => {
            const n = (counts.get(written) ?? 0) + 1;
            counts.set(written, n);
            if (n < 2) return false;
            report('S004', `${what} has more than one \`${written}\`; it takes at most one.`, clause.range, `keep one \`${written}\` and remove the others`);
            return true;
        };

        /** The relations written so far, `keyword target` (S026). */
        const written = new Set<string>();
        for (const clause of el.clauses) {
            switch (clause.type) {
                case 'ref':
                    if (!REF_KINDS.includes(el.kind)) {
                        report(
                            'S005',
                            `${what} has a \`ref\`, but only events, aggregates and commands correspond to \`.dt\` symbols.`,
                            clause.range,
                            `remove \`ref ${clause.path}\``,
                        );
                    } else {
                        once('ref', clause);
                    }
                    break;
                case 'status':
                case 'resolution':
                    if (el.kind !== 'hotspot') {
                        report(
                            'S006',
                            `${what} has a \`${clause.type}\` clause, which only a hotspot takes.`,
                            clause.range,
                            `remove the \`${clause.type}\` clause`,
                        );
                    } else {
                        once(clause.type, clause);
                    }
                    break;
                case 'level':
                    if (el.kind !== 'event') {
                        report(
                            'S006',
                            `${what} has a \`level\` clause, which only an event takes.`,
                            clause.range,
                            `remove the \`level\` clause; its kind already decides the levels it is shown at`,
                        );
                        break;
                    }
                    once('level', clause);
                    if (clause.value === 'big-picture') {
                        report(
                            'S016',
                            `${what} has \`level big-picture\`, but an event without \`level\` is already shown at both levels; the only level to write is \`design\`.`,
                            clause.range,
                            `remove \`level big-picture\``,
                        );
                    } else if (clause.value !== DESIGN_LEVEL) {
                        report(
                            'S016',
                            `${what} has level '${clause.value}'; the only level is \`design\` (shown at Design Level only).`,
                            clause.range,
                            didYouMean(clause.value, [DESIGN_LEVEL]) ?? `write \`level design\`, or remove the clause to show the event at both levels`,
                        );
                    }
                    break;
                case 'relation': {
                    const keyword = clause.keyword;
                    if (isRemovedKeyword(keyword)) {
                        report(
                            'S023',
                            `${what} has \`${keyword} ${clause.target}\`, but \`${keyword}\` is no longer a relation: ${keyword === 'actor' ? 'who issues a command is `by`' : 'who handles a command is `handledBy`'}.`,
                            clause.range,
                            el.kind === 'command'
                                ? `write \`${REMOVED_KEYWORDS[keyword]} ${clause.target}\` (\`dt migrate dtes\` rewrites every \`actor\` and \`target\` of a command)`
                                : `remove it; \`${REMOVED_KEYWORDS[keyword]} ${clause.target}\` belongs in a command`,
                        );
                        break;
                    }
                    const allowed = rules[keyword];
                    if (!allowed) {
                        report(
                            'S006',
                            `${what} has \`${keyword} ${clause.target}\`, but ${article(kind)} takes ${relationList(el.kind)}.`,
                            clause.range,
                            misplacedHint(el.kind, keyword, clause.target) ?? relationHint(el.kind, keyword),
                        );
                        break;
                    }
                    if ((keyword === 'handledBy' || (el.kind === 'hotspot' && keyword === 'on')) && once(keyword, clause)) break;
                    const pair = `${keyword} ${clause.target}`;
                    if (written.has(pair)) {
                        out.push(
                            esDiagnostic('error', 'S026', `${what} has \`${pair}\` twice; a relation is written once.`, clause.targetRange, {
                                hint: `remove this '${clause.target}'`,
                                elementId: elementId(el.id),
                            }),
                        );
                        break;
                    }
                    written.add(pair);
                    resolve(clause.target, clause.targetRange, allowed, `\`${keyword}\` of ${kind} '${el.id}'`, el.id, (target) =>
                        kindHint(el, keyword, target),
                    );
                    break;
                }
            }
        }

        if (el.kind === 'policy') checkPolicy(el);
        if (el.kind === 'hotspot') checkHotspot(el);
        if (el.kind === 'command') checkCommand(el);
        if (el.kind === 'event') checkEventSource(el);
        if (el.kind === 'actor' || el.kind === 'external' || el.kind === 'aggregate' || el.kind === 'readmodel') checkUsed(el);
        checkLabel(el);
    }

    /** S024 and S025: a command is issued (by someone, or by a policy), handled and has outcomes (ADR 0032). */
    function checkCommand(el: NodeElement): void {
        if (byId.get(el.id) !== el) return;
        const policies = issuers.get(el.id) ?? [];
        if (policies.length) {
            for (const c of el.clauses) {
                if (c.type !== 'relation' || c.keyword !== 'by') continue;
                out.push(
                    esDiagnostic(
                        'error',
                        'S025',
                        `Command '${el.id}' is issued by policy '${policies[0]}', and also has \`by ${c.target}\`; a command that a policy issues has the policy as its issuer.`,
                        c.range,
                        {
                            hint: `remove \`by ${c.target}\`; if '${c.target}' also issues it by hand, that is another sticky: declare a command of its own with \`by ${c.target}\``,
                            elementId: elementId(el.id),
                        },
                    ),
                );
            }
        }
        // S030: the policy decides, so what is looked at to decide is the policy's `reads` (with `by`, S025 comes first)
        if (policies.length && !has(el, 'by')) {
            for (const c of el.clauses) {
                if (c.type !== 'relation' || c.keyword !== 'reads') continue;
                const named = policies.map((p) => `'${p}'`);
                out.push(
                    esDiagnostic(
                        'error',
                        'S030',
                        `Command '${el.id}' is issued by ${policies.length > 1 ? `the policies ${listed(named)}` : `policy ${named[0]}`} and has \`reads ${c.target}\`; the policy decides, so what is looked at to decide is the policy's \`reads\`.`,
                        c.targetRange,
                        {
                            hint:
                                policies.length > 1
                                    ? `move it: write \`reads ${c.target}\` in the policy that looks at it (${listed(named, 'or')}) and remove it here`
                                    : `move it: write \`reads ${c.target}\` in policy '${policies[0]}' and remove it here (\`dt migrate dtes\` moves it)`,
                            elementId: elementId(el.id),
                        },
                    ),
                );
            }
        }
        // S032, S033: a command's `on` says what the actor issuing it reacts to (ADR 0032 §14): a person's judgement on
        // noticing an event; a rule, or an external system reacting, is a policy
        const externals = el.clauses.flatMap((c) => (c.type === 'relation' && c.keyword === 'by' && byId.get(c.target)?.kind === 'external' ? [c.target] : []));
        for (const c of el.clauses) {
            if (c.type !== 'relation' || c.keyword !== 'on') continue;
            if (!has(el, 'by')) {
                const named = policies.map((p) => `'${p}'`);
                out.push(
                    esDiagnostic(
                        'error',
                        'S032',
                        `Command '${el.id}' has \`on ${c.target}\` but no \`by\`; only the actor issuing a command reacts to an event this way, a rule reacting to it is a policy.`,
                        c.range,
                        {
                            hint: policies.length
                                ? `${policies.length > 1 ? `the policies ${listed(named)} issue` : `policy ${named[0]} issues`} it: write \`on ${c.target}\` in ${policies.length > 1 ? `the one that reacts to it` : 'that policy'} and remove it here`
                                : `if a person notices '${c.target}' and issues it, add \`by <actor>\`; if it is a rule ("when ${c.target}, always …"), remove this \`on\` and put a policy between, \`policy <Id> { on ${c.target} issues ${el.id} }\``,
                            elementId: elementId(el.id),
                        },
                    ),
                );
                continue;
            }
            if (externals.length) {
                out.push(
                    esDiagnostic(
                        'error',
                        'S033',
                        `Command '${el.id}' has \`on ${c.target}\` and is issued by external system '${externals[0]}'; \`on\` on a command says what the actor issuing it reacts to, not an external system.`,
                        c.range,
                        {
                            hint: `an external system reacting to our event is a policy: remove this \`on\`, and write \`policy <Id> { on ${c.target} issues <a command handledBy ${externals[0]}> }\` (the command addressed to it) instead`,
                            elementId: elementId(el.id),
                        },
                    ),
                );
            }
        }
        const gap = unasked(el);
        if (!gap) return;
        const missing = (['by', 'handledBy', 'emits'] as const).filter((m) => gap.missing.includes(m)).map((m) => MISSING[m]);
        const emitted = el.clauses.find((c): c is Extract<Clause, { type: 'relation' }> => c.type === 'relation' && c.keyword === 'emits');
        const detail = emitted && !has(el, 'handledBy') ? ` It emits '${emitted.target}', but nothing handles it to produce that event.` : '';
        out.push(
            esDiagnostic(
                'error',
                'S024',
                `Command '${el.id}' does not say ${listed(missing.map((m) => m.what))}.${detail} At Design Level a command's row is \`by\` (or a policy's \`issues\`) → \`handledBy\` → \`emits\`.`,
                el.nameRange,
                {
                    hint: `add ${listed(missing.map((m) => m.clause))} if it is decided; ${dontGuess(el, commandQuestion(gap.missing))}`,
                    elementId: elementId(el.id),
                },
            ),
        );
    }

    /** S028: an event comes from a command's handler or from an external system, not both. */
    function checkEventSource(el: NodeElement): void {
        const commands = emitters.get(el.id);
        if (byId.get(el.id) !== el) return;
        // S029 (info): at Design Level, an event no command emits and that comes from no external system
        // an event a policy reacts to and nothing produces is a trigger (a time event: 「毎晩2時になった」), not reported
        if (!commands?.length && designLevel && !has(el, 'from') && !triggers.has(el.id)) {
            out.push(
                esDiagnostic(
                    'info',
                    'S029',
                    `Event '${el.id}' has no source at Design Level: no command emits it, and it comes \`from\` no external system.`,
                    el.nameRange,
                    {
                        hint: `write \`emits ${el.id}\` in the command that produces it, \`from <external>\` if it arrives from outside, or a time event and a policy for a schedule; nothing is needed while the storming is at Big Picture there`,
                        elementId: elementId(el.id),
                    },
                ),
            );
        }
        if (!commands?.length) return;
        for (const c of el.clauses) {
            if (c.type !== 'relation' || c.keyword !== 'from' || byId.get(c.target)?.kind !== 'external') continue;
            out.push(
                esDiagnostic(
                    'error',
                    'S028',
                    `Event '${el.id}' arrives \`from ${c.target}\`, and command '${commands[0]}' emits it too; an event comes either from the handler of a command or from an external system.`,
                    c.range,
                    {
                        hint: `if '${c.target}' handles '${commands[0]}', write \`handledBy ${c.target}\` there and remove \`from ${c.target}\`; if they are two happenings, declare two events`,
                        elementId: elementId(el.id),
                    },
                ),
            );
        }
    }

    /** S027: an actor, external system, aggregate or read model that no relation names is a sticky of no step. */
    function checkUsed(el: NodeElement): void {
        if (!unasked(el)) return;
        const how: Record<string, string> = {
            actor: `\`by ${el.id}\` in the command it issues (or the policy it applies)`,
            external: `\`by ${el.id}\` in the command it issues, \`handledBy ${el.id}\` in the command it handles, or \`from ${el.id}\` in the event it sends`,
            aggregate: `\`handledBy ${el.id}\` in the command it handles`,
            readmodel: `\`reads ${el.id}\` in the command whose issuer looks at it (or in the policy that looks at it), or \`from <event>\` for what it shows`,
        };
        out.push(
            esDiagnostic(
                'error',
                'S027',
                `${capitalize(KIND_NAMES[el.kind])} '${el.id}' takes part in no relation; at Design Level every ${KIND_NAMES[el.kind]} is part of a command's row.`,
                el.nameRange,
                {
                    hint: `write ${how[el.kind]}, or remove it; ${dontGuess(el, 'どこで使う？')}`,
                    elementId: elementId(el.id),
                },
            ),
        );
    }

    /** S015: a note shows its label (or its ID without one); one too long for the note is cut short with «…». */
    function checkLabel(el: NodeElement): void {
        const shown = el.label?.trim() ? el.label : el.id;
        if (!labelOverflowsNote(shown)) return;
        out.push(
            esDiagnostic(
                'warning',
                'S015',
                `The ${el.label?.trim() ? 'label' : 'ID'} of ${KIND_NAMES[el.kind]} '${el.id}' is too long for its sticky note: even at its smallest font the Live View cuts it short with «…» (the whole label shows on hover and in the inspector).`,
                el.nameRange,
                {
                    hint: `shorten the label to about 12 Japanese characters (an event in the past tense, e.g. "注文が確定した"), and put the details in a \`///\` comment`,
                    elementId: elementId(el.id),
                },
            ),
        );
    }

    function checkPolicy(el: NodeElement): void {
        // S031: one command per policy, so that its `reads` is what it looks at for that command
        const issued: string[] = [];
        for (const c of el.clauses) {
            if (c.type !== 'relation' || c.keyword !== 'issues' || byId.get(c.target)?.kind !== 'command' || issued.includes(c.target)) continue;
            issued.push(c.target);
            if (issued.length < 2) continue;
            out.push(
                esDiagnostic('error', 'S031', `Policy '${el.id}' issues '${issued[0]}' and also '${c.target}'; a policy issues one command.`, c.targetRange, {
                    hint: `split it: one policy per command, each \`on\` the same events and with the \`reads\` it looks at for that command, e.g. \`policy <Id> { on … issues ${c.target} }\`, and remove '${c.target}' here`,
                    elementId: elementId(el.id),
                }),
            );
        }
        const gap = unasked(el);
        const missing = (['on', 'issues'] as const).filter((k) => gap?.missing.includes(k));
        if (!missing.length) return;
        const clauses = missing.length === 2 ? 'neither `on` nor `issues`' : `no \`${missing[0]}\``;
        out.push(
            esDiagnostic(
                'error',
                'S008',
                `Policy '${el.id}' has ${clauses}; a policy reacts to at least one event (\`on\`) and issues at least one command (\`issues\`).`,
                el.nameRange,
                {
                    hint: `add ${missing.map((k) => (k === 'on' ? '`on <Event>`' : '`issues <Command>`')).join(' and ')} if it is decided; ${dontGuess(el, missing.length === 2 ? '何に反応し、何を発行する？' : missing[0] === 'on' ? '何に反応する？' : '何を発行する？')}`,
                    elementId: elementId(el.id),
                },
            ),
        );
    }

    function checkHotspot(el: NodeElement): void {
        const status = el.clauses.find((c) => c.type === 'status');
        const resolution = el.clauses.find((c) => c.type === 'resolution');
        if (status && status.value !== 'open' && status.value !== 'resolved') {
            out.push(
                esDiagnostic('error', 'S009', `Hotspot '${el.id}' has status '${status.value}'; a status is \`open\` or \`resolved\`.`, status.range, {
                    hint:
                        didYouMean(status.value, ['open', 'resolved']) ??
                        `write \`status open\` or \`status resolved\` (without a status, the hotspot is open)`,
                    elementId: elementId(el.id),
                }),
            );
            return;
        }
        if (status?.value === 'resolved' && !resolution) {
            out.push(
                esDiagnostic('error', 'S009', `Hotspot '${el.id}' is resolved but has no \`resolution\`.`, status.range, {
                    hint: `add \`resolution "<what was agreed>"\`, or write \`status open\` if it is not settled`,
                    elementId: elementId(el.id),
                }),
            );
        }
        if (status?.value !== 'resolved' && resolution) {
            out.push(
                esDiagnostic(
                    'error',
                    'S009',
                    `Hotspot '${el.id}' has a \`resolution\` but is ${status ? '' : 'implicitly '}open; only a resolved hotspot has a resolution.`,
                    resolution.range,
                    { hint: `write \`status resolved\` if it is settled, or remove the \`resolution\``, elementId: elementId(el.id) },
                ),
            );
        }
    }

    out.push(...cycles(storming, byId));
    return out;
}

/** Whether an element has a relation clause with `keyword`, whatever its target (`actor` and `target` count as `by` and `handledBy`: S023 reports them). */
const has = (el: NodeElement, keyword: RelationKeyword): boolean =>
    el.clauses.some((c) => c.type === 'relation' && (isRemovedKeyword(c.keyword) ? REMOVED_KEYWORDS[c.keyword] : c.keyword) === keyword);

/** `a`, `a and b`, `a, b and c` (or `or`). */
const listed = (items: readonly string[], conjunction = 'and'): string =>
    items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${conjunction} ${items.at(-1)}`;

/** What S024 says of each relation a command lacks. */
const MISSING = {
    by: { clause: '`by <actor or external>` (or a policy that `issues` it)', what: 'who issues it' },
    handledBy: { clause: '`handledBy <aggregate or external>`', what: 'who handles it' },
    emits: { clause: '`emits <event>`', what: 'its outcomes' },
} as const;

/** The question of the hotspot S024 suggests, of everything a command lacks: 「誰が発行し、誰が処理する？結果は？」. */
function commandQuestion(missing: readonly Missing[]): string {
    const who = [...(missing.includes('by') ? ['誰が発行'] : []), ...(missing.includes('handledBy') ? ['誰が処理'] : [])];
    const asked = who.length === 2 ? `${who[0]}し、${who[1]}する？` : who.length === 1 ? `${who[0]}する？` : '';
    return `${asked}${missing.includes('emits') ? (asked ? '結果は？' : '結果は何？') : ''}`;
}

/**
 * S006's hint for a relation an element kind does not take: the relation that says what was meant (ADR 0032), or
 * undefined for the generic one.
 */
function misplacedHint(kind: NodeElementKind, keyword: RelationKeyword, target: string): string | undefined {
    const policy = `\`policy <Id> { on <the event> issues ${target} }\``;
    if (kind === 'command') {
        if (keyword === 'issues') return `a command never issues a command: let it \`emits\` an event, and put a policy between, ${policy}`;
        if (keyword === 'from') return `remove it: a command is issued \`by\` someone, who \`reads\` read models to decide it`;
    }
    if (kind === 'policy') {
        if (keyword === 'emits') return `remove it: a policy emits nothing; the command it issues does (\`emits ${target}\` in that command)`;
        if (keyword === 'handledBy') return `remove it: write \`handledBy ${target}\` in the command the policy \`issues\``;
    }
    if (kind === 'event')
        return `remove it: an event is emitted by a command (\`emits\` in it), or arrives \`from\` an external system; a read model is fed \`from\` it`;
    if (kind === 'readmodel') return `remove it: a read model is fed \`from\` events; the command or policy that uses it \`reads\` it`;
    if (kind === 'hotspot') return `remove it: a hotspot is \`on\` one sticky`;
    if (kind === 'actor' || kind === 'external' || kind === 'aggregate') {
        return `remove it: write the relation in the command instead (${kind === 'aggregate' ? `the command it handles has \`handledBy\` and its \`emits\`` : `the command it issues has \`by\` and its \`reads\``})`;
    }
    return undefined;
}

/**
 * S003's hint for a relation to an element of the wrong kind: the relation that says what was meant (ADR 0032), or
 * undefined for the generic one (a declaration of the right kind).
 */
function kindHint(owner: NodeElement, keyword: RelationKeyword, target: AnyDeclaration): string | undefined {
    const t = target.id;
    const policy = `put a policy between: \`policy <Id> { on <an event it emits> issues ${owner.kind === 'command' ? owner.id : '<the command>'} }\``;
    if (owner.kind === 'command') {
        switch (keyword) {
            case 'by':
                if (target.kind === 'aggregate') return `an aggregate handles a command, it never issues one: write \`handledBy ${t}\``;
                if (target.kind === 'readmodel') return `a read model is what the issuer looks at: write \`reads ${t}\``;
                if (target.kind === 'policy')
                    return `a policy issues a command from its own body: write \`issues ${owner.id}\` in policy '${t}' and remove this \`by\``;
                if (target.kind === 'command') return `a command never issues a command: ${policy}`;
                if (target.kind === 'event') return `an event never issues a command: put a policy between, \`policy <Id> { on ${t} issues ${owner.id} }\``;
                break;
            case 'handledBy':
                if (target.kind === 'actor') return `an actor issues a command: write \`by ${t}\`; the handler is an aggregate or an external system`;
                if (target.kind === 'readmodel') return `a read model is what the issuer looks at: write \`reads ${t}\``;
                if (target.kind === 'event') return `an event is an outcome: write \`emits ${t}\``;
                if (target.kind === 'command') return `a command never hands over to a command: ${policy.replace(owner.id, t)}`;
                if (target.kind === 'policy') return `a policy reacts to events: write \`on <an event this command emits>\` in policy '${t}'`;
                break;
            case 'reads':
                if (target.kind === 'event')
                    return `a command reads a read model, not an event: declare \`readmodel <Id> { from ${t} }\` and write \`reads <Id>\``;
                if (target.kind === 'aggregate')
                    return `an aggregate is not read: write \`handledBy ${t}\` if it handles the command; what the issuer looks at is a read model`;
                if (target.kind === 'actor' || target.kind === 'external') return `who issues the command is \`by ${t}\``;
                break;
            case 'on':
                if (target.kind === 'command') return `the actor reacts to an event, not to a command: write \`on <an event '${t}' emits>\``;
                if (target.kind === 'policy')
                    return `the actor reacts to an event: write \`on\` the event policy '${t}' is \`on\`, or let policy '${t}' issue it`;
                if (target.kind === 'readmodel') return `what the issuer looks at to decide is \`reads ${t}\`; \`on\` names the event it reacts to`;
                if (target.kind === 'actor' || target.kind === 'external') return `who issues the command is \`by ${t}\`; \`on\` names the event it reacts to`;
                if (target.kind === 'aggregate') return `who handles the command is \`handledBy ${t}\`; \`on\` names the event its issuer reacts to`;
                break;
            case 'emits':
                if (target.kind === 'command')
                    return `a command never issues a command: let it emit an event, and put a policy between, \`policy <Id> { on <that event> issues ${t} }\``;
                if (target.kind === 'aggregate' || target.kind === 'external')
                    return `who handles the command is \`handledBy ${t}\`; \`emits\` names its events`;
                if (target.kind === 'policy') return `a policy reacts to an event: emit the event, and write \`on <that event>\` in policy '${t}'`;
                break;
        }
    }
    if (owner.kind === 'policy') {
        if (keyword === 'by' && target.kind !== 'actor')
            return `who applies a policy by hand is an actor (\`by <actor>\`); a system's rule needs no \`by\`: the policy is its issuer`;
        if (keyword === 'on' && target.kind === 'command') return `a policy reacts to an event: write \`on <an event '${t}' emits>\``;
        if (keyword === 'issues' && target.kind === 'event')
            return `a policy issues commands; an event is emitted by the command it issues (\`emits ${t}\` in that command)`;
        if (keyword === 'issues' && target.kind === 'policy') return `a policy never issues a policy: issue a command whose event policy '${t}' is \`on\``;
        if (keyword === 'reads' && target.kind === 'event')
            return `a policy reads a read model, not an event: declare \`readmodel <Id> { from ${t} }\` and write \`reads <Id>\` (what it reacts to is \`on ${t}\`)`;
        if (keyword === 'reads' && target.kind === 'aggregate')
            return `an aggregate is not read: what the policy looks at to decide is a read model (\`readmodel <Id> { from <its events> }\`)`;
        if (keyword === 'reads' && (target.kind === 'actor' || target.kind === 'external'))
            return `who applies a policy by hand is \`by ${t}\`; \`reads\` names the read model it looks at`;
    }
    if (owner.kind === 'readmodel' && target.kind === 'external')
        return `data from an external system arrives as an event: declare \`event <Id> { from ${t} }\` and write \`from <Id>\``;
    if (owner.kind === 'readmodel' && target.kind === 'command') return `a read model is fed from events: write \`from <an event '${t}' emits>\``;
    if (owner.kind === 'event') {
        if (target.kind === 'command')
            return `an event comes from a command through \`emits\`: write \`emits ${owner.id}\` in command '${t}' and remove this \`from\``;
        if (target.kind === 'actor') return `an actor issues commands: declare a command \`by ${t}\` that \`emits ${owner.id}\`, and remove this \`from\``;
        if (target.kind === 'aggregate') return `write \`emits ${owner.id}\` in a command \`handledBy ${t}\`, and remove this \`from\``;
    }
    if (owner.kind === 'hotspot') return `a hotspot is on a sticky: an event, actor, external system, command, policy, aggregate or read model`;
    return undefined;
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The relation clauses a kind takes, for S006 messages. */
function relationList(kind: NodeElementKind): string {
    const keywords = Object.keys(RELATION_RULES[kind] ?? {});
    return keywords.length ? keywords.map((k) => `\`${k}\``).join(', ') : 'no relation';
}

function relationHint(kind: NodeElementKind, keyword: RelationKeyword): string {
    const owners = NODE_KINDS.filter((k) => RELATION_RULES[k]?.[keyword]);
    const where = owners.length ? `; \`${keyword}\` belongs in ${kindList(owners)}` : '';
    return `remove the clause${where}`;
}

/**
 * S014: the type-level cycles policy → command (`issues`) → event (`emits`) → policy (`on`), over valid relations only.
 * One warning per strongly connected component, at its first policy in source order, with one cycle through it as an
 * example. Iterative, so a large or tangled storming cannot exhaust the stack.
 */
function cycles(storming: Storming, byId: ReadonlyMap<string, AnyDeclaration>): Diagnostic[] {
    const next = new Map<string, string[]>();
    const add = (from: string, to: string) => {
        const list = next.get(from) ?? [];
        if (!list.includes(to)) list.push(to);
        next.set(from, list);
    };
    const isKind = (id: string, kind: ElementKind) => byId.get(id)?.kind === kind;
    const policies: NodeElement[] = [];
    for (const el of storming.elements) {
        if (el.kind === 'timeline' || el.kind === 'stage' || byId.get(el.id) !== el) continue;
        for (const c of el.clauses) {
            if (c.type !== 'relation') continue;
            if (el.kind === 'policy' && c.keyword === 'issues' && isKind(c.target, 'command')) add(el.id, c.target);
            if (el.kind === 'policy' && c.keyword === 'on' && isKind(c.target, 'event')) add(c.target, el.id);
            if (el.kind === 'command' && c.keyword === 'emits' && isKind(c.target, 'event')) add(el.id, c.target);
        }
        if (el.kind === 'policy') policies.push(el);
    }

    const components = stronglyConnected([...byId.keys()], (id) => next.get(id) ?? []);
    const out: Diagnostic[] = [];
    const reported = new Set<number>();
    for (const policy of policies) {
        const component = components.get(policy.id)!;
        if (reported.has(component.index) || component.members.size < 2) continue;
        reported.add(component.index);
        const path = cycleThrough(policy.id, (id) => (next.get(id) ?? []).filter((n) => component.members.has(n)));
        out.push(
            esDiagnostic(
                'warning',
                'S014',
                `Policy '${policy.id}' is on a type-level cycle: ${path.join(' → ')}. Every step is only a possibility, so this is a cycle of possibilities, not an infinite loop.`,
                policy.nameRange,
                {
                    hint: `nothing to change if the repetition is intended (a retry, a recurring process); otherwise check the \`on\`, \`issues\` and \`emits\` along the cycle, or record the stop condition in a hotspot`,
                    elementId: esElementId(storming.id, policy.id),
                },
            ),
        );
    }
    return out;
}

/** Tarjan's strongly connected components, without recursion: each node → its component. */
function stronglyConnected(nodes: readonly string[], successors: (id: string) => readonly string[]): Map<string, { index: number; members: Set<string> }> {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const result = new Map<string, { index: number; members: Set<string> }>();
    let counter = 0;
    let componentCount = 0;
    for (const root of nodes) {
        if (index.has(root)) continue;
        const work: { id: string; i: number }[] = [{ id: root, i: 0 }];
        index.set(root, counter);
        low.set(root, counter++);
        stack.push(root);
        onStack.add(root);
        while (work.length) {
            const frame = work.at(-1)!;
            const succ = successors(frame.id);
            if (frame.i < succ.length) {
                const n = succ[frame.i++]!;
                if (!index.has(n)) {
                    index.set(n, counter);
                    low.set(n, counter++);
                    stack.push(n);
                    onStack.add(n);
                    work.push({ id: n, i: 0 });
                } else if (onStack.has(n)) {
                    low.set(frame.id, Math.min(low.get(frame.id)!, index.get(n)!));
                }
                continue;
            }
            work.pop();
            const parent = work.at(-1);
            if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
            if (low.get(frame.id) !== index.get(frame.id)) continue;
            const component = { index: componentCount++, members: new Set<string>() };
            let member: string;
            do {
                member = stack.pop()!;
                onStack.delete(member);
                component.members.add(member);
                result.set(member, component);
            } while (member !== frame.id);
        }
    }
    return result;
}

/** A shortest cycle from `start` back to it (breadth-first), as the IDs along it, `start` at both ends. */
function cycleThrough(start: string, successors: (id: string) => readonly string[]): string[] {
    const parent = new Map<string, string>();
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
        const id = queue[i]!;
        for (const n of successors(id)) {
            if (n === start) {
                const path: string[] = [];
                for (let at: string | undefined = id; at !== undefined && at !== start; at = parent.get(at)) path.unshift(at);
                return [start, ...path, start];
            }
            if (!parent.has(n)) {
                parent.set(n, id);
                queue.push(n);
            }
        }
    }
    return [start];
}
