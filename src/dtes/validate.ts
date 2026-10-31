import { compareDiagnostics, type Diagnostic } from '../core/diagnostics.js';
import { didYouMean } from '../core/suggest.js';
import {
    declarations,
    esDiagnostic,
    esElementId,
    RELATION_RULES,
    REF_KINDS,
    type AnyDeclaration,
    type Clause,
    type ElementKind,
    type EventStepRef,
    type NodeElement,
    type NodeElementKind,
    type RelationKeyword,
    type SourceRange,
    type Storming,
} from './ir.js';

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
};

const NODE_KINDS: readonly NodeElementKind[] = ['event', 'actor', 'external', 'command', 'policy', 'aggregate', 'readmodel', 'hotspot'];

/** At most this many declarations are listed in a hint. */
const MAX_LISTED = 5;

const article = (word: string): string => (/^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`);
const kindList = (kinds: readonly ElementKind[]): string => kinds.map((k) => article(KIND_NAMES[k])).join(' or ');
const line = (range: SourceRange): number => range.start.line;

/**
 * The checks of a `.dtes` storming that need no `.dt` model (spec §11, ADR 0024: S001–S009 and S014), on the storming
 * IR only:
 *   - S001: a local ID declared twice in a storming (across kinds, timelines and groups included), a storming ID twice
 *   - S002: a relation target or timeline step that names no declaration of its storming
 *   - S003: a reference to a declaration of the wrong kind (`RELATION_RULES`; timeline and group steps name events)
 *   - S004: more than one `target`, `ref`, hotspot `on`, `status` or `resolution`
 *   - S005: a `ref` on an element other than an event, aggregate or command
 *   - S006: a clause the element kind does not take
 *   - S007: an event twice in one group
 *   - S008: a policy without `on` or without `issues`
 *   - S009: a hotspot `status` other than `open`/`resolved`, `resolved` without `resolution`, `resolution` when open
 *   - S014 (warning): a type-level cycle policy → command → event → policy
 * Not diagnosed (spec §11): timeline order against causality, completeness (unreferenced events, missing `emits`,
 * events in no timeline) and the optional Info rule on policies with several `on` and `issues`.
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

    /** The declaration a local reference names, reporting S002/S003 when there is none of an allowed kind. */
    const resolve = (name: string, range: SourceRange, allowed: readonly ElementKind[], where: string, ownerId: string): AnyDeclaration | undefined => {
        const target = byId.get(name);
        if (target && allowed.includes(target.kind)) return target;
        const candidates = decls.filter((d) => allowed.includes(d.kind)).map((d) => d.id);
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
                hint: suggestion ?? existing,
                elementId: elementId(ownerId),
            }),
        );
        return undefined;
    };

    for (const el of storming.elements) {
        if (el.kind === 'timeline') {
            for (const step of el.steps) {
                if (step.type === 'event') {
                    resolve(step.eventId, step.range, ['event'], `A step of timeline '${el.id}'`, el.id);
                    continue;
                }
                checkGroup(step.id, step.events, el.id);
            }
            continue;
        }
        checkClauses(el);
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
        const report = (code: 'S004' | 'S005' | 'S006', message: string, range: SourceRange, hint: string) =>
            out.push(esDiagnostic('error', code, message, range, { hint, elementId: elementId(el.id) }));
        /** S004 on every clause after the first of a kind that is allowed at most once. */
        const counts = new Map<string, number>();
        const once = (written: string, clause: Clause): void => {
            const n = (counts.get(written) ?? 0) + 1;
            counts.set(written, n);
            if (n >= 2) {
                report(
                    'S004',
                    `${what} has more than one \`${written}\`; it takes at most one.`,
                    clause.range,
                    `keep one \`${written}\` and remove the others`,
                );
            }
        };

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
                case 'relation': {
                    const allowed = rules[clause.keyword];
                    if (!allowed) {
                        report(
                            'S006',
                            `${what} has \`${clause.keyword} ${clause.target}\`, but ${article(kind)} takes ${relationList(el.kind)}.`,
                            clause.range,
                            relationHint(el.kind, clause.keyword),
                        );
                        break;
                    }
                    if (clause.keyword === 'target' || (el.kind === 'hotspot' && clause.keyword === 'on')) once(clause.keyword, clause);
                    resolve(clause.target, clause.targetRange, allowed, `\`${clause.keyword}\` of ${kind} '${el.id}'`, el.id);
                    break;
                }
            }
        }

        if (el.kind === 'policy') checkPolicy(el);
        if (el.kind === 'hotspot') checkHotspot(el);
    }

    function checkPolicy(el: NodeElement): void {
        const has = (keyword: RelationKeyword) => el.clauses.some((c) => c.type === 'relation' && c.keyword === keyword);
        const missing = (['on', 'issues'] as const).filter((k) => !has(k));
        if (!missing.length) return;
        const clauses = missing.map((k) => `\`${k}\``).join(' and ');
        out.push(
            esDiagnostic(
                'error',
                'S008',
                `Policy '${el.id}' has no ${clauses}; a policy reacts to at least one event (\`on\`) and may issue at least one command (\`issues\`).`,
                el.nameRange,
                {
                    hint: `add ${missing.map((k) => (k === 'on' ? '`on <Event>`' : '`issues <Command>`')).join(' and ')}; while it is unknown, record the question as a hotspot instead`,
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
        if (el.kind === 'timeline' || byId.get(el.id) !== el) continue;
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
                `Policy '${policy.id}' is on a type-level cycle: ${path.join(' → ')}. Each step only may follow the previous one, so this is a cycle of possibilities, not an infinite loop.`,
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
