import * as path from 'node:path';
import { URI, type LangiumDocument } from 'langium';
import type { Model } from '../language/generated/ast.js';
import { createDomainServices } from '../language/domain-module.js';
import { buildModel } from '../model/build.js';
import { elementIdOf } from '../model/ids.js';
import type { DomainModel } from '../model/model.js';
import { checkCommands } from './checker/commands.js';
import { checkInvariants } from './checker/expressions.js';
import { checkLabels } from './checker/labels.js';
import { checkNames } from './checker/names.js';
import { checkShared } from './checker/shared.js';
import { checkStructure } from './checker/structure.js';
import { checkTsNames } from './checker/tsnames.js';
import { checkUnions } from './checker/unions.js';
import { DiagnosticSink, compareDiagnostics, hasErrors, type Diagnostic, type RuleId } from './diagnostics.js';
import { ModelIndex } from './model-index.js';

export interface SourceFile {
    /** Path used in diagnostics (typically relative to the workspace root). */
    path: string;
    text: string;
}

export interface Analysis {
    files: string[];
    documents: LangiumDocument<Model>[];
    index: ModelIndex;
    diagnostics: Diagnostic[];
    /** True when every file parsed without lexer/parser errors. */
    syntaxOk: boolean;
    /** True when there are no error-level diagnostics at all. */
    ok: boolean;
    /** Typed Model; present whenever the sources parse (semantic errors are tolerated). */
    model?: DomainModel;
}

/** Maps the property of an unresolved cross-reference to the rule that covers it. */
const LINK_RULES: Record<string, RuleId> = {
    from: 'M006',
    to: 'M006',
    emits: 'M007',
    errors: 'M007',
};

/** Parses, links and validates a set of `.dt` sources as one workspace. */
export async function analyze(sources: readonly SourceFile[]): Promise<Analysis> {
    const { shared, Domain } = createDomainServices();
    const factory = shared.workspace.LangiumDocumentFactory;
    const fileOf = new Map<string, string>();

    const documents = sources.map((s) => {
        const uri = URI.file(path.resolve('/__domaintrail__', s.path));
        fileOf.set(uri.toString(), s.path);
        const doc = factory.fromString<Model>(s.text, uri);
        shared.workspace.LangiumDocuments.addDocument(doc);
        return doc;
    });

    await shared.workspace.DocumentBuilder.build(documents, { validation: { categories: ['built-in'] } });

    const resolveFile = (uri: string): string => fileOf.get(uri) ?? uri;
    const diagnostics: Diagnostic[] = [];
    let syntaxOk = true;
    for (const doc of documents) {
        for (const d of doc.diagnostics ?? []) {
            const code = (d.data as { code?: string } | undefined)?.code;
            const isLink = code === 'linking-error';
            if (!isLink) syntaxOk = false;
            const data = d.data as { property?: string; refText?: string } | undefined;
            const property = data?.property ?? '';
            diagnostics.push({
                file: resolveFile(doc.uri.toString()),
                start: { line: d.range.start.line + 1, column: d.range.start.character + 1 },
                end: { line: d.range.end.line + 1, column: d.range.end.character + 1 },
                severity: d.severity === 2 ? 'warning' : 'error',
                code: isLink ? (LINK_RULES[property] ?? 'M001') : 'SYNTAX',
                message: isLink ? linkMessage(property, data?.refText ?? '') : typeof d.message === 'string' ? d.message : d.message.value,
                elementId: isLink ? elementAt(doc, d.range.start.line, d.range.start.character) : undefined,
            });
        }
    }

    const index = new ModelIndex(documents.map((d) => d.parseResult.value));
    if (syntaxOk) {
        const sink = new DiagnosticSink(resolveFile);
        checkNames(index, sink);
        checkShared(index, sink);
        checkStructure(index, sink);
        checkUnions(index, sink);
        checkCommands(index, sink);
        checkInvariants(index, sink);
        checkTsNames(index, sink);
        checkLabels(index, sink);
        diagnostics.push(...sink.items);
    }

    diagnostics.sort(compareDiagnostics);
    return {
        files: sources.map((s) => s.path),
        documents,
        index,
        diagnostics: dedupe(diagnostics),
        syntaxOk,
        ok: syntaxOk && !hasErrors(diagnostics),
        model: syntaxOk ? buildModel(index, resolveFile) : undefined,
    };
}

const LINK_KINDS: Record<string, string> = {
    from: 'state',
    to: 'state',
    emits: 'event',
    errors: 'error',
    target: 'aggregate',
    decl: 'type',
};

function linkMessage(property: string, refText: string): string {
    const kind = LINK_KINDS[property] ?? 'element';
    const hint = refText.includes('.') ? '' : kind === 'state' ? ' in this aggregate' : ' in this context (use Context.Name for other contexts)';
    return `Cannot resolve ${kind} '${refText}'${hint}.`;
}

function elementAt(doc: LangiumDocument, line: number, character: number): string | undefined {
    const root = doc.parseResult.value.$cstNode;
    if (!root) return undefined;
    const offset = doc.textDocument.offsetAt({ line, character });
    let node = root;
    for (;;) {
        const children = (node as { content?: typeof root[] }).content;
        const next = children?.find((c) => c.offset <= offset && offset < c.end);
        if (!next) break;
        node = next;
    }
    return elementIdOf(node.astNode);
}

function dedupe(items: Diagnostic[]): Diagnostic[] {
    const seen = new Set<string>();
    return items.filter((d) => {
        const key = `${d.file}:${d.start.line}:${d.start.column}:${d.code}:${d.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
