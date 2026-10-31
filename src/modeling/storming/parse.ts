import * as nodePath from 'node:path';
import { GrammarUtils, URI, type AstNode, type CstNode, type LangiumDocument } from 'langium';
import {
    isEsActor,
    isEsAggregate,
    isEsCommand,
    isEsEvent,
    isEsExternal,
    isEsGroup,
    isEsHotspot,
    isEsPolicy,
    isEsReadModel,
    isEsRefClause,
    isEsRelationClause,
    isEsStatusClause,
    isEsTimeline,
    type EsClause,
    type EsEventStep,
    type EsFile,
    type EsGroup,
    type EsNode,
    type EsStorming,
    type EsTimeline,
} from '../language/generated/ast.js';
import type { SourceFile } from '../core/analyze.js';
import { compareDiagnostics, type Diagnostic } from '../core/diagnostics.js';
import { docComment } from '../core/labels.js';
import type { Clause, EventStepRef, Group, NodeElement, NodeElementKind, SourceRange, Storming, Timeline } from './ir.js';
import { createStormingServices } from './language/module.js';

/**
 * Parses `.dtes` sources (ADR 0024, T2). The diagnostics are syntax errors only (`SYNTAX`); the storming IR is built for
 * every file that parses, in file order. Local references are linked (for the LSP) but their errors are dropped: an
 * unknown or wrong-kind target is reported by the validator from the IR (S002, S003).
 */
export async function parseStormings(sources: readonly SourceFile[]): Promise<{ stormings: Storming[]; diagnostics: Diagnostic[]; syntaxOk: boolean }> {
    const { shared } = createStormingServices();
    const factory = shared.workspace.LangiumDocumentFactory;
    const documents = sources.map((s) => {
        const doc = factory.fromString<EsFile>(s.text, URI.file(nodePath.resolve('/__domaintrail__', s.path)));
        shared.workspace.LangiumDocuments.addDocument(doc);
        return doc;
    });
    await shared.workspace.DocumentBuilder.build(documents, { validation: { categories: ['built-in'] } });

    const stormings: Storming[] = [];
    const diagnostics: Diagnostic[] = [];
    documents.forEach((doc, i) => {
        const file = sources[i].path;
        const errors = syntaxDiagnostics(doc, file);
        diagnostics.push(...errors);
        if (!errors.length) stormings.push(...toStormingIr(doc.parseResult.value, file));
    });
    diagnostics.sort(compareDiagnostics);
    return { stormings, diagnostics, syntaxOk: diagnostics.length === 0 };
}

function syntaxDiagnostics(doc: LangiumDocument<EsFile>, file: string): Diagnostic[] {
    return (doc.diagnostics ?? [])
        .filter((d) => {
            // Langium's diagnostic data (typed `any` by the LSP types)
            const data: { code?: string } | undefined = d.data;
            return data?.code !== 'linking-error';
        })
        .map((d) => ({
            file,
            start: { line: d.range.start.line + 1, column: d.range.start.character + 1 },
            end: { line: d.range.end.line + 1, column: d.range.end.character + 1 },
            severity: 'error',
            code: 'SYNTAX',
            message: typeof d.message === 'string' ? d.message : d.message.value,
        }));
}

/** The stormings of a parsed `.dtes` file, as written (also for the LSP, which parses through its own services). */
export function toStormingIr(file: EsFile, path: string): Storming[] {
    const range = (cst: CstNode | undefined): SourceRange => {
        const r = cst?.range;
        return {
            file: path,
            start: { line: (r?.start.line ?? 0) + 1, column: (r?.start.character ?? 0) + 1 },
            end: { line: (r?.end.line ?? 0) + 1, column: (r?.end.character ?? 0) + 1 },
        };
    };
    const propertyRange = (node: AstNode, property: string): SourceRange =>
        range((node.$cstNode && GrammarUtils.findNodeForProperty(node.$cstNode, property)) ?? node.$cstNode);
    const declaration = (node: AstNode & { name: string; label?: string }) => {
        const doc = docComment(node);
        return {
            id: node.name,
            ...(node.label !== undefined ? { label: node.label } : {}),
            ...(doc !== undefined ? { doc } : {}),
            range: range(node.$cstNode),
            nameRange: propertyRange(node, 'name'),
        };
    };

    const clause = (c: EsClause): Clause => {
        if (isEsRefClause(c)) return { type: 'ref', path: c.path, segments: c.path.split('.'), range: range(c.$cstNode) };
        if (isEsRelationClause(c)) {
            return {
                type: 'relation',
                keyword: c.keyword,
                target: c.target.$refText,
                range: range(c.$cstNode),
                targetRange: propertyRange(c, 'target'),
            };
        }
        if (isEsStatusClause(c)) return { type: 'status', value: c.value, range: range(c.$cstNode) };
        return { type: 'resolution', text: c.text, range: range(c.$cstNode) };
    };
    const step = (s: EsEventStep): EventStepRef => ({ eventId: s.event.$refText, range: range(s.$cstNode) });
    const group = (g: EsGroup): Group => ({ ...declaration(g), kind: 'group', events: g.events.map(step) });
    const timeline = (t: EsTimeline): Timeline => ({
        ...declaration(t),
        kind: 'timeline',
        steps: t.steps.map((s) => (isEsGroup(s) ? { type: 'group', ...group(s) } : { type: 'event', ...step(s) })),
    });
    const node = (n: EsNode): NodeElement => ({ ...declaration(n), kind: nodeKind(n), clauses: n.clauses.map(clause) });

    return file.stormings.map((s: EsStorming) => ({
        ...declaration(s),
        elements: s.elements.map((el) => (isEsTimeline(el) ? timeline(el) : node(el))),
    }));
}

function nodeKind(n: EsNode): NodeElementKind {
    if (isEsEvent(n)) return 'event';
    if (isEsActor(n)) return 'actor';
    if (isEsExternal(n)) return 'external';
    if (isEsCommand(n)) return 'command';
    if (isEsPolicy(n)) return 'policy';
    if (isEsAggregate(n)) return 'aggregate';
    if (isEsReadModel(n)) return 'readmodel';
    if (isEsHotspot(n)) return 'hotspot';
    return n satisfies never;
}
