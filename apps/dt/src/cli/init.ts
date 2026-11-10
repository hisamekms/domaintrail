import { readdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ResolvedConfig } from '../config/config.js';
import type { CliDeps } from './ports.js';

const CONFIG = 'domaintrail.jsonc';
const SOURCES = ['model/**/*.dt', 'stormings/**/*.dtes'];
const SKIP = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', 'generated', 'model', 'stormings', 'knowledge']);

export interface InitPlan {
    version: 1;
    root: string;
    status: 'ready' | 'existing' | 'needs_decision' | 'unsupported';
    evidence: { config?: string; localConfig?: string; sources: string[]; packages: string[]; nestedConfigs: string[] };
    layout: {
        model: string;
        stormings: string;
        knowledge: string;
        generatedTs: string;
        contextOutputs: Record<string, { out: string; module?: string }>;
        /** Globs currently in effect, except for a new single-package project where the proposed config will set them. */
        sources: string[];
        recommendedSources: string[];
    };
    reasons: string[];
    decisions: string[];
    changes: { action: 'create'; path: string; content: string }[];
    next: string[];
    applied: boolean;
}

/** Existing package and DomainTrail boundaries, with no reads under dependencies or generated output. */
async function markers(root: string): Promise<{ packages: string[]; configs: string[] }> {
    const packages: string[] = [];
    const configs: string[] = [];
    const visit = async (dir: string, depth: number): Promise<void> => {
        if (depth > 4) return;
        for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
            const rel = path.join(dir, entry.name);
            if (entry.isFile()) {
                if (entry.name === 'package.json') packages.push(rel);
                if (entry.name === 'domaintrail.jsonc' || entry.name === 'domaintrail.json') configs.push(rel);
            } else if (entry.isDirectory() && !SKIP.has(entry.name)) await visit(rel, depth + 1);
        }
    };
    await visit('', 0);
    return { packages: packages.sort(), configs: configs.sort() };
}

const relative = (root: string, file: string): string => path.relative(root, file).split(path.sep).join('/') || '.';

/** A read-only, deterministic assessment. No layout is inferred from package names alone. */
export async function initPlan(root: string, config: ResolvedConfig, deps: Pick<CliDeps, 'findDomainFiles'>): Promise<InitPlan> {
    const found = await markers(root);
    const existingSources = (await deps.findDomainFiles(root, ['**/*.dt', '**/*.dtes'], true)).sort();
    const nestedConfigs = found.configs.filter((file) => file.includes(path.sep)).map((file) => file.split(path.sep).join('/'));
    const packages = found.packages.filter((file) => file !== 'package.json').map((file) => file.split(path.sep).join('/'));
    const directConfig = config.file && path.dirname(config.file) === root ? relative(root, config.file) : undefined;
    const directLocal = config.localFile && path.dirname(config.localFile) === root ? relative(root, config.localFile) : undefined;
    const hasDirectConfig = Boolean(directConfig || directLocal);
    const inheritedFile = config.file ?? config.localFile;
    const evidence = {
        ...(config.file && { config: relative(root, config.file) }),
        ...(config.localFile && { localConfig: relative(root, config.localFile) }),
        sources: existingSources,
        packages,
        nestedConfigs,
    };
    const layout = {
        model: inheritedFile || existingSources.length ? 'existing paths (see sources and evidence)' : 'model/<context>/*.dt',
        stormings: inheritedFile || existingSources.length ? 'existing paths (see sources and evidence)' : 'stormings/*.dtes',
        knowledge:
            config.knowledge.store === 'files'
                ? 'knowledge/ (files store, created when items exist)'
                : 'cloudflare store (configured; no workspace knowledge/ directory)',
        generatedTs: inheritedFile ? config.tsOut : packages.length > 0 ? 'undecided (choose owning package)' : 'generated/domain',
        contextOutputs: hasDirectConfig
            ? Object.fromEntries(
                  Object.entries(config.tsContexts).map(([name, out]) => [name, { out, ...(config.tsModules[name] && { module: config.tsModules[name] }) }]),
              )
            : {},
        sources: inheritedFile || existingSources.length || packages.length ? config.sources : SOURCES,
        recommendedSources: SOURCES,
    };
    const plan: InitPlan = {
        version: 1,
        root,
        status: 'ready',
        evidence,
        layout,
        reasons: [],
        decisions: [],
        changes: [],
        next: [],
        applied: false,
    };

    if (nestedConfigs.length > 1) {
        plan.status = 'unsupported';
        plan.reasons.push(`Found ${nestedConfigs.length} nested DomainTrail configurations; this root may contain independent products.`);
        plan.decisions.push('Run dt init within each product root. A single configuration for independent products is unsupported.');
    } else if (nestedConfigs.length === 1 && !hasDirectConfig) {
        plan.status = 'needs_decision';
        plan.reasons.push(`Found an existing DomainTrail workspace at ${nestedConfigs[0]}.`);
        plan.decisions.push('Run dt init from that workspace root, or choose a separate root explicitly.');
    } else if (hasDirectConfig) {
        plan.status = 'existing';
        plan.reasons.push(`Existing ${directConfig ?? directLocal} is authoritative; init does not rewrite its sources or generation settings.`);
        if (packages.length > 0)
            plan.decisions.push(
                'Review whether each context is generated in its owning package; the configured default may write to the repository root. See dt guide output-dirs.',
            );
    } else if (inheritedFile) {
        plan.status = 'needs_decision';
        plan.reasons.push(
            `The selected directory inherits ${relative(root, inheritedFile)} from a parent; creating a nested config would change its workspace boundary.`,
        );
        plan.decisions.push('Run dt init at the existing configuration root, or explicitly choose a separate product root.');
    } else if (existingSources.length) {
        plan.status = 'needs_decision';
        plan.reasons.push('Existing .dt or .dtes files define a layout; init will not narrow source globs and hide them.');
        plan.decisions.push('Choose source globs that include the existing files before creating domaintrail.jsonc.');
    } else if (packages.length > 0) {
        plan.status = 'needs_decision';
        plan.reasons.push(`Found ${packages.length} nested packages; package names do not establish which package owns generated TypeScript.`);
        plan.decisions.push('Choose the generated TypeScript owner and per-context module exports before applying a configuration.');
    } else {
        plan.reasons.push('No existing model or configuration was found; the default single-package layout is unambiguous.');
        const content = `${JSON.stringify(
            {
                $schema: './node_modules/domaintrail/schema/domaintrail.schema.json',
                sources: SOURCES,
                generate: { ts: { out: 'generated/domain' } },
                knowledge: { store: 'files' },
            },
            null,
            2,
        )}\n`;
        plan.changes.push({ action: 'create', path: CONFIG, content });
    }
    plan.next =
        plan.status === 'ready'
            ? ['dt guide layout', 'dt init --apply', 'create a .dt model', 'dt check']
            : plan.status === 'existing'
              ? ['dt guide layout', ...(packages.length ? ['dt guide output-dirs'] : []), ...(existingSources.length ? [] : ['create a .dt model']), 'dt check']
              : plan.status === 'unsupported'
                ? ['run dt init from each product root']
                : ['resolve the decisions above', 'dt guide layout', 'dt guide output-dirs', 'dt init'];
    return plan;
}

/** Only the plan's create action is applied. `wx` prevents a race from overwriting another process's config. */
export async function applyInitPlan(plan: InitPlan): Promise<void> {
    if (plan.status !== 'ready') return;
    for (const change of plan.changes) await writeFile(path.join(plan.root, change.path), change.content, { flag: 'wx' });
    plan.applied = plan.changes.length > 0;
    if (plan.applied) plan.next = ['dt guide layout', 'create a .dt model', 'dt check'];
}

export function initPlanText(plan: InitPlan): string {
    const lines = [
        `Workspace: ${plan.root}`,
        `Status: ${plan.status}${plan.applied ? ' (applied)' : ''}`,
        `Sources: ${plan.layout.sources.join(', ')}`,
        ...(plan.layout.sources.join('|') === plan.layout.recommendedSources.join('|')
            ? []
            : [`Recommended for a new workspace: ${plan.layout.recommendedSources.join(', ')}`]),
        `Model: ${plan.layout.model}; stormings: ${plan.layout.stormings}`,
        `Knowledge: ${plan.layout.knowledge}`,
        `Generated TypeScript: ${plan.layout.generatedTs}`,
        ...Object.entries(plan.layout.contextOutputs).map(([name, target]) => `Context ${name}: ${target.out}${target.module ? ` via ${target.module}` : ''}`),
        ...plan.reasons.map((reason) => `Reason: ${reason}`),
        ...plan.decisions.map((decision) => `Decision: ${decision}`),
        ...plan.changes.map((change) => `${plan.applied ? 'Created' : 'Would create'}: ${change.path}`),
        `Next: ${plan.next.join(' → ')}`,
    ];
    return lines.join('\n');
}
