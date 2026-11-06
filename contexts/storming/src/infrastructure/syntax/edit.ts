// A person's edit of a sticky, written into its `.dtes` file without an AI run (ADR 0033): its label, its name (the
// local ID) with every reference to it, a new hotspot on an event, a hotspot's resolution. Planned on the parsed AST
// of the one file: only the ranges of the tokens concerned are replaced or text inserted next to them, the rest of the
// file is kept byte for byte (no `dt fmt`). The result is parsed again and refused if it no longer parses.
import { AstUtils, GrammarUtils, type AstNode, type CstNode, type Reference } from 'langium';
import {
    isEsAfterClause,
    isEsEvent,
    isEsEventStep,
    isEsHotspot,
    isEsRejoin,
    isEsRelationClause,
    isEsResolutionClause,
    isEsStatusClause,
    type EsDeclaration,
    type EsFile,
    type EsHotspot,
    type EsStorming,
} from './generated/ast.js';
import { createStormingServices, stormingDeclarations } from './module.js';
import { localNameProblem, type LocalNameProblem } from '../../domain/references.js';

/** The longest label a person writes on a sticky (a hotspot's question included). */
export const MAX_STICKY_LABEL = 200;
/** The longest resolution of a hotspot a person writes. */
export const MAX_RESOLUTION = 2000;

/** What a sticky is called: its local ID and its label (none when it has none). */
export interface StickyWording {
    readonly name: string;
    readonly label?: string;
}

/** A person's edit of a sticky of one storming. */
export type StickyEditInput =
    /**
     * Its label and/or its name: `expected` is what the person saw (the edit is refused when the file says otherwise);
     * `label` / `name` absent keep what it has.
     */
    | {
          readonly kind: 'wording';
          readonly storming: string;
          readonly element: string;
          readonly expected: StickyWording;
          readonly label?: string;
          readonly name?: string;
      }
    /** A new open hotspot on an event, in the canonical place (after the storming's last hotspot, else last). */
    /**
     * A new open hotspot on an event, in the canonical place (after the storming's last hotspot, else last); its question
     * may hold line breaks (written as `\n`). `uniqueName`: a name already taken gets the first free numeric suffix
     * (`Name2`, `Name3`, …) instead of being refused.
     */
    | {
          readonly kind: 'addHotspot';
          readonly storming: string;
          readonly on: string;
          readonly name: string;
          readonly label: string;
          readonly uniqueName?: boolean;
      }
    /** A hotspot resolved: `status resolved` and its `resolution`. */
    | { readonly kind: 'resolveHotspot'; readonly storming: string; readonly element: string; readonly resolution: string };

/** The edit planned: the file's new text, the sticky before and after, and how many references were rewritten. */
export interface StickyEditPlan {
    readonly text: string;
    /** The sticky before (a new hotspot: none). */
    readonly before?: StickyWording;
    readonly after: StickyWording;
    readonly references: number;
}

/** Why an edit is not made; the file is left as it is. */
export type StickyEditProblem =
    /** The file does not parse now: nothing is located in it. */
    | { readonly type: 'SyntaxError' }
    /** The file has no storming of that ID. */
    | { readonly type: 'StormingNotFound' }
    /** No such element in the storming (or no event a hotspot is to be on). */
    | { readonly type: 'NotFound' }
    /** The sticky is no longer as the person saw it: what it is now. */
    | { readonly type: 'Stale'; readonly current: StickyWording }
    | { readonly type: 'InvalidName'; readonly problem: LocalNameProblem }
    /** An empty label, one on several lines, or one too long. */
    | { readonly type: 'InvalidLabel' }
    /** A hotspot is put on an event only; a resolution is written on a hotspot only. */
    | { readonly type: 'WrongKind' }
    /** Nothing would change. */
    | { readonly type: 'NothingToChange' }
    /** The edited text would not parse (a safety net: the checks above should never let it happen). */
    | { readonly type: 'NoLongerParses' };

export type StickyEditResult = { readonly ok: true; readonly value: StickyEditPlan } | { readonly ok: false; readonly error: StickyEditProblem };

let services: ReturnType<typeof createStormingServices>['EventStorming'] | undefined;

function parse(text: string): EsFile | undefined {
    services ??= createStormingServices().EventStorming;
    const parsed = services.parser.LangiumParser.parse<EsFile>(text);
    return parsed.lexerErrors.length || parsed.parserErrors.length ? undefined : parsed.value;
}

/** A label as written in a `.dtes` string: quotes, backslashes and line breaks escaped. */
export const quoteLabel = (label: string): string =>
    `"${label
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r\n|\r|\n/g, '\\n')}"`;

/** The longest question of a hotspot a person writes (several lines). */
export const MAX_HOTSPOT_QUESTION = 1000;

const validText = (text: string, max: number): boolean => text.trim().length > 0 && text.length <= max && !/[\r\n]/.test(text);

interface Splice {
    readonly offset: number;
    readonly end: number;
    readonly text: string;
}

/** Applies non-overlapping splices (any order). */
function apply(text: string, splices: readonly Splice[]): string {
    let out = text;
    for (const s of [...splices].sort((a, b) => b.offset - a.offset)) out = out.slice(0, s.offset) + s.text + out.slice(s.end);
    return out;
}

const propertyNode = (node: AstNode, property: string): CstNode | undefined =>
    node.$cstNode ? GrammarUtils.findNodeForProperty(node.$cstNode, property) : undefined;

/** The indentation of the line `offset` is on. */
function indentAt(text: string, offset: number): string {
    const start = text.lastIndexOf('\n', offset - 1) + 1;
    return /^[ \t]*/.exec(text.slice(start))?.[0] ?? '';
}

/** Every reference to `name` inside a storming: the relation clauses, the steps, the `then` and the `after`. */
function referencesIn(storming: EsStorming, name: string): CstNode[] {
    const out: CstNode[] = [];
    const add = (ref: Reference): void => {
        if (ref.$refText === name && ref.$refNode) out.push(ref.$refNode);
    };
    for (const node of AstUtils.streamAst(storming)) {
        if (isEsRelationClause(node)) add(node.target);
        else if (isEsEventStep(node) || isEsRejoin(node)) add(node.event);
        else if (isEsAfterClause(node)) add(node.stage);
    }
    return out;
}

function located(text: string, stormingId: string): { storming: EsStorming; declarations: EsDeclaration[] } | StickyEditProblem {
    const file = parse(text);
    if (!file) return { type: 'SyntaxError' };
    const storming = file.stormings.find((s) => s.name === stormingId);
    if (!storming) return { type: 'StormingNotFound' };
    return { storming, declarations: stormingDeclarations(storming) };
}

/** `name` with the first numeric suffix that no declaration has (`Name2`, `Name3`, …). */
function freeName(name: string, taken: ReadonlySet<string>): string {
    for (let i = 2; ; i++) if (!taken.has(`${name}${i}`)) return `${name}${i}`;
}

const wordingOf = (d: EsDeclaration): StickyWording => ({ name: d.name, ...(d.label !== undefined && { label: d.label }) });

/**
 * What a declaration of a storming is called in a file's text now; undefined when the file does not parse or has no
 * such storming or declaration.
 */
export function stickyWording(text: string, stormingId: string, element: string): StickyWording | undefined {
    const found = located(text, stormingId);
    if ('type' in found) return undefined;
    const decl = found.declarations.find((d) => d.name === element);
    return decl && wordingOf(decl);
}

/** Plans a person's edit of a sticky in the text of the `.dtes` file holding its storming. */
export function planStickyEdit(text: string, input: StickyEditInput): StickyEditResult {
    const found = located(text, input.storming);
    if ('type' in found) return { ok: false, error: found };
    const planned = plan(text, found.storming, found.declarations, input);
    if (!planned.ok) return planned;
    // the safety net: the edited file parses
    if (!parse(planned.value.text)) return { ok: false, error: { type: 'NoLongerParses' } };
    return planned;
}

function plan(text: string, storming: EsStorming, declarations: readonly EsDeclaration[], input: StickyEditInput): StickyEditResult {
    const taken = new Set(declarations.map((d) => d.name));
    const fail = (error: StickyEditProblem): StickyEditResult => ({ ok: false, error });
    switch (input.kind) {
        case 'wording': {
            const decl = declarations.find((d) => d.name === input.element);
            if (!decl) return fail({ type: 'NotFound' });
            const current = wordingOf(decl);
            if (current.label !== input.expected.label || current.name !== input.expected.name) return fail({ type: 'Stale', current });
            const label = input.label ?? current.label;
            const name = input.name ?? current.name;
            if (input.label !== undefined && !validText(input.label, MAX_STICKY_LABEL)) return fail({ type: 'InvalidLabel' });
            const problem = localNameProblem(name, taken, current.name);
            if (problem) return fail({ type: 'InvalidName', problem });
            if (label === current.label && name === current.name) return fail({ type: 'NothingToChange' });
            const splices: Splice[] = [];
            const nameNode = propertyNode(decl, 'name');
            if (!nameNode) return fail({ type: 'NotFound' });
            if (label !== current.label && label !== undefined) {
                const labelNode = propertyNode(decl, 'label');
                splices.push(
                    labelNode
                        ? { offset: labelNode.offset, end: labelNode.end, text: quoteLabel(label) }
                        : { offset: nameNode.end, end: nameNode.end, text: ` ${quoteLabel(label)}` },
                );
            }
            let references = 0;
            if (name !== current.name) {
                splices.push({ offset: nameNode.offset, end: nameNode.end, text: name });
                const refs = referencesIn(storming, current.name);
                references = refs.length;
                for (const r of refs) splices.push({ offset: r.offset, end: r.end, text: name });
            }
            return {
                ok: true,
                value: {
                    text: apply(text, splices),
                    before: current,
                    after: { name, ...(label !== undefined && { label }) },
                    references,
                },
            };
        }
        case 'addHotspot': {
            const on = declarations.find((d) => d.name === input.on);
            if (!on) return fail({ type: 'NotFound' });
            if (!isEsEvent(on)) return fail({ type: 'WrongKind' });
            if (input.label.trim().length === 0 || input.label.length > MAX_HOTSPOT_QUESTION) return fail({ type: 'InvalidLabel' });
            const problem = localNameProblem(input.name, taken);
            if (problem && !(problem === 'duplicate' && input.uniqueName)) return fail({ type: 'InvalidName', problem });
            const name = problem ? freeName(input.name, taken) : input.name;
            // after the storming's last hotspot, else after its last element; indented as that element
            const anchor = storming.elements.filter(isEsHotspot).at(-1) ?? storming.elements.at(-1);
            const declaration = (indent: string): string => `${indent}hotspot ${name} ${quoteLabel(input.label)} {\n${indent}  on ${input.on}\n${indent}}`;
            let edited: string;
            if (anchor?.$cstNode) {
                const indent = indentAt(text, anchor.$cstNode.offset);
                edited = apply(text, [{ offset: anchor.$cstNode.end, end: anchor.$cstNode.end, text: `\n${declaration(indent)}` }]);
            } else {
                // an empty storming: before its closing brace
                const cst = storming.$cstNode;
                if (!cst) return fail({ type: 'NotFound' });
                const close = cst.end - 1;
                const outer = indentAt(text, cst.offset);
                const head = text.slice(0, close).trimEnd();
                edited = `${head}\n${declaration(`${outer}  `)}\n${outer}${text.slice(close)}`;
            }
            return { ok: true, value: { text: edited, after: { name, label: input.label }, references: 0 } };
        }
        case 'resolveHotspot': {
            const decl = declarations.find((d) => d.name === input.element);
            if (!decl) return fail({ type: 'NotFound' });
            if (!isEsHotspot(decl)) return fail({ type: 'WrongKind' });
            // several lines allowed (written as `\n`)
            if (input.resolution.trim().length === 0 || input.resolution.length > MAX_RESOLUTION) return fail({ type: 'InvalidLabel' });
            const splices = resolveSplices(text, decl, input.resolution);
            if (splices.length === 0) return fail({ type: 'NothingToChange' });
            return { ok: true, value: { text: apply(text, splices), before: wordingOf(decl), after: wordingOf(decl), references: 0 } };
        }
    }
}

/** The splices that make a hotspot `status resolved` with `resolution`, keeping its other clauses where they are. */
function resolveSplices(text: string, hotspot: EsHotspot, resolution: string): Splice[] {
    const quoted = quoteLabel(resolution);
    const status = hotspot.clauses.find(isEsStatusClause);
    const written = hotspot.clauses.find(isEsResolutionClause);
    const cst = hotspot.$cstNode;
    if (!cst) return [];
    const indent = indentAt(text, cst.offset);
    const inner = `${indent}  `;
    const splices: Splice[] = [];
    if (status) {
        const value = propertyNode(status, 'value');
        if (value && status.value !== 'resolved') splices.push({ offset: value.offset, end: value.end, text: 'resolved' });
    }
    if (written) {
        const t = propertyNode(written, 'text');
        if (t && written.text !== resolution) splices.push({ offset: t.offset, end: t.end, text: quoted });
    }
    const missing = [...(status ? [] : ['status resolved']), ...(written ? [] : [`resolution ${quoted}`])];
    if (missing.length === 0) return splices;
    const lines = missing.map((m) => `\n${inner}${m}`).join('');
    const last = hotspot.clauses.at(-1)?.$cstNode;
    if (last) splices.push({ offset: last.end, end: last.end, text: lines });
    else {
        // no clauses: a body of its own after the label (or the name); an empty `{}` is replaced
        const brace = text.lastIndexOf('{', cst.end);
        const hasBody = text.slice(cst.offset, cst.end).trimEnd().endsWith('}') && brace > cst.offset;
        const after = propertyNode(hotspot, 'label') ?? propertyNode(hotspot, 'name');
        if (!after) return [];
        splices.push({ offset: after.end, end: hasBody ? cst.end : after.end, text: ` {${lines}\n${indent}}` });
    }
    return splices;
}
