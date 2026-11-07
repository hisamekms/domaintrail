import { CornerDownRight, PanelLeftClose, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DisplayMode } from '@domaintrail/visualization';
import type { StormingView } from '@domaintrail/visualization/protocol';
import { Collapse, groupCount, indent, Section, Twisty } from './explorer';
import { useT } from './i18n';
import { nameIn } from './model-utils';
import { usePersistentState } from './shared/layout';
import { shownFocus, shownStorming, stageChoice, type StormingChoice, type StormingFocus } from './storming';
import { FoldButton, FoldedLabel, type TreeFold } from './tree-fold';

/**
 * A row of the storming navigator: a storming, one of its stages or one of its timelines. `scope` is what a press shows
 * in its storming (`scopeView`): '' the storming, `@<stage ID>` the stage's frame, else the timeline's ID.
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
 * Whether a row is what the canvas shows (ADR 0032 §11): a storming's when it carries all its timelines and nothing is
 * emphasized; a main flow's when its main flow is on the canvas (the trunk's rows of every stage at once); an
 * exception's when it is emphasized. A stage's only just after it was pressed (`pressed`): the canvas is the same.
 */
export function shownRow(
    stormings: readonly StormingView[],
    choice: StormingChoice,
    focus: StormingFocus | null,
    node: Pick<NavigatorNode, 'key' | 'kind' | 'stormingId' | 'id' | 'exception'>,
    pressed: string | undefined,
): boolean {
    const shown = shownStorming(stormings, choice);
    if (!shown || shown.storming.id !== node.stormingId) return false;
    const emphasized = shownFocus(stormings, choice, focus);
    if (node.kind === 'stage') return pressed === node.key;
    if (node.kind === 'storming') return !shown.main && emphasized === undefined && pressed === undefined;
    if (node.exception) return emphasized === node.id;
    return emphasized === undefined && !!shown.main?.timelines.includes(node.id);
}

/**
 * The navigator of the event storming world, in place of the model tree: its filter, then the stormings with their
 * stages and timelines. A press on a row shows it (`scopeView`): a storming with all its timelines, a stage's frame
 * brought into view, a main flow on the canvas, an exception emphasized; and selects it for the detail when it is a
 * declaration. The rows of what the canvas shows are selected (`shownRow`), as the view bar shows it.
 */
export function StormingNavigator(props: {
    stormings: readonly StormingView[];
    choice: StormingChoice;
    /** The exception emphasized. */
    focus: StormingFocus | null;
    mode: DisplayMode;
    /** Shows a row's scope in its storming (`scopeView`). */
    onScope: (stormingId: string, scope: string) => void;
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
    // a stage pressed: its row selected until what the canvas shows changes
    const [pressed, setPressed] = useState<string | undefined>();
    const showing = JSON.stringify([props.choice, props.focus]);
    useEffect(() => setPressed(undefined), [showing]);
    const isShown = (node: NavigatorNode): boolean => shownRow(props.stormings, props.choice, props.focus, node, pressed);
    const isOpen = (key: string): boolean => filtering || !collapsed.includes(key);
    const toggle = (key: string): void => {
        if (!filtering) setCollapsed(collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key]);
    };

    const selectedRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        selectedRef.current?.scrollIntoView({ block: 'nearest' });
    }, [showing, pressed]);

    const row = (node: NavigatorNode, depth: number, visible: boolean): ReactNode => {
        const selected = isShown(node);
        const open = isOpen(node.key);
        const hasChildren = node.children.length > 0;
        // a stage counts its timelines only while collapsed, when its rows do not tell it, as the model tree's groups do
        const count = node.kind === 'stage' && hasChildren && !open;
        return (
            <div key={node.key}>
                <div
                    ref={selected && visible ? selectedRef : undefined}
                    className={`tree-item storming-nav-${node.kind}${selected ? ' selected' : ''}`}
                    style={indent(depth)}
                    aria-current={selected || undefined}
                    aria-expanded={hasChildren ? open : undefined}
                    title={node.id}
                    onClick={() => {
                        props.onScope(node.stormingId, node.scope);
                        setPressed(node.kind === 'stage' ? node.key : undefined);
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
