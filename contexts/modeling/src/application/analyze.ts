import * as path from 'node:path';
import { AstUtils, URI, isCompositeCstNode, type AstNode, type LangiumDocument } from 'langium';
import {
    isAggregate,
    isContext,
    isEntity,
    isEnumDecl,
    isErrorDecl,
    isEventDecl,
    isFieldSet,
    isIdType,
    isPolicy,
    isPrimitiveDecl,
    isUnionDecl,
    isValueObject,
    isVerifiedDecl,
    type ContextElement,
    type Model,
    type Policy,
} from '../infrastructure/syntax/generated/ast.js';
import { createDomainServices } from '../infrastructure/syntax/domain-module.js';
import { buildModel } from '../infrastructure/syntax/build.js';
import { buildSourceModel } from '../infrastructure/syntax/build-source.js';
import { elementIdOf } from '../infrastructure/syntax/element-id.js';
import type { DomainModel } from '../domain/model.js';
import type { SourceModel } from '../domain/source-model.js';
import type { ModelingRuleId } from '../domain/rule-ids.js';
import { checkChanges, checkCommands, checkFactoryIds } from '../domain/rules/commands.js';
import { checkEventIds } from '../domain/rules/events.js';
import { checkFieldSets } from '../domain/rules/field-sets.js';
import { checkInvariants } from '../domain/rules/expressions.js';
import { checkLabels } from '../domain/rules/labels.js';
import { checkNames } from '../domain/rules/names.js';
import { checkPayloadNames } from '../domain/rules/payloads.js';
import { checkPolicies } from '../domain/rules/policies.js';
import { checkShared } from '../domain/rules/shared.js';
import { checkStructure } from '../domain/rules/structure.js';
import { checkUnions } from '../domain/rules/unions.js';
import { checkVerified } from '../domain/rules/verified.js';
import { compareDiagnostics, dedupeDiagnostics, type Diagnostic, didYouMean, suggestFrom, type Candidate } from '@domaintrail/kernel';
import type { SourceFile } from '@domaintrail/kernel';
import { DiagnosticSink, type FileResolver } from '../infrastructure/syntax/diagnostic-sink.js';
import { ModelIndex, commandsOf, statesOf } from '../infrastructure/syntax/model-index.js';

/** Modeling's analysis of the `.dt` sources of a workspace: what the project analysis (@domaintrail/analysis) builds on. */
export interface DomainAnalysis {
    /** The `.dt` sources analyzed. */
    files: string[];
    /** The `.dt` documents. */
    documents: LangiumDocument<Model>[];
    index: ModelIndex;
    /** The diagnostics of the `.dt` sources, sorted: syntax, linking and Modeling's rules. */
    diagnostics: Diagnostic[];
    /** True when every `.dt` file parsed without lexer/parser errors. */
    syntaxOk: boolean;
    /** Typed Model; present whenever the `.dt` sources parse (semantic errors are tolerated). */
    model?: DomainModel;
    /**
     * The model as written, with the sites of every declaration, member, expression and reference: what Modeling's
     * rules and the generator's name check read (T10 of docs/plans/0027-boundaries.md moves them onto it). Present
     * whenever the `.dt` sources parse.
     */
    sourceModel?: SourceModel;
    /** The path handed in for a document's URI, for the checks that report on the documents afterwards. */
    resolveFile: FileResolver;
}

/** Maps the property of an unresolved cross-reference to the rule that covers it. */
const LINK_RULES: Record<string, ModelingRuleId> = {
    from: 'M006',
    to: 'M006',
    event: 'M007', // `emits Event`
    errors: 'M007',
    error: 'M007', // `requires … else Error`
    fieldSets: 'M016',
};

/**
 * Parses, links and validates a set of `.dt` sources as one workspace with Modeling's rules. The rules of other
 * modules (Storming's, the generated TypeScript names) are run by the project analysis.
 */
export async function analyzeDomain(sources: readonly SourceFile[]): Promise<DomainAnalysis> {
    const { shared } = createDomainServices();
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
    const index = new ModelIndex(documents.map((d) => d.parseResult.value));
    const diagnostics: Diagnostic[] = [];
    let syntaxOk = true;
    for (const doc of documents) {
        for (const d of doc.diagnostics ?? []) {
            // Langium's diagnostic data (typed `any` by the LSP types)
            const data: { code?: string; property?: string; refText?: string } | undefined = d.data;
            const isLink = data?.code === 'linking-error';
            if (!isLink) syntaxOk = false;
            const property = data?.property ?? '';
            const node = isLink ? nodeAt(doc, d.range.start.line, d.range.start.character) : undefined;
            const policy = node && AstUtils.getContainerOfType(node, isPolicy);
            const link = policy ? policyLink(index, policy, property, data?.refText ?? '') : undefined;
            if (link === null) continue;
            const hint = link ? link.hint : node && linkHint(index, node, property, data?.refText ?? '');
            diagnostics.push({
                file: resolveFile(doc.uri.toString()),
                start: { line: d.range.start.line + 1, column: d.range.start.character + 1 },
                end: { line: d.range.end.line + 1, column: d.range.end.character + 1 },
                severity: d.severity === 2 ? 'warning' : 'error',
                code: link ? 'M023' : isLink ? (LINK_RULES[property] ?? 'M001') : 'SYNTAX',
                message: link
                    ? link.message
                    : isLink
                      ? linkMessage(property, data?.refText ?? '')
                      : typeof d.message === 'string'
                        ? d.message
                        : d.message.value,
                ...(hint ? { hint } : {}),
                elementId: node && elementIdOf(node),
            });
        }
    }

    if (syntaxOk) {
        const sink = new DiagnosticSink(resolveFile);
        checkNames(index, sink);
        checkShared(index, sink);
        checkStructure(index, sink);
        checkUnions(index, sink);
        checkFieldSets(index, sink);
        checkVerified(index, sink);
        checkCommands(index, sink);
        checkFactoryIds(index, sink);
        checkChanges(index, sink);
        checkEventIds(index, sink);
        checkPayloadNames(index, sink);
        checkPolicies(index, sink);
        checkInvariants(index, sink);
        checkLabels(index, sink);
        diagnostics.push(...sink.items);
    }

    const model = syntaxOk ? buildModel(index, resolveFile) : undefined;
    const sourceModel = syntaxOk ? buildSourceModel(index, resolveFile) : undefined;
    diagnostics.sort(compareDiagnostics);
    return {
        files: sources.map((s) => s.path),
        documents,
        index,
        diagnostics: dedupeDiagnostics(diagnostics),
        syntaxOk,
        model,
        sourceModel,
        resolveFile,
    };
}

const LINK_KINDS: Record<string, string> = {
    from: 'state',
    to: 'state',
    event: 'event',
    errors: 'error',
    error: 'error',
    fieldSets: 'field set',
    target: 'aggregate',
    tagType: 'enum',
    decl: 'type',
};

function linkMessage(property: string, refText: string): string {
    const kind = LINK_KINDS[property] ?? 'element';
    const hint = refText.includes('.') ? '' : kind === 'state' ? ' in this aggregate' : ' in this context (use Context.Name for other contexts)';
    return `Cannot resolve ${kind} '${refText}'${hint}.`;
}

/** What each cross-reference property may point to (states are looked up in the aggregate instead). */
const LINK_TARGETS: Record<string, (el: ContextElement) => boolean> = {
    event: isEventDecl, // `emits Event`
    errors: isErrorDecl,
    error: isErrorDecl,
    fieldSets: isFieldSet,
    target: isAggregate,
    tagType: isEnumDecl,
    decl: (el) =>
        isIdType(el) || isPrimitiveDecl(el) || isVerifiedDecl(el) || isEnumDecl(el) || isValueObject(el) || isUnionDecl(el) || isEntity(el) || isAggregate(el),
};

const PRIMITIVE_TYPES = ['String', 'Int', 'Decimal', 'Bool', 'Timestamp', 'UUID'];

/**
 * The names of the right kind visible where an unresolved reference is: for a simple name the elements of its context,
 * of shared contexts and (qualified) of other contexts; for a qualified name every qualified name.
 */
function linkHint(index: ModelIndex, node: AstNode, property: string, refText: string): string | undefined {
    if (property === 'from' || property === 'to') {
        const agg = AstUtils.getContainerOfType(node, isAggregate);
        return (
            agg &&
            suggestFrom(
                refText,
                statesOf(agg).map((s) => s.name),
                `a state of '${agg.name}'`,
            )
        );
    }
    const accepts = LINK_TARGETS[property];
    if (!accepts) return undefined;
    const ctx = AstUtils.getContainerOfType(node, isContext)?.name ?? '';
    const elements = index.elements.filter(accepts);
    const candidates: Candidate[] = [];
    if (refText.includes('.')) {
        for (const el of elements) candidates.push({ name: `${el.$container.name}.${el.name}` });
    } else {
        if (property === 'decl') candidates.push(...PRIMITIVE_TYPES.map((name) => ({ name })));
        for (const el of elements) {
            const owner = el.$container.name;
            const visible = owner === ctx || index.isShared(owner);
            candidates.push(visible ? { name: el.name } : { name: `${owner}.${el.name}`, key: el.name });
        }
    }
    return didYouMean(refText, candidates);
}

/**
 * M023: the unresolved names of a policy, with what to write instead (`null`: not reported, for the command of an
 * aggregate that is itself unresolved). Its aggregate is one of its own context, so an
 * aggregate of another context means the policy is declared in the wrong context; its command is one of that aggregate.
 */
function policyLink(index: ModelIndex, policy: Policy, property: string, refText: string): { message: string; hint?: string } | null {
    const ctx = policy.$container.name;
    if (property === 'event') {
        return {
            message: `Policy '${policy.name}' reacts to event '${refText}', which does not exist${refText.includes('.') ? '' : ` in context '${ctx}' (use Context.Name for other contexts)`}.`,
            hint: linkHint(index, policy, 'event', refText),
        };
    }
    if (property === 'aggregate') {
        const elsewhere = index.aggregates.filter((a) => a.name === refText && a.$container.name !== ctx);
        if (elsewhere.length) {
            const owner = elsewhere[0].$container.name;
            return {
                message: `Policy '${policy.name}' runs a command of '${owner}.${refText}', but a policy runs a command of its own context '${ctx}'.`,
                hint: `declare the policy in context '${owner}' (the context that reacts), or run a command of an aggregate of '${ctx}'`,
            };
        }
        const local = index.aggregates.filter((a) => a.$container.name === ctx).map((a) => a.name);
        return {
            message: `Policy '${policy.name}' runs a command of aggregate '${refText}', which is not an aggregate of context '${ctx}'.`,
            hint: suggestFrom(refText, local, `an aggregate of '${ctx}'`),
        };
    }
    const agg = policy.aggregate.ref;
    if (!agg) return null; // the aggregate is reported, and the command cannot be looked up
    const commands = agg && isAggregate(agg) ? commandsOf(agg).map((c) => c.name) : [];
    return {
        message: `Policy '${policy.name}' runs '${policy.aggregate.$refText}.${refText}', but '${policy.aggregate.$refText}' has no command '${refText}'.`,
        hint: suggestFrom(refText, commands, `a command of '${policy.aggregate.$refText}'`),
    };
}

function nodeAt(doc: LangiumDocument, line: number, character: number): AstNode | undefined {
    const root = doc.parseResult.value.$cstNode;
    if (!root) return undefined;
    const offset = doc.textDocument.offsetAt({ line, character });
    let node = root;
    for (;;) {
        const children = isCompositeCstNode(node) ? node.content : undefined;
        const next = children?.find((c) => c.offset <= offset && offset < c.end);
        if (!next) break;
        node = next;
    }
    return node.astNode;
}
