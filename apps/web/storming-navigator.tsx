import { CornerDownRight, PanelLeftClose, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DisplayMode } from '@domaintrail/visualization';
import type { StormingView } from '@domaintrail/visualization/protocol';
import { Collapse, groupCount, indent, Section, Twisty } from './explorer';
import { useT } from './i18n';
import { nameIn } from './model-utils';
import { usePersistentState } from './shared/layout';
import { chooseScope, shownScope, stageChoice, type StormingChoice } from './storming';
import { FoldButton, FoldedLabel, type TreeFold } from './tree-fold';

/**
 * A row of the storming navigator: a storming, one of its stages or one of its timelines. `scope` is the view it
 * opens in its storming (`chooseScope`): '' the integrated canvas, `@<stage ID>` a stage, else the timeline's ID.
 */
export interface NavigatorNode {
    readonly key: string;
    readonly kind: 'storming' | 'stage' | 'timeline';
    readonly stormingId: string;
    readonly scope: string;
    /** Its ID in its storming (the storming's own ID for a storming). */
    readonly id: string;
    readonly name: string;
    /** A timeline that is an `exception` (else a main flow). */
    readonly exception?: boolean;
    readonly children: readonly NavigatorNode[];
}

/**
 * The stormings › their stages › the stages' timelines (main flows and exceptions, as written), and a storming's
 * timelines that are in no stage (all of them, for a storming without stages) right under it, after its stages.
 * `query` keeps the rows whose name or ID holds it, with their ancestors; a row that matches keeps all its children.
 */
export function stormingNavigatorTree(stormings: readonly StormingView[], mode: DisplayMode, query = ''): NavigatorNode[] {
    const q = query.trim().toLowerCase();
    const hit = (id: string, label: string | undefined): boolean => q === '' || id.toLowerCase().includes(q) || !!label?.toLowerCase().includes(q);
    /**
     * The node with its children, or null when it is not kept: `all` keeps it (an ancestor matched); else it is kept
     * when it matches (with all its children) or when some of its children are.
     */
    const keep = (
        node: Omit<NavigatorNode, 'children'>,
        label: string | undefined,
        all: boolean,
        children: (all: boolean) => NavigatorNode[],
    ): NavigatorNode | null => {
        if (all || hit(node.id, label)) return { ...node, children: children(true) };
        const kept = children(false);
        return kept.length ? { ...node, children: kept } : null;
    };
    const present = <T,>(n: T | null): n is T => n !== null;
    return stormings
        .map((s) => {
            const timelines = (stageId: string | undefined, all: boolean): NavigatorNode[] =>
                s.timelines
                    .filter((tl) => tl.stageId === stageId)
                    .map((tl) =>
                        keep(
                            {
                                key: `${s.id}:${tl.id}`,
                                kind: 'timeline',
                                stormingId: s.id,
                                scope: tl.id,
                                id: tl.id,
                                name: nameIn(mode, tl.id, tl.label),
                                ...(tl.exception && { exception: true }),
                            },
                            tl.label,
                            all,
                            () => [],
                        ),
                    )
                    .filter(present);
            const storming = { key: s.id, kind: 'storming' as const, stormingId: s.id, scope: '', id: s.id, name: nameIn(mode, s.id, s.label) };
            return keep(storming, s.label, false, (all) => [
                ...(s.stages ?? [])
                    .map((st) =>
                        keep(
                            {
                                key: `${s.id}@${st.id}`,
                                kind: 'stage',
                                stormingId: s.id,
                                scope: stageChoice(st.id),
                                id: st.id,
                                name: nameIn(mode, st.id, st.label),
                            },
                            st.label,
                            all,
                            (stageAll) => timelines(st.id, stageAll),
                        ),
                    )
                    .filter(present),
                ...timelines(undefined, all),
            ]);
        })
        .filter(present);
}

/** How many rows a tree holds (the section's count while filtering). */
export const navigatorRows = (nodes: readonly NavigatorNode[]): number => nodes.reduce((n, node) => n + 1 + navigatorRows(node.children), 0);

/**
 * The navigator of the event storming world, in place of the model tree: its filter, then the stormings with their
 * stages and timelines. A click on a row shows it (`chooseScope`) — a storming or a stage, as a place with every flow;
 * an exception, as its case at its stage; a main flow alone — and selects it for the detail when it is a declaration.
 * One row is selected, as the view bar shows it (the exception or the main flow chosen, else the place), and the place
 * of a timeline selected is marked faintly.
 */
export function StormingNavigator(props: {
    stormings: readonly StormingView[];
    choice: StormingChoice;
    mode: DisplayMode;
    onChoose: (choice: StormingChoice) => void;
    /** Selects the row's declaration (`es/<storming>` or `es/<storming>/<ID>`) for the detail. */
    onSelect: (id: string) => void;
    onClose: () => void;
    /** The tree's fold over the detail: its button in the head line, which names the selection while folded. */
    fold?: TreeFold;
}) {
    const t = useT();
    // what is collapsed is remembered; everything is open by default. The filter is not, as in the model tree.
    const [collapsed, setCollapsed] = usePersistentState<string[]>('domaintrail.stormingNavigator.collapsed', []);
    const [query, setQuery] = useState('');
    const filtering = query.trim() !== '';
    const tree = stormingNavigatorTree(props.stormings, props.mode, query);
    const shown = shownScope(props.stormings, props.choice);
    const isOpen = (key: string): boolean => filtering || !collapsed.includes(key);
    const toggle = (key: string): void => {
        if (!filtering) setCollapsed(collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key]);
    };

    const selectedRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        selectedRef.current?.scrollIntoView({ block: 'nearest' });
    }, [shown?.stormingId, shown?.scope]);

    const row = (node: NavigatorNode, depth: number, visible: boolean): ReactNode => {
        const selected = shown?.stormingId === node.stormingId && shown.scope === node.scope;
        // the place of the exception or the main flow shown (its stage, or the storming): marked faintly
        const within = !selected && shown?.stormingId === node.stormingId && shown.place === node.scope && node.kind !== 'timeline';
        const open = isOpen(node.key);
        const hasChildren = node.children.length > 0;
        // a stage counts its timelines only while collapsed, when its rows do not tell it, as the model tree's groups do
        const count = node.kind === 'stage' && hasChildren && !open;
        return (
            <div key={node.key}>
                <div
                    ref={selected && visible ? selectedRef : undefined}
                    className={`tree-item storming-nav-${node.kind}${selected ? ' selected' : ''}${within ? ' within' : ''}`}
                    style={indent(depth)}
                    aria-current={selected || undefined}
                    aria-expanded={hasChildren ? open : undefined}
                    title={node.id}
                    onClick={() => {
                        props.onChoose(chooseScope(props.stormings, props.choice, node.stormingId, node.scope));
                        props.onSelect(node.kind === 'storming' ? `es/${node.stormingId}` : `es/${node.stormingId}/${node.id}`);
                    }}
                >
                    <Twisty row={{ depth, visible, ...(hasChildren && { open, onToggle: () => toggle(node.key) }) }} />
                    {node.exception && (
                        <span className="storming-nav-exception" data-tooltip={t.exceptionMark} role="img" aria-label={t.exceptionMark}>
                            <CornerDownRight size={12} aria-hidden />
                        </span>
                    )}
                    <span className="tree-text">
                        {node.name}
                        {count && <span className="muted tree-count"> {groupCount(node.children.length)}</span>}
                    </span>
                </div>
                {hasChildren && <Collapse open={open}>{node.children.map((c) => row(c, depth + 1, visible && open))}</Collapse>}
            </div>
        );
    };

    return (
        <div className="explorer storming-navigator">
            <div className="explorer-head">
                <FoldedLabel fold={props.fold} />
                {!props.fold?.folded && (
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
                )}
                <FoldButton fold={props.fold} />
                <button className="icon-button" onClick={props.onClose} data-tooltip={t.closeExplorer} aria-label={t.closeExplorer}>
                    <PanelLeftClose size={16} aria-hidden />
                </button>
            </div>
            <div className="explorer-body" inert={props.fold?.folded}>
                <Section
                    title={t.stormingsTitle}
                    hits={filtering ? navigatorRows(tree) : undefined}
                    open={isOpen('section')}
                    onToggle={() => toggle('section')}
                >
                    <div className="tree">
                        {props.stormings.length === 0 && <p className="muted small pad">{t.noStormings}</p>}
                        {filtering && props.stormings.length > 0 && tree.length === 0 && <p className="muted small pad">{t.noMatches}</p>}
                        {tree.map((n) => row(n, 0, isOpen('section')))}
                    </div>
                </Section>
            </div>
        </div>
    );
}
