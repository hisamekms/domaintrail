// The knowledge on the page (ADR 0031, section 10; the maintainer's approved preview): a sticky's items in its detail
// (its conflicts side by side first, each side opening to its detail, then the items kept with the hotspot they were
// handed over to, then the other items newest first or by kind), the ナレッジ list of the left column
// with its search and filters, an item opened to its quotes, the other stickies it concerns, its versions and images,
// with 直す / 画像を付ける / 消す; the deletion's 元に戻す; the dot and the conflict mark on the canvas, the stickies
// an opened item lights up, and the session's extraction switch in the app bar (section 3).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import { Bot, CircleAlert, ImagePlus, Lightbulb, LightbulbOff, PanelLeftClose, Pencil, Search, Trash2 } from 'lucide-react';
import { latestRevision } from '../session/state';
import { sessionApi } from '../session/api';
import { AI_NAME } from '../session/ai';
import { useLang, useT } from '../i18n';
import { Act } from '../shared/act';
import { growMotion, motionEasing, motionMs, useStaying } from '../shared/motion';
import { ReferenceLine, TargetLink } from '../shared/reference';
import { useCanvasValue, type DiagramCanvas } from '../view/diagram';
import { useKnowledgeApi } from './api';
import {
    conflictPairs,
    extractionControl,
    hotspotBody,
    hotspotGroups,
    imagesOf,
    KINDS,
    missingConflicts,
    NO_FILTERS,
    ordered,
    ORIGINS,
    pairKey,
    outsideConflicts,
    plainText,
    queryOf,
    sourcesNewestFirst,
    toggled,
    WHENS,
    selectionOfSticky,
    type ConflictPair,
    type Filters,
    type HotspotGroup,
    type KnowledgeItem,
    type Order,
} from './model';
import { useKnowledgeView, type KnowledgeView } from './useKnowledge';
import type { PastVersion } from '@domaintrail/knowledge';

const failure = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The date an item was made, short (11/5). */
function useShortDate(): (d: Date) => string {
    const lang = useLang();
    return (d) => d.toLocaleDateString(lang === 'ja' ? 'ja-JP' : 'en-US', { month: 'numeric', day: 'numeric' });
}

/** A moment, short with its time (11/5 18:02): a source's tooltip. */
function useShortTime(): (d: Date) => string {
    const lang = useLang();
    return (d) => d.toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 新しい順 / 種類の順: a segmented setting of the list. */
function OrderSwitch({ order, onOrder }: { order: Order; onOrder: (o: Order) => void }): ReactElement {
    const t = useT().knowledge;
    return (
        <span className="knowledge-order" role="radiogroup" aria-label={t.orderLabel}>
            {(['newest', 'kind'] as const).map((o) => (
                <button key={o} type="button" role="radio" aria-checked={order === o} className={order === o ? 'on' : undefined} onClick={() => onOrder(o)}>
                    {t.order[o]}
                </button>
            ))}
        </span>
    );
}

/** The labels of an item on one line: its when (TO-BE stands out), its origin (the AI's quieter), perspective, date. */
function Meta({ item }: { item: KnowledgeItem }): ReactElement {
    const t = useT().knowledge;
    const date = useShortDate();
    const { when, origin, perspective } = item.content.labels;
    const ai = origin === 'investigated' || origin === 'inferred';
    const parts: ReactNode[] = [
        ...(when !== 'none'
            ? [
                  <span key="w" className={when === 'to_be' ? 'knowledge-to-be' : undefined}>
                      {t.whens[when]}
                  </span>,
              ]
            : []),
        <span key="o" className={ai ? 'knowledge-ai' : undefined}>
            {t.origins[origin]}
        </span>,
        ...(perspective ? [<span key="p">{perspective}</span>] : []),
        <span key="d">{date(item.createdAt)}</span>,
    ];
    return (
        <span className="knowledge-meta">
            {parts.flatMap((p, i) =>
                i === 0
                    ? [p]
                    : [
                          <span key={`s${i}`} aria-hidden>
                              {' · '}
                          </span>,
                          p,
                      ],
            )}
        </span>
    );
}

/** 直す: the text and the labels of an item, edited; a new version once saved. */
function CorrectForm({ item, onDone }: { item: KnowledgeItem; onDone: () => void }): ReactElement {
    const t = useT().knowledge;
    const view = useKnowledgeView();
    const api = useKnowledgeApi();
    // edited as plain strings: dt checks them again (the item's text and its labels)
    const [text, setText] = useState<string>(item.content.text);
    const [labels, setLabels] = useState<Readonly<Record<string, string>>>({ ...item.content.labels });
    const [busy, setBusy] = useState(false);
    const save = async (): Promise<void> => {
        setBusy(true);
        try {
            await api.correct(item.id, { ...item.content, text, labels });
            view?.changed();
            onDone();
        } catch (e) {
            view?.setError(failure(e));
        } finally {
            setBusy(false);
        }
    };
    const select = <K extends 'kind' | 'when' | 'origin'>(axis: K, values: readonly string[], names: Readonly<Record<string, string>>): ReactElement => (
        <select aria-label={t.axes[axis]} value={labels[axis] ?? ''} onChange={(e) => setLabels({ ...labels, [axis]: e.target.value })}>
            {values.map((v) => (
                <option key={v} value={v}>
                    {names[v] || '—'}
                </option>
            ))}
        </select>
    );
    return (
        <div className="knowledge-form">
            <textarea aria-label={t.text} value={text} rows={4} onChange={(e) => setText(e.target.value)} />
            <span className="knowledge-form-labels">
                {select('kind', KINDS, t.kinds)}
                {select('when', [...WHENS, 'none'], t.whens)}
                {select('origin', ORIGINS, t.origins)}
            </span>
            <span className="knowledge-actions">
                <Act kind="decide" disabled={busy || text.trim() === ''} onClick={() => void save()}>
                    {t.save}
                </Act>
                <Act kind="stop" onClick={onDone}>
                    {t.cancel}
                </Act>
            </span>
        </div>
    );
}

/** The versions an item replaced, newest first. */
function Versions({ item, history }: { item: KnowledgeItem; history: readonly PastVersion[] }): ReactElement | null {
    const t = useT().knowledge;
    const date = useShortDate();
    if (history.length === 0) return null;
    return (
        <details className="knowledge-versions">
            <summary>
                {t.versions} {t.version(item.version)}
            </summary>
            {history.map((v) => (
                <p key={v.version} className="knowledge-version">
                    <span className="knowledge-meta">
                        {t.version(v.version)} · {date(v.replacedAt)}
                    </span>
                    <span>{plainText(v.content.text)}</span>
                </p>
            ))}
        </details>
    );
}

/** A source as the chat's reference to a message: who said it (this session's) or when (another's), and its quote. */
function SourceLine({ source }: { source: KnowledgeItem['sources'][number] }): ReactElement {
    const view = useKnowledgeView();
    const date = useShortDate();
    const time = useShortTime();
    const said = view?.messageOf?.(source.session, source.message);
    return <ReferenceLine who={said?.who ?? date(source.at)} head={source.quote} tooltip={`${source.quote}\n${time(source.at)}`} onClick={said?.open} />;
}

/** An item opened: its images, sources, the other stickies, its versions, and its actions. */
function ItemDetail({ item, from }: { item: KnowledgeItem; from: string | undefined }): ReactElement {
    const t = useT().knowledge;
    const view = useKnowledgeView();
    const api = useKnowledgeApi();
    const [editing, setEditing] = useState(false);
    const [history, setHistory] = useState<readonly PastVersion[]>([]);
    const file = useRef<HTMLInputElement>(null);
    useEffect(() => {
        let stale = false;
        api.get(item.id).then(
            (got) => !stale && setHistory(got?.history ?? []),
            () => undefined,
        );
        return () => {
            stale = true;
        };
    }, [api, item.id, item.version]);
    const attach = async (f: File | undefined): Promise<void> => {
        if (!f) return;
        try {
            await api.attachImage(item.id, f);
            view?.changed();
        } catch (e) {
            view?.setError(failure(e));
        }
    };
    if (editing) return <CorrectForm item={item} onDone={() => setEditing(false)} />;
    const others = item.content.about.filter((s) => s !== from);
    return (
        <div className="knowledge-detail">
            {imagesOf(item.content.text).map((id) => (
                <img key={id} className="knowledge-image" src={api.imageUrl(id)} alt="" />
            ))}
            {item.sources.length > 0 && (
                <div className="knowledge-sources" role="group" aria-label={t.sources}>
                    {sourcesNewestFirst(item.sources).map((s) => (
                        <SourceLine key={`${s.session}/${s.message}`} source={s} />
                    ))}
                </div>
            )}
            {others.length > 0 && (
                <div className="chat-targets" role="group" aria-label={t.about}>
                    {others.map((s) => {
                        const name = view?.label(s) ?? s;
                        return <TargetLink key={s} name={name} tooltip={name} kind="DtesElement" onClick={() => view?.select(s)} />;
                    })}
                </div>
            )}
            <Versions item={item} history={history} />
            <span className="knowledge-actions">
                <Act kind="open" icon={<Pencil size={12} aria-hidden />} onClick={() => setEditing(true)}>
                    {t.correct}
                </Act>
                <Act kind="open" icon={<ImagePlus size={12} aria-hidden />} onClick={() => file.current?.click()}>
                    {t.attachImage}
                </Act>
                <Act kind="decide-sub" icon={<Trash2 size={12} aria-hidden />} onClick={() => void view?.remove(item.id)}>
                    {t.delete}
                </Act>
                <input
                    ref={file}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    hidden
                    onChange={(e) => {
                        void attach(e.target.files?.[0]);
                        e.target.value = '';
                    }}
                />
            </span>
        </div>
    );
}

/**
 * An opened part's detail unfolding (`--motion-medium`, like the tree's branches): its height from nothing to its own
 * (a grid row from 0fr to 1fr, which height cannot do to auto) as it fades in, and back as it closes; mounted while it
 * closes (`useStaying`). Once opened, it is brought into view where it is cut off, as a list does with its selection.
 */
function Unfold({ open, children }: { open: boolean; children: ReactNode }): ReactElement {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const ms = motionMs('--motion-medium');
        const timer = setTimeout(() => {
            ref.current?.scrollIntoView({ block: 'nearest', behavior: ms > 0 ? 'smooth' : 'auto' });
        }, ms);
        return () => clearTimeout(timer);
    }, [open]);
    return (
        <div ref={ref} className={`knowledge-unfold${open ? ' open' : ''}`} inert={!open}>
            <div className="knowledge-unfold-inner">{children}</div>
        </div>
    );
}

/**
 * The text's clamp (two lines while closed) released and applied as its height moves (`--motion-medium`), not at once:
 * the text is whole while the item is open and while it closes (`.unfolded`), and clamped once it closed. Each change
 * measures the text whole and clamped, and moves from where it is to the other; nothing moves with "reduce motion".
 */
function useClampMotion(ref: RefObject<HTMLElement | null>, open: boolean, shown: boolean): void {
    const phase = open ? 'open' : shown ? 'closing' : 'closed';
    const first = useRef(true);
    // the height it had when a move was cut short (opened again while it closed): the next one starts there
    const cut = useRef<number | undefined>(undefined);
    useLayoutEffect(() => {
        if (first.current) {
            first.current = false;
            return;
        }
        const el = ref.current;
        if (!el || phase === 'closed' || typeof el.animate !== 'function') return;
        const whole = el.getBoundingClientRect().height;
        el.style.display = '-webkit-box';
        const clamped = el.getBoundingClientRect().height;
        el.style.removeProperty('display');
        const from = cut.current ?? (phase === 'open' ? clamped : whole);
        cut.current = undefined;
        const grow = growMotion(from, phase === 'open' ? whole : clamped, motionMs('--motion-medium'));
        if (!grow) return;
        // closing, it keeps the clamped height until the clamp is applied (the next phase), which ends it
        const animation = el.animate([{ height: `${grow.from}px` }, { height: `${grow.to}px` }], {
            duration: grow.ms,
            easing: motionEasing('--motion-ease-standard'),
            fill: phase === 'closing' ? 'forwards' : 'none',
        });
        return () => {
            cut.current = animation.playState === 'running' ? el.getBoundingClientRect().height : undefined;
            animation.cancel();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [phase]);
}

/** One item of a list: its kind, two lines of its text and its labels; opened, its detail. */
export function ItemRow({
    item,
    from,
    open,
    onToggle,
}: {
    item: KnowledgeItem;
    /** The sticky the list is about (its own link left out); none in the ナレッジ list, which names the stickies. */
    from: string | undefined;
    open: boolean;
    onToggle: () => void;
}): ReactElement {
    const t = useT().knowledge;
    const view = useKnowledgeView();
    const shown = useStaying(open);
    const text = useRef<HTMLSpanElement>(null);
    useClampMotion(text, open, shown);
    return (
        <li className={`knowledge-item${open ? ' open' : ''}${shown ? ' unfolded' : ''}`}>
            <button type="button" className="knowledge-item-head" aria-expanded={open} onClick={onToggle}>
                <span className="knowledge-kind">{t.kinds[item.content.labels.kind]}</span>
                <span className="knowledge-item-main">
                    <span ref={text} className="knowledge-text">
                        {plainText(item.content.text)}
                    </span>
                    <Meta item={item} />
                    {/* the stickies' names fold away as it opens (its detail links them) */}
                    {!from && item.content.about.length > 0 && (
                        <span className={`knowledge-fold${open ? ' shut' : ''}`} aria-hidden={open || undefined}>
                            <span className="knowledge-about">{item.content.about.map((s) => view?.label(s) ?? s).join('、')}</span>
                        </span>
                    )}
                </span>
                {item.conflictsWith.length > 0 && <CircleAlert className="knowledge-conflict-icon" size={14} aria-label={t.conflict} />}
            </button>
            {shown && (
                <Unfold open={open}>
                    <ItemDetail item={item} from={from} />
                </Unfold>
            )}
        </li>
    );
}

/**
 * A conflict: the two items side by side, ホットスポットにする (a message to the AI) and 食い違いではない. Each side
 * opens to its detail under the pair (the sticky's list does not repeat them). Once ホットスポットにする is pressed (here
 * or on another page), the box shows that the hotspot is being made, without its buttons, until the run ends: handed
 * over, the conflict goes; otherwise its buttons come back, with why (no hotspot found, several candidates, the
 * message ended) until it is pressed again (ADR 0031, section 4).
 */
export function ConflictBox({
    pair,
    from,
    isOpen,
    onToggle,
}: {
    pair: ConflictPair;
    /** The sticky whose detail shows the box. */
    from: string | undefined;
    isOpen: (id: string) => boolean;
    onToggle: (item: KnowledgeItem) => void;
}): ReactElement {
    const t = useT().knowledge;
    const view = useKnowledgeView();
    const api = useKnowledgeApi();
    // pressed here, until dt's list of the conflicts being made hotspots has it (or the press failed)
    const [pressed, setPressed] = useState(false);
    const making = pressed || (view?.makingHotspots?.has(pairKey(pair.a.id, pair.b.id)) ?? false);
    const cleared = view?.clearedHotspots?.get(pairKey(pair.a.id, pair.b.id));
    useEffect(() => {
        if (pressed && view?.makingHotspots?.has(pairKey(pair.a.id, pair.b.id))) setPressed(false);
    }, [pressed, view?.makingHotspots, pair.a.id, pair.b.id]);
    const hotspot = async (): Promise<void> => {
        setPressed(true);
        try {
            const revision = latestRevision(await sessionApi.state());
            if (!revision) return setPressed(false);
            const sent = await sessionApi.sendRequest(
                hotspotBody({ pair, label: (s) => view?.label(s) ?? s, revision: revision.id, aiName: AI_NAME, text: t.hotspotText }),
            );
            await api.pressHotspot?.(sent.request.id, [pair.a.id, pair.b.id]);
            view?.changed();
        } catch (e) {
            setPressed(false);
            view?.setError(failure(e));
        }
    };
    const unlink = async (): Promise<void> => {
        try {
            await api.unlink(pair.a.id, pair.b.id);
            view?.changed();
        } catch (e) {
            view?.setError(failure(e));
        }
    };
    return (
        <div className="knowledge-conflict" role="group" aria-label={t.conflict}>
            <SideBySide items={[pair.a, pair.b]} from={from} isOpen={isOpen} onToggle={onToggle} />
            {making ? (
                <span className="knowledge-actions knowledge-making" role="status">
                    <Act kind="send" icon={<Bot size={12} aria-hidden />} disabled>
                        {t.makingHotspot}
                    </Act>
                </span>
            ) : (
                <span className="knowledge-actions">
                    {cleared && (
                        <span className="knowledge-cleared" role="status">
                            {t.hotspotCleared[cleared]}
                        </span>
                    )}
                    {api.hotspots && (
                        <Act kind="send" icon={<Bot size={12} aria-hidden />} onClick={() => void hotspot()}>
                            {t.makeHotspot}
                        </Act>
                    )}
                    <Act kind="decide-sub" onClick={() => void unlink()}>
                        {t.notConflict}
                    </Act>
                </span>
            )}
        </div>
    );
}

/** Items side by side in a box (a conflict's two, a hotspot's), each card opening to its detail under them. */
function SideBySide({
    items,
    from,
    isOpen,
    onToggle,
}: {
    items: readonly KnowledgeItem[];
    from: string | undefined;
    isOpen: (id: string) => boolean;
    onToggle: (item: KnowledgeItem) => void;
}): ReactElement {
    const t = useT().knowledge;
    return (
        <>
            <div className="knowledge-pair">
                {items.map((i) => (
                    <button key={i.id} type="button" className="knowledge-side" aria-expanded={isOpen(i.id)} onClick={() => onToggle(i)}>
                        <span className="knowledge-kind">{t.kinds[i.content.labels.kind]}</span>
                        <span className="knowledge-text">{plainText(i.content.text)}</span>
                        <Meta item={i} />
                    </button>
                ))}
            </div>
            {items.map((i) => (
                <SideDetail key={i.id} item={i} from={from} open={isOpen(i.id)} />
            ))}
        </>
    );
}

/**
 * Items about the sticky and about one hotspot too (a conflict handed over to it, and items about it since): side by
 * side in a calm box, and the hotspot linked instead of buttons (ADR 0031, section 4). Derived from the items' `about`.
 */
export function HotspotBox({
    group,
    from,
    isOpen,
    onToggle,
}: {
    group: HotspotGroup;
    from: string | undefined;
    isOpen: (id: string) => boolean;
    onToggle: (item: KnowledgeItem) => void;
}): ReactElement {
    const t = useT().knowledge;
    const view = useKnowledgeView();
    const name = view?.label(group.hotspot) ?? group.hotspot;
    return (
        <div className="knowledge-hotspot" role="group" aria-label={t.hotspot}>
            <SideBySide items={group.items} from={from} isOpen={isOpen} onToggle={onToggle} />
            <div className="chat-targets">
                <TargetLink name={name} tooltip={name} kind="DtesElement" onClick={() => view?.select(group.hotspot)} />
            </div>
        </div>
    );
}

/** A side of a box opened: its detail in the box, unfolding as it opens and closes. */
function SideDetail({ item, from, open }: { item: KnowledgeItem; from: string | undefined; open: boolean }): ReactElement | null {
    const shown = useStaying(open);
    if (!shown) return null;
    return (
        <Unfold open={open}>
            <ItemDetail item={item} from={from} />
        </Unfold>
    );
}

/** Which items of a list are open; opening one lights its stickies on the canvas. */
function useOpened(
    view: KnowledgeView | undefined,
    items: readonly KnowledgeItem[],
): { isOpen: (id: string) => boolean; toggle: (item: KnowledgeItem) => void } {
    const [opened, setOpened] = useState<string | undefined>();
    const item = items.find((i) => i.id === opened);
    const setLit = view?.setLit;
    const about = item?.content.about.join(',') ?? '';
    useEffect(() => {
        setLit?.(about ? about.split(',') : []);
    }, [about, setLit]);
    useEffect(() => () => setLit?.([]), [setLit]);
    return { isOpen: (id) => id === opened, toggle: (i) => setOpened((o) => (o === i.id ? undefined : i.id)) };
}

/**
 * The items about a sticky (its detail): its conflicts side by side, then the items kept with a hotspot, then the other
 * items, newest first or by kind.
 */
export function StickyKnowledge({ sticky }: { sticky: string }): ReactElement | null {
    const t = useT().knowledge;
    const view = useKnowledgeView();
    const api = useKnowledgeApi();
    const [items, setItems] = useState<readonly KnowledgeItem[] | undefined>();
    const [others, setOthers] = useState<readonly KnowledgeItem[]>([]);
    const [order, setOrder] = useState<Order>('newest');
    const version = view?.version ?? 0;
    useEffect(() => {
        let stale = false;
        void (async () => {
            const about = await api.about(sticky);
            const missing = missingConflicts(about);
            const fetched = (await Promise.all(missing.map((id) => api.get(id)))).flatMap((g) => (g ? [g.item] : []));
            if (stale) return;
            setItems(about);
            setOthers(fetched);
        })().catch(() => !stale && setItems([]));
        return () => {
            stale = true;
        };
    }, [api, sticky, version]);
    const shown = useMemo(() => [...(items ?? []), ...others], [items, others]);
    const opened = useOpened(view, shown);
    if (!view?.available || items === undefined) return null;
    const all = new Map(shown.map((i) => [i.id as string, i]));
    const pairs = conflictPairs(items, (id) => all.get(id));
    // an item in a conflict box is shown there only; the items handed over to a hotspot stay together with its link
    const { groups, rest } = hotspotGroups(outsideConflicts(items, pairs), sticky, view.isHotspot ?? (() => false));
    return (
        <section className="knowledge-sticky" aria-label={t.title}>
            <div className="knowledge-head">
                <span className="knowledge-title">{t.title}</span>
                {rest.length > 1 && <OrderSwitch order={order} onOrder={setOrder} />}
            </div>
            {pairs.map((p) => (
                <ConflictBox key={`${p.a.id}|${p.b.id}`} pair={p} from={sticky} isOpen={opened.isOpen} onToggle={opened.toggle} />
            ))}
            {groups.map((g) => (
                <HotspotBox key={g.hotspot} group={g} from={sticky} isOpen={opened.isOpen} onToggle={opened.toggle} />
            ))}
            {items.length === 0 ? (
                <p className="muted">{t.none}</p>
            ) : (
                rest.length > 0 && (
                    <ul className="knowledge-items">
                        {ordered(rest, order).map((i) => (
                            <ItemRow key={i.id} item={i} from={sticky} open={opened.isOpen(i.id)} onToggle={() => opened.toggle(i)} />
                        ))}
                    </ul>
                )
            )}
        </section>
    );
}

/** A row of filter chips: one axis, each value on or off. */
function ChipRow<V extends string>({
    label,
    values,
    names,
    on,
    onToggle,
}: {
    label: string;
    values: readonly V[];
    names: Readonly<Record<V, string>>;
    on: readonly V[];
    onToggle: (v: V) => void;
}): ReactElement {
    return (
        <span className="knowledge-chips" role="group" aria-label={label}>
            {values.map((v) => (
                <button key={v} type="button" className="knowledge-chip" aria-pressed={on.includes(v)} onClick={() => onToggle(v)}>
                    {names[v]}
                </button>
            ))}
        </span>
    );
}

/** The ナレッジ list of the left column: every item, with search and the filters by when, kind and origin. */
export function KnowledgeList({ onClose, closeLabel }: { onClose: () => void; closeLabel: string }): ReactElement {
    const t = useT().knowledge;
    const view = useKnowledgeView();
    const api = useKnowledgeApi();
    const [filters, setFilters] = useState<Filters>(NO_FILTERS);
    const [order, setOrder] = useState<Order>('newest');
    const [items, setItems] = useState<readonly KnowledgeItem[]>([]);
    const [next, setNext] = useState<string | undefined>();
    const version = view?.version ?? 0;
    const query = queryOf(filters).toString();
    useEffect(() => {
        let stale = false;
        const timer = setTimeout(() => {
            api.search(new URLSearchParams(query)).then(
                (p) => {
                    if (stale) return;
                    setItems(p.items);
                    setNext(p.next);
                },
                () => undefined,
            );
        }, 150);
        return () => {
            stale = true;
            clearTimeout(timer);
        };
    }, [api, query, version]);
    const more = async (): Promise<void> => {
        if (next === undefined) return;
        const p = await api.search(queryOf(filters, next));
        setItems((old) => [...old, ...p.items]);
        setNext(p.next);
    };
    const opened = useOpened(view, items);
    return (
        <div className="list knowledge-list">
            <div className="list-head">
                <span className="list-title">{t.title}</span>
                <OrderSwitch order={order} onOrder={setOrder} />
                <button className="icon-button" onClick={onClose} data-tooltip={closeLabel} aria-label={closeLabel}>
                    <PanelLeftClose size={16} aria-hidden />
                </button>
            </div>
            <div className="list-body knowledge-list-body">
                <label className="knowledge-search">
                    <Search size={14} aria-hidden />
                    <input
                        type="search"
                        placeholder={t.search}
                        aria-label={t.search}
                        value={filters.q}
                        onChange={(e) => setFilters({ ...filters, q: e.target.value })}
                    />
                </label>
                <div className="knowledge-filters">
                    <ChipRow label={t.axes.when} values={WHENS} names={t.whens} on={filters.when} onToggle={(v) => setFilters(toggled(filters, 'when', v))} />
                    <ChipRow label={t.axes.kind} values={KINDS} names={t.kinds} on={filters.kind} onToggle={(v) => setFilters(toggled(filters, 'kind', v))} />
                    <ChipRow
                        label={t.axes.origin}
                        values={ORIGINS}
                        names={t.origins}
                        on={filters.origin}
                        onToggle={(v) => setFilters(toggled(filters, 'origin', v))}
                    />
                </div>
                {items.length === 0 ? (
                    <p className="muted">{t.noMatch}</p>
                ) : (
                    <ul className="knowledge-items">
                        {ordered(items, order).map((i) => (
                            <ItemRow key={i.id} item={i} from={undefined} open={opened.isOpen(i.id)} onToggle={() => opened.toggle(i)} />
                        ))}
                    </ul>
                )}
                {next !== undefined && (
                    <Act kind="open" onClick={() => void more()}>
                        {t.more}
                    </Act>
                )}
            </div>
        </div>
    );
}

/**
 * Whether the session extracts its knowledge (ADR 0031, section 3), in the app bar with the session's other controls
 * of the whole page, where everyone sees it whatever is open: the facilitator's switch (💡 pressed while on); the
 * others' 💡 while their talk is being turned into knowledge, nothing while it is off. Nothing without a store.
 */
export function ExtractionSwitch({ facilitator, live }: { facilitator: boolean; live: boolean }): ReactElement | null {
    const t = useT().knowledge;
    const view = useKnowledgeView();
    const [busy, setBusy] = useState(false);
    const enabled = view?.extraction;
    const control = extractionControl({ enabled, facilitator, live });
    if (!view || control === 'none') return null;
    if (control === 'on')
        return (
            <span className="knowledge-extraction" role="img" aria-label={t.extracting} data-tooltip={t.extracting}>
                <Lightbulb size={15} aria-hidden />
            </span>
        );
    const toggle = async (): Promise<void> => {
        setBusy(true);
        await view.setExtraction(!enabled);
        setBusy(false);
    };
    return (
        <button
            type="button"
            className="icon-button knowledge-extraction"
            aria-pressed={enabled === true}
            aria-label={t.extraction}
            data-tooltip={enabled ? t.stopExtracting : t.startExtracting}
            disabled={busy}
            onClick={() => void toggle()}
        >
            {enabled ? <Lightbulb size={15} aria-hidden /> : <LightbulbOff size={15} aria-hidden />}
        </button>
    );
}

/** 消しました / 元に戻す, for 10 seconds after a deletion; and a failure, once. */
export function KnowledgeNotice(): ReactElement | null {
    const t = useT().knowledge;
    const view = useKnowledgeView();
    const error = view?.error;
    const setError = view?.setError;
    useEffect(() => {
        if (!error) return;
        const timer = setTimeout(() => setError?.(undefined), 6000);
        return () => clearTimeout(timer);
    }, [error, setError]);
    if (!view) return null;
    if (view.undoable)
        return (
            <div className="knowledge-notice" role="status">
                <span>{t.deleted}</span>
                <Act kind="decide-sub" onClick={() => void view.undo()}>
                    {t.undo}
                </Act>
            </div>
        );
    if (error)
        return (
            <div className="knowledge-notice knowledge-notice-error" role="alert">
                {t.failed(error)}
            </div>
        );
    return null;
}

/** The room between a lit sticky and its ring, and the sizes of the dot and the mark (styles.css), centred on the corner. */
const RING = 4;
const MARK = { dot: 10, conflict: 18 } as const;

/** The dot of a sticky with knowledge, the mark of one with a conflict, and the ring of the stickies an opened item is about. */
export function KnowledgeMarks({ canvas }: { canvas: DiagramCanvas | null }): ReactElement | null {
    const t = useT().knowledge;
    const view = useKnowledgeView();
    const marks = view?.marks;
    const lit = view?.lit ?? [];
    const litKey = lit.join(',');
    const placed = useCanvasValue(
        canvas,
        (c) => {
            if (!c || !marks || c.isMoving()) return undefined;
            const { w, h } = c.viewportScreenBounds();
            const z = c.getZoom();
            const inView = (x: number, y: number): boolean => x > -40 && y > -40 && x < w + 40 && y < h + 40;
            const dots: { key: string; x: number; y: number; conflict: boolean }[] = [];
            for (const [element, mark] of marks)
                for (const id of c.elementNodes(element)) {
                    const b = c.itemBounds(id);
                    if (!b) continue;
                    const p = c.pageToViewport({ x: b.x + b.w, y: b.y });
                    if (inView(p.x, p.y)) dots.push({ key: id, x: p.x - MARK[mark] / 2, y: p.y - MARK[mark] / 2, conflict: mark === 'conflict' });
                }
            const rings: { key: string; x: number; y: number; w: number; h: number }[] = [];
            for (const sticky of litKey ? litKey.split(',') : [])
                for (const id of c.elementNodes(selectionOfSticky(sticky))) {
                    const b = c.itemBounds(id);
                    if (!b) continue;
                    const p = c.pageToViewport({ x: b.x, y: b.y });
                    rings.push({ key: id, x: p.x - RING, y: p.y - RING, w: b.w * z + 2 * RING, h: b.h * z + 2 * RING });
                }
            return { dots, rings };
        },
        [marks, litKey],
    );
    if (!view?.available || !placed) return null;
    return (
        <div className="knowledge-marks">
            {placed.rings.map((r) => (
                <span
                    key={`r${r.key}`}
                    className="knowledge-ring"
                    style={{ transform: `translate(${r.x}px, ${r.y}px)`, width: r.w, height: r.h }}
                    aria-hidden
                />
            ))}
            {placed.dots.map((d) => (
                <span
                    key={d.key}
                    className={d.conflict ? 'knowledge-mark-conflict' : 'knowledge-dot'}
                    style={{ transform: `translate(${d.x}px, ${d.y}px)` }}
                    role="img"
                    aria-label={d.conflict ? t.hasConflict : t.hasKnowledge}
                    data-tooltip={d.conflict ? t.hasConflict : t.hasKnowledge}
                >
                    {d.conflict ? '!' : null}
                </span>
            ))}
        </div>
    );
}
