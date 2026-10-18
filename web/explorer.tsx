import { PanelLeftClose } from 'lucide-react';
import { Fragment, useEffect, useRef } from 'react';
import type { Diagnostic } from '../src/core/diagnostics';
import type { ModelDiff } from '../src/graph/diff';
import type { DisplayMode } from '../src/graph/ir';
import type { DomainModel, ElementModel } from '../src/model/model';
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

/** Left pane: model tree (shared contexts first) and the .dt files. */
export function Explorer(props: ExplorerProps) {
    const t = useT();
    // Collapsed nodes are remembered; everything is expanded except aggregate children by default.
    const [collapsed, setCollapsed] = usePersistentState<string[]>('domaintrail.explorer.collapsed', []);
    const [expanded, setExpanded] = usePersistentState<string[]>('domaintrail.explorer.expanded', []);
    const isOpen = (key: string, byDefault: boolean) => (byDefault ? !collapsed.includes(key) : expanded.includes(key));
    const toggle = (key: string, byDefault: boolean) => {
        if (byDefault) setCollapsed(collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key]);
        else setExpanded(expanded.includes(key) ? expanded.filter((k) => k !== key) : [...expanded, key]);
    };

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

    const selectedRef = useRef<HTMLDivElement | null>(null);
    // braces: scrollIntoView returns a Promise in recent browsers, and an effect must not return anything but a cleanup
    useEffect(() => {
        selectedRef.current?.scrollIntoView({ block: 'nearest' });
    }, [props.selected]);

    const item = (id: string, text: string, depth: number, extra?: { toggle?: () => void; open?: boolean; kind?: string }) => {
        const m = marks.get(id);
        const selected = props.selected === id;
        return (
            <div
                key={id}
                ref={selected ? selectedRef : undefined}
                className={`tree-item${selected ? ' selected' : ''}`}
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => props.onSelect(id)}
                onDoubleClick={() => props.onOpen(id)}
                title={id}
            >
                <span
                    className="tree-twisty"
                    onClick={(e) => {
                        if (!extra?.toggle) return;
                        e.stopPropagation();
                        extra.toggle();
                    }}
                >
                    {extra?.toggle ? (extra.open ? '▾' : '▸') : ''}
                </span>
                {extra?.kind && <span className={`tree-dot dot-${extra.kind}`} />}
                <span className="tree-text">{text}</span>
                {m?.change && <span className={`tree-change tree-change-${m.change}`} title={m.change === 'added' ? t.added : t.changed} />}
                {m?.severity && <span className={`tree-diag tree-diag-${m.severity}`}>{m.severity === 'error' ? '✕' : '!'}</span>}
            </div>
        );
    };

    const fileCounts = (f: string) => {
        const ds = props.diagnostics.filter((d) => d.file === f);
        return { errors: ds.filter((d) => d.severity === 'error').length, warnings: ds.filter((d) => d.severity === 'warning').length };
    };

    const model = props.model;
    return (
        <div className="explorer">
            <div className="pane-title pane-title-row">
                {t.model}
                <button className="icon-button" onClick={props.onClose} title={t.closeExplorer} aria-label={t.closeExplorer}>
                    <PanelLeftClose size={16} aria-hidden />
                </button>
            </div>
            <div className="tree">
                {!model && <p className="muted small pad">{t.noModel}</p>}
                {model &&
                    orderedContexts(model).map((ctx) => {
                        const ctxOpen = isOpen(`ctx:${ctx}`, true);
                        const els = Object.values(model.elements).filter((e) => e.context === ctx);
                        const shared = model.sharedContexts.includes(ctx);
                        return (
                            <div key={ctx}>
                                {item(ctx, `${nameIn(props.mode, ctx, model.contextLabels[ctx])}${shared ? ` · ${t.sharedTag}` : ''}`, 0, {
                                    toggle: () => toggle(`ctx:${ctx}`, true),
                                    open: ctxOpen,
                                    kind: shared ? 'shared' : 'context',
                                })}
                                {ctxOpen &&
                                    KIND_ORDER.map((kind) => {
                                        const items = els.filter((e) => e.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
                                        if (!items.length) return null;
                                        const key = `grp:${ctx}:${kind}`;
                                        const open = isOpen(key, true);
                                        return (
                                            <div key={kind}>
                                                <div className="tree-group" style={{ paddingLeft: 22 }} onClick={() => toggle(key, true)}>
                                                    <span className="tree-twisty">{open ? '▾' : '▸'}</span>
                                                    {t.kindGroups[kind]}
                                                    <span className="muted"> {items.length}</span>
                                                </div>
                                                {open && items.map(elementNode)}
                                            </div>
                                        );
                                    })}
                            </div>
                        );
                    })}
            </div>
            <div className="pane-title">{t.files}</div>
            <div className="tree">
                {props.files.map((f) => {
                    const c = fileCounts(f);
                    const id = fileSelection(f);
                    const selected = props.selected === id;
                    return (
                        <div
                            key={f}
                            ref={selected ? selectedRef : undefined}
                            className={`tree-item${selected ? ' selected' : ''}`}
                            style={{ paddingLeft: 22 }}
                            onClick={() => props.onSelect(id)}
                        >
                            <span className="tree-text">{f}</span>
                            {c.errors > 0 && <span className="count count-error">{c.errors}</span>}
                            {c.warnings > 0 && <span className="count count-warning">{c.warnings}</span>}
                        </div>
                    );
                })}
            </div>
        </div>
    );

    /** An element; aggregates expand to their states and commands. */
    function elementNode(el: ElementModel) {
        const children = el.kind === 'aggregate' ? [...(el.states ?? []), ...(el.commands ?? [])] : [];
        const key = `agg:${el.id}`;
        const open = isOpen(key, false);
        return (
            <Fragment key={el.id}>
                {item(el.id, nameIn(props.mode, el.name, el.label), 2, children.length ? { toggle: () => toggle(key, false), open, kind: el.kind } : { kind: el.kind })}
                {open && (el.states ?? []).map((s) => item(s.id, `◇ ${nameIn(props.mode, s.name, s.label)}`, 3, { kind: 'state' }))}
                {open && (el.commands ?? []).map((c) => item(c.id, `${c.factory ? '＋' : '▶'} ${nameIn(props.mode, c.name, c.label)}`, 3, { kind: 'command' }))}
            </Fragment>
        );
    }
}
