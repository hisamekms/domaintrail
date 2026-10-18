import { ChevronRight, Database, Diff, Folder, FolderOpen, PanelLeftClose, Search, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Diagnostic } from '../src/core/diagnostics';
import type { ModelDiff } from '../src/graph/diff';
import type { DisplayMode } from '../src/graph/ir';
import type { DomainModel, ElementModel } from '../src/model/model';
import { buildFileTree, filesIn, type FileTreeNode } from './file-tree';
import { usePersistentState } from './layout';
import { useT } from './i18n';
import { KIND_ORDER, fileSelection, nameIn, orderedContexts, type Select } from './model-utils';
import { ownerElement } from './render';

export interface ExplorerProps {
    model: DomainModel | null;
    files: string[];
    diagnostics: Diagnostic[];
    diff: ModelDiff;
    mode: DisplayMode;
    /** The selected item or file (see `fileSelection`). */
    selected: string | undefined;
    onSelect: Select;
    /** Double-click: show the item in the view that suits it best. */
    onOpen: (id: string) => void;
    onClose: () => void;
}

type Mark = { severity?: 'error' | 'warning'; change?: 'added' | 'changed' };

/** How a row is drawn: its toggle (if it has children), and whether all its ancestors are open. */
interface RowState {
    depth: number;
    /** All ancestors are open, so the row can be scrolled to. */
    visible: boolean;
    open?: boolean;
    onToggle?: () => void;
}

/**
 * Left pane: model tree (shared contexts first) and the .dt files as a directory tree.
 * The filter keeps the matching rows and their ancestors, all expanded; what is collapsed is left as it was.
 */
export function Explorer(props: ExplorerProps) {
    const t = useT();
    // Collapsed nodes are remembered; everything is expanded except aggregate children by default.
    const [collapsed, setCollapsed] = usePersistentState<string[]>('domaintrail.explorer.collapsed', []);
    const [expanded, setExpanded] = usePersistentState<string[]>('domaintrail.explorer.expanded', []);
    // the two sections (model, files) open and close as a whole; both open by default
    const [sections, setSections] = usePersistentState('domaintrail.explorer.sections', { model: true, files: true });
    // the filter is not remembered, so that a reload never hides items without saying so
    const [query, setQuery] = useState('');
    const [onlyProblems, setOnlyProblems] = useState(false);
    const [onlyChanged, setOnlyChanged] = useState(false);
    const q = query.trim().toLowerCase();
    const filtering = q !== '' || onlyProblems || onlyChanged;

    const isOpen = (key: string, byDefault: boolean) => filtering || (byDefault ? !collapsed.includes(key) : expanded.includes(key));
    const toggle = (key: string, byDefault: boolean) => {
        if (filtering) return;
        if (byDefault) setCollapsed(collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key]);
        else setExpanded(expanded.includes(key) ? expanded.filter((k) => k !== key) : [...expanded, key]);
    };

    const model = props.model;
    const marks = new Map<string, Mark>();
    const mark = (id: string, m: Mark) => marks.set(id, { ...marks.get(id), ...m });
    for (const d of props.diagnostics) {
        if (!d.elementId) continue;
        for (const id of new Set([d.elementId, ownerElement(d.elementId)])) {
            if (marks.get(id)?.severity !== 'error') mark(id, { severity: d.severity });
        }
    }
    for (const id of props.diff.added) mark(id, { change: 'added' });
    for (const id of props.diff.changed) mark(id, { change: 'changed' });

    // a file is changed when an item declared in it was added or changed
    const changedFiles = new Set<string>();
    for (const id of [...props.diff.added, ...props.diff.changed]) {
        const file = model?.elements[ownerElement(id)]?.location.file;
        if (file) changedFiles.add(file);
    }
    const fileCounts = (files: string[]) => {
        const ds = props.diagnostics.filter((d) => files.includes(d.file));
        return { errors: ds.filter((d) => d.severity === 'error').length, warnings: ds.filter((d) => d.severity === 'warning').length };
    };

    const textHit = (...texts: (string | undefined)[]) => q === '' || texts.some((s) => s?.toLowerCase().includes(q));
    const flagsHit = (m: Mark | undefined) => (!onlyProblems || !!m?.severity) && (!onlyChanged || !!m?.change);

    const selectedRef = useRef<HTMLDivElement | null>(null);
    // braces: scrollIntoView returns a Promise in recent browsers, and an effect must not return anything but a cleanup
    useEffect(() => {
        selectedRef.current?.scrollIntoView({ block: 'nearest' });
    }, [props.selected]);

    /** A selectable row: a model item or a file. */
    const item = (id: string, text: string, row: RowState, kind: string, badge?: ReactNode) => {
        const m = marks.get(id);
        const selected = props.selected === id;
        return (
            <div
                ref={selected && row.visible ? selectedRef : undefined}
                className={`tree-item${selected ? ' selected' : ''}`}
                style={{ paddingLeft: 8 + row.depth * 14 }}
                onClick={() => props.onSelect(id)}
                onDoubleClick={() => props.onOpen(id)}
                title={id}
                aria-expanded={row.onToggle ? row.open : undefined}
            >
                <Twisty row={row} />
                <span className={`tree-dot dot-${kind}`} />
                <span className="tree-text">{text}</span>
                {badge}
                {m?.change && <span className={`tree-change tree-change-${m.change}`} title={m.change === 'added' ? t.added : t.changed} />}
                {m?.severity && <span className={`tree-diag tree-diag-${m.severity}`}>{m.severity === 'error' ? '✕' : '!'}</span>}
            </div>
        );
    };

    /** A row that only opens and closes: a group of elements or a directory. */
    const group = (children: ReactNode, row: RowState & { open: boolean; onToggle: () => void }, className = 'tree-group') => (
        <div className={className} style={{ paddingLeft: 8 + row.depth * 14 }} onClick={row.onToggle} aria-expanded={row.open}>
            <Twisty row={row} />
            {children}
        </div>
    );

    const counts = (c: { errors: number; warnings: number }) => (
        <>
            {c.errors > 0 && <span className="count count-error">{c.errors}</span>}
            {c.warnings > 0 && <span className="count count-warning">{c.warnings}</span>}
        </>
    );

    // while filtering, each section title counts its matching rows, so that a closed section still tells what it holds
    let modelHits = 0;
    let fileHits = 0;
    const modelTree = model && orderedContexts(model).map((ctx) => contextNode(model, ctx)).filter(Boolean);
    const fileTree = buildFileTree(props.files)
        .map((n) => fileNode(n, 0, true))
        .filter(Boolean);

    return (
        <div className="explorer">
            <div className="explorer-head">
                <div className="explorer-filter">
                    <Search size={14} aria-hidden />
                    <input
                        value={query}
                        placeholder={t.filter}
                        aria-label={t.filter}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Escape') setQuery('');
                        }}
                    />
                    {query && (
                        <button className="icon-button" onClick={() => setQuery('')} data-tooltip={t.clearFilter} aria-label={t.clearFilter}>
                            <X size={14} aria-hidden />
                        </button>
                    )}
                </div>
                <button className="icon-button" aria-pressed={onlyProblems} onClick={() => setOnlyProblems(!onlyProblems)} data-tooltip={t.onlyProblems} aria-label={t.onlyProblems}>
                    <TriangleAlert size={15} aria-hidden />
                </button>
                <button className="icon-button" aria-pressed={onlyChanged} onClick={() => setOnlyChanged(!onlyChanged)} data-tooltip={t.onlyChanged} aria-label={t.onlyChanged}>
                    <Diff size={15} aria-hidden />
                </button>
                <button className="icon-button" onClick={props.onClose} data-tooltip={t.closeExplorer} aria-label={t.closeExplorer}>
                    <PanelLeftClose size={16} aria-hidden />
                </button>
            </div>
            <div className="explorer-body">
                <Section title={t.model} hits={filtering ? modelHits : undefined} open={sections.model} onToggle={() => setSections({ ...sections, model: !sections.model })}>
                    <div className="tree">
                        {!model && <p className="muted small pad">{t.noModel}</p>}
                        {model && filtering && !modelTree?.length && <p className="muted small pad">{t.noMatches}</p>}
                        {modelTree}
                    </div>
                </Section>
                <Section title={t.files} hits={filtering ? fileHits : undefined} open={sections.files} onToggle={() => setSections({ ...sections, files: !sections.files })}>
                    <div className="tree">
                        {filtering && !fileTree.length && <p className="muted small pad">{t.noMatches}</p>}
                        {fileTree}
                    </div>
                </Section>
            </div>
        </div>
    );

    function contextNode(model: DomainModel, ctx: string) {
        const label = model.contextLabels[ctx];
        const ctxText = textHit(ctx, label);
        const els = Object.values(model.elements).filter((e) => e.context === ctx);
        const groups = KIND_ORDER.map((kind) => ({
            kind,
            nodes: els
                .filter((e) => e.kind === kind)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((el) => elementNode(el, ctxText))
                .filter((n) => n !== null),
        })).filter((g) => g.nodes.length);
        const ctxHit = ctxText && flagsHit(marks.get(ctx));
        if (!groups.length && !ctxHit) return null;
        if (ctxHit) modelHits++;

        const shared = model.sharedContexts.includes(ctx);
        const open = isOpen(`ctx:${ctx}`, true);
        return (
            <div key={ctx}>
                {item(ctx, `${nameIn(props.mode, ctx, label)}${shared ? ` · ${t.sharedTag}` : ''}`, { depth: 0, visible: true, open, onToggle: () => toggle(`ctx:${ctx}`, true) }, shared ? 'shared' : 'context')}
                <Collapse open={open}>
                    {groups.map(({ kind, nodes }) => {
                        const key = `grp:${ctx}:${kind}`;
                        const groupOpen = isOpen(key, true);
                        return (
                            <div key={kind}>
                                {group(
                                    <>
                                        {t.kinds[kind]}
                                        <span className="muted"> {nodes.length}</span>
                                    </>,
                                    { depth: 1, visible: open, open: groupOpen, onToggle: () => toggle(key, true) },
                                )}
                                <Collapse open={groupOpen}>{nodes.map((render) => render(open && groupOpen))}</Collapse>
                            </div>
                        );
                    })}
                </Collapse>
            </div>
        );
    }

    /** An element (null when filtered out); aggregates expand to their states and commands. Rendered once its visibility is known. */
    function elementNode(el: ElementModel, ctxText: boolean) {
        const elText = ctxText || textHit(el.name, el.label);
        const childShown = (c: { id: string; name: string; label?: string }) => (elText || textHit(c.name, c.label)) && flagsHit(marks.get(c.id));
        const states = (el.states ?? []).filter(childShown);
        const commands = (el.commands ?? []).filter(childShown);
        const elHit = elText && flagsHit(marks.get(el.id));
        if (!states.length && !commands.length && !elHit) return null;
        modelHits += states.length + commands.length + (elHit ? 1 : 0);

        const hasChildren = !!(el.states?.length || el.commands?.length);
        const key = `agg:${el.id}`;
        const open = isOpen(key, false);
        return (visible: boolean) => (
            <div key={el.id}>
                {item(
                    el.id,
                    nameIn(props.mode, el.name, el.label),
                    { depth: 2, visible, ...(hasChildren && { open, onToggle: () => toggle(key, false) }) },
                    el.kind,
                    el.persistent && (
                        <span className="tree-persistent" title={t.persistentHint}>
                            <Database size={11} />
                        </span>
                    ),
                )}
                {hasChildren && (
                    <Collapse open={open}>
                        {states.map((s) => (
                            <div key={s.id}>{item(s.id, `◇ ${nameIn(props.mode, s.name, s.label)}`, { depth: 3, visible: visible && open }, 'state')}</div>
                        ))}
                        {commands.map((c) => (
                            <div key={c.id}>
                                {item(c.id, `${c.factory ? '＋' : '▶'} ${nameIn(props.mode, c.name, c.label)}`, { depth: 3, visible: visible && open }, 'command')}
                            </div>
                        ))}
                    </Collapse>
                )}
            </div>
        );
    }

    /** A directory or file (null when filtered out); files match the filter text by their whole path. */
    function fileNode(node: FileTreeNode, depth: number, visible: boolean): ReactNode {
        if (node.kind === 'file') {
            const c = fileCounts([node.path]);
            const fileMark: Mark = { severity: c.errors ? 'error' : c.warnings ? 'warning' : undefined, change: changedFiles.has(node.path) ? 'changed' : undefined };
            if (!(textHit(node.path) && flagsHit(fileMark))) return null;
            fileHits++;
            const id = fileSelection(node.path);
            const selected = props.selected === id;
            return (
                <div
                    key={node.path}
                    ref={selected && visible ? selectedRef : undefined}
                    className={`tree-item${selected ? ' selected' : ''}`}
                    style={{ paddingLeft: 8 + depth * 14 }}
                    onClick={() => props.onSelect(id)}
                    title={node.path}
                >
                    <Twisty row={{ depth, visible }} />
                    <span className="tree-text">{node.name}</span>
                    {fileMark.change && <span className="tree-change tree-change-changed" title={t.changed} />}
                    {counts(c)}
                </div>
            );
        }
        const key = `dir:${node.path}`;
        const open = isOpen(key, true);
        const children = node.children.map((c) => fileNode(c, depth + 1, visible && open)).filter(Boolean);
        if (!children.length) return null;
        const FolderIcon = open ? FolderOpen : Folder;
        return (
            <div key={key}>
                {group(
                    <>
                        <FolderIcon size={14} className="tree-folder" aria-hidden />
                        <span className="tree-text" title={node.path}>
                            {node.name}
                        </span>
                        {counts(fileCounts(filesIn(node)))}
                    </>,
                    { depth, visible, open, onToggle: () => toggle(key, true) },
                    'tree-item tree-dir',
                )}
                <Collapse open={open}>{children}</Collapse>
            </div>
        );
    }
}

/** The chevron of a row that opens and closes (an empty slot otherwise, so that names line up). */
function Twisty({ row }: { row: RowState }) {
    if (!row.onToggle) return <span className="tree-twisty" />;
    const onToggle = row.onToggle;
    return (
        <span
            className={`tree-twisty${row.open ? ' open' : ''}`}
            onClick={(e) => {
                e.stopPropagation();
                onToggle();
            }}
        >
            <ChevronRight size={14} aria-hidden />
        </span>
    );
}

/** A titled section of the pane that opens and closes with its title, like a tree row. */
function Section({ title, hits, open, onToggle, children }: { title: string; hits?: number; open: boolean; onToggle: () => void; children: ReactNode }) {
    return (
        <section className="explorer-section">
            <button type="button" className="pane-title explorer-section-title" onClick={onToggle} aria-expanded={open}>
                <span className={`tree-twisty${open ? ' open' : ''}`}>
                    <ChevronRight size={14} aria-hidden />
                </span>
                {title}
                {hits !== undefined && <span className="explorer-section-hits">{hits}</span>}
            </button>
            <Collapse open={open}>{children}</Collapse>
        </section>
    );
}

/** Children that slide open and closed; they stay mounted (inert while closed) so that both ways can be animated. */
function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
    return (
        <div className={`tree-children${open ? ' open' : ''}`} inert={!open}>
            <div className="tree-children-inner">{children}</div>
        </div>
    );
}
