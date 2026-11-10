// The knowledge on the page (ADR 0031, section 10; the maintainer's approved preview): a sticky's items in its detail
// (its conflicts side by side first, each side opening to its detail, then the items kept with the hotspot they were
// handed over to, then the other items newest first or by kind), the ナレッジ list of the left column
// with its search and filters, an item closed to its title and its labels' line, opened to its text (Markdown), its
// labels as the list's chips (a press filters the list by it), its quotes, the other stickies it concerns, its versions
// and images, with 直す / 画像を付ける / 廃止する / 消す; the deletion's and the retirement's 元に戻す; the dot and the conflict
// mark on the canvas, the stickies an opened item lights up, and the session's extraction switch in the app bar
// (section 3). A retired item (廃止, section 12) is hidden from the lists unless 廃止も表示, then faded, with its reason
// and the item that replaced it; the AI's 廃止の候補 head the ナレッジ list, each approved or dismissed by a person.
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import {
    Archive,
    ArchiveRestore,
    Bookmark,
    Bot,
    CircleAlert,
    Expand,
    ImagePlus,
    Lightbulb,
    LightbulbOff,
    PanelLeftClose,
    Pencil,
    Search,
    Trash2,
} from 'lucide-react';
import { latestRevision } from '../session/state';
import { sessionApi } from '../session/api';
import { AI_NAME } from '../session/ai';
import { useLang, useT } from '../i18n';
import { Act } from '../shared/act';
import { motionMs, useStaying } from '../shared/motion';
import { ReferenceLine, TargetLink } from '../shared/reference';
import { useCanvasValue, type DiagramCanvas } from '../view/diagram';
import { useKnowledgeApi } from './api';
import {
    conflictPairs,
    extractionControl,
    hotspotBody,
    hotspotGroups,
    KINDS,
    labelChips,
    missingConflicts,
    NO_FILTERS,
    isRetired,
    ordered,
    onlyLabel,
    ORIGINS,
    RETIREMENT_REASONS,
    pairKey,
    outsideConflicts,
    queryOf,
    sourcesNewestFirst,
    toggled,
    WHENS,
    selectionOfSticky,
    type ConflictPair,
    type Filters,
    type HotspotGroup,
    type KnowledgeItem,
    type LabelChip,
    type Order,
} from './model';
import { KnowledgeMarkdown, KnowledgePlain } from './text';
import { KnowledgeContext, useKnowledgeView, type KnowledgeView } from './useKnowledge';
import type { Knowledge, PastVersion } from '@domaintrail/knowledge';

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

/** The labels of a closed item on one line: its when (TO-BE stands out), its origin (the AI's quieter), perspective, date. */
function Meta({ item }: { item: KnowledgeItem }): ReactElement {
    const t = useT().knowledge;
    const date = useShortDate();
    const { when, origin, perspective } = item.content.labels;
    const ai = origin === 'investigated' || origin === 'inferred';
    const retired = item.retirement;
    const parts: ReactNode[] = [
        ...(retired
            ? [
                  <span key="r" className="knowledge-retired-label">
                      {retired.reason ? `${t.retired}: ${t.reasons[retired.reason]}` : t.retired}
                  </span>,
              ]
            : []),
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

/**
 * The labels of an opened item as the ナレッジ list's filter chips (when, kind, origin, and the perspective it has), and
 * its date: a chip pressed shows the list filtered by that label alone (`onlyLabel`).
 */
function LabelChips({ item }: { item: KnowledgeItem }): ReactElement {
    const t = useT().knowledge;
    const view = useKnowledgeView();
    const date = useShortDate();
    const name = (chip: LabelChip): string =>
        chip.axis === 'perspective'
            ? chip.value
            : chip.axis === 'when'
              ? t.whens[chip.value]
              : chip.axis === 'kind'
                ? t.kinds[chip.value]
                : t.origins[chip.value];
    return (
        <span className="knowledge-chips knowledge-labels" role="group" aria-label={t.labels}>
            {labelChips(item.content.labels).map((chip) => (
                <button
                    key={chip.axis}
                    type="button"
                    className="knowledge-chip"
                    data-tooltip={t.filterBy(t.axes[chip.axis])}
                    onClick={() => view?.filterByLabel(chip)}
                >
                    {name(chip)}
                </button>
            ))}
            <span className="knowledge-meta">{date(item.createdAt)}</span>
        </span>
    );
}

/** The most characters of a title (`ItemTitle`). */
const TITLE_MAX = 40;

/** 直す: the title, the text and the labels of an item, edited; a new version once saved. */
function CorrectForm({ item, onDone }: { item: KnowledgeItem; onDone: () => void }): ReactElement {
    const t = useT().knowledge;
    const view = useKnowledgeView();
    const api = useKnowledgeApi();
    // edited as plain strings: dt checks them again (the item's title, text and labels)
    const [title, setTitle] = useState<string>(item.content.title);
    const [text, setText] = useState<string>(item.content.text);
    const [labels, setLabels] = useState<Readonly<Record<string, string>>>({ ...item.content.labels });
    const [busy, setBusy] = useState(false);
    const save = async (): Promise<void> => {
        setBusy(true);
        try {
            await api.correct(item.id, { ...item.content, title: title.trim(), text, labels });
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
            <input type="text" aria-label={t.itemTitle} value={title} maxLength={TITLE_MAX} onChange={(e) => setTitle(e.target.value)} />
            <textarea aria-label={t.text} value={text} rows={4} onChange={(e) => setText(e.target.value)} />
            <span className="knowledge-form-labels">
                {select('kind', KINDS, t.kinds)}
                {select('when', [...WHENS, 'none'], t.whens)}
                {select('origin', ORIGINS, t.origins)}
            </span>
            <span className="knowledge-actions">
                <Act kind="decide" disabled={busy || title.trim() === '' || text.trim() === ''} onClick={() => void save()}>
                    {t.save}
                </Act>
                <Act kind="stop" onClick={onDone}>
                    {t.cancel}
                </Act>
            </span>
        </div>
    );
}

/** Opens an item of the list it is in (the ナレッジ list); none elsewhere: a link to an item is then its title only. */
const OpenItemContext = createContext<((id: string) => void) | undefined>(undefined);

/** An item named by its ID: its title, opening it in the list when there is one to open it in. */
function ItemLink({ id }: { id: string }): ReactElement | null {
    const api = useKnowledgeApi();
    const open = useContext(OpenItemContext);
    const [title, setTitle] = useState<string | undefined>();
    useEffect(() => {
        let stale = false;
        api.get(id).then(
            (got) => !stale && setTitle(got?.item.content.title),
            () => undefined,
        );
        return () => {
            stale = true;
        };
    }, [api, id]);
    if (title === undefined) return null;
    if (!open) return <span className="knowledge-link">{title}</span>;
    return (
        <button type="button" className="knowledge-link" onClick={() => open(id)}>
            {title}
        </button>
    );
}

/**
 * 廃止する: a reason, or none (each chip pressed again unchooses it), and the newer item for 置き換わった, chosen among
 * the items not retired; retired at once, with 元に戻す for a while.
 */
function RetireForm({ item, onDone }: { item: KnowledgeItem; onDone: () => void }): ReactElement {
    const t = useT().knowledge;
    const view = useKnowledgeView();
    const api = useKnowledgeApi();
    const [reason, setReason] = useState<Knowledge.RetirementReason | undefined>();
    const [replacedBy, setReplacedBy] = useState<string>('');
    const [candidates, setCandidates] = useState<readonly KnowledgeItem[]>([]);
    useEffect(() => {
        if (reason !== 'replaced') return;
        let stale = false;
        api.search(new URLSearchParams({ limit: '200' })).then(
            (p) => !stale && setCandidates(p.items.filter((i) => i.id !== item.id)),
            () => undefined,
        );
        return () => {
            stale = true;
        };
    }, [api, reason, item.id]);
    const retire = async (): Promise<void> => {
        await view?.retire(item.id, { ...(reason && { reason }), ...(reason === 'replaced' && replacedBy && { replacedBy }) });
        onDone();
    };
    return (
        <div className="knowledge-form knowledge-retire">
            <span className="knowledge-chips" role="group" aria-label={t.retire}>
                {RETIREMENT_REASONS.map((r) => (
                    <button
                        key={r}
                        type="button"
                        className="knowledge-chip"
                        aria-pressed={reason === r}
                        onClick={() => setReason((o) => (o === r ? undefined : r))}
                    >
                        {t.reasons[r]}
                    </button>
                ))}
            </span>
            {reason === 'replaced' && (
                <select aria-label={t.replacedBy} value={replacedBy} onChange={(e) => setReplacedBy(e.target.value)}>
                    <option value="">{t.replacedBy}</option>
                    {candidates.map((c) => (
                        <option key={c.id} value={c.id}>
                            {c.content.title}
                        </option>
                    ))}
                </select>
            )}
            <span className="knowledge-actions">
                <Act kind="decide" icon={<Archive size={12} aria-hidden />} onClick={() => void retire()}>
                    {t.retire}
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
                    <span className="knowledge-version-title">{v.content.title}</span>
                    <span>
                        <KnowledgePlain text={v.content.text} />
                    </span>
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

/**
 * An item opened, under its title: its text as Markdown (with its images), its labels as chips, its sources, the other
 * stickies, its versions, and its actions; 直す puts the form in their place.
 */
export function ItemDetail({ item, from }: { item: KnowledgeItem; from: string | undefined }): ReactElement {
    const t = useT().knowledge;
    const view = useKnowledgeView();
    const api = useKnowledgeApi();
    const [editing, setEditing] = useState(false);
    const [retiring, setRetiring] = useState(false);
    const [bookmarkBusy, setBookmarkBusy] = useState(false);
    const [bookmarked, setBookmarked] = useState(item.bookmarked === true);
    useEffect(() => setBookmarked(item.bookmarked === true), [item.bookmarked]);
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
    const setBookmark = async (): Promise<void> => {
        setBookmarkBusy(true);
        try {
            const changed = await api.setBookmark(item.id, !bookmarked);
            setBookmarked(changed.bookmarked === true);
            view?.changed();
        } catch (e) {
            view?.setError(failure(e));
        } finally {
            setBookmarkBusy(false);
        }
    };
    if (editing) return <CorrectForm item={item} onDone={() => setEditing(false)} />;
    const others = item.content.about.filter((s) => s !== from);
    const retired = item.retirement;
    return (
        <div className="knowledge-detail">
            {retired && (
                <div className="knowledge-replaced">
                    <span className="knowledge-retired-label">{retired.reason ? `${t.retired}: ${t.reasons[retired.reason]}` : t.retired}</span>
                    {retired.replacedBy && (
                        <>
                            <span className="knowledge-meta">{t.replacedBy}</span>
                            <ItemLink id={retired.replacedBy} />
                        </>
                    )}
                </div>
            )}
            <div className="knowledge-body markdown">
                <KnowledgeMarkdown text={item.content.text} />
            </div>
            <LabelChips item={item} />
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
            {retiring && <RetireForm item={item} onDone={() => setRetiring(false)} />}
            {!retiring && (
                <span className="knowledge-actions">
                    <Act
                        kind="decide-sub"
                        icon={<Bookmark size={12} fill={bookmarked ? 'currentColor' : 'none'} aria-hidden />}
                        aria-pressed={bookmarked}
                        data-tooltip={t.bookmarkShared}
                        disabled={bookmarkBusy}
                        onClick={() => void setBookmark()}
                    >
                        {bookmarked ? t.removeBookmark : t.addBookmark}
                    </Act>
                    <Act kind="open" icon={<Pencil size={12} aria-hidden />} onClick={() => setEditing(true)}>
                        {t.correct}
                    </Act>
                    <Act kind="open" icon={<ImagePlus size={12} aria-hidden />} onClick={() => file.current?.click()}>
                        {t.attachImage}
                    </Act>
                    {retired ? (
                        <Act kind="decide-sub" icon={<ArchiveRestore size={12} aria-hidden />} onClick={() => void view?.unretire(item.id)}>
                            {t.unretire}
                        </Act>
                    ) : (
                        <Act kind="open" icon={<Archive size={12} aria-hidden />} onClick={() => setRetiring(true)}>
                            {t.retire}
                        </Act>
                    )}
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
            )}
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
 * One item of a list. Its head (the button) holds its kind, its title and the conflict's mark, and stays as it is:
 * closed, its labels' line (and, in the ナレッジ list, the stickies' names) under it; opened, those fold away as its
 * detail unfolds under the head (its text, its label chips, …), both moving their heights at once, so that nothing
 * jumps (`.knowledge-fold`, `Unfold`).
 */
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
    return (
        <li className={`knowledge-item${open ? ' open' : ''}${isRetired(item) ? ' retired' : ''}`}>
            <button type="button" className="knowledge-item-head" aria-expanded={open} onClick={onToggle}>
                <span className="knowledge-kind">{t.kinds[item.content.labels.kind]}</span>
                <span className="knowledge-item-title">{item.content.title}</span>
                {(item.bookmarked || item.conflictsWith.length > 0) && (
                    <span className="knowledge-item-icons">
                        {item.bookmarked && <Bookmark size={14} fill="currentColor" role="img" aria-label={t.bookmark} />}
                        {item.conflictsWith.length > 0 && <CircleAlert className="knowledge-conflict-icon" size={14} role="img" aria-label={t.conflict} />}
                    </span>
                )}
            </button>
            {/* the labels' line is the row's too: a click on it opens the item (the head is the keyboard's target) */}
            <div className={`knowledge-fold${open ? ' shut' : ''}`} aria-hidden={open || undefined} onClick={open ? undefined : onToggle}>
                <div>
                    <div className="knowledge-item-labels">
                        <Meta item={item} />
                        {!from && item.content.about.length > 0 && (
                            <span className="knowledge-about">{item.content.about.map((s) => view?.label(s) ?? s).join('、')}</span>
                        )}
                    </div>
                </div>
            </div>
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

/** Items side by side in a box (a conflict's two, a hotspot's), each card its title and labels, opening to its detail under them. */
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
                        <span className="knowledge-item-title">{i.content.title}</span>
                        {i.bookmarked && <Bookmark size={14} fill="currentColor" role="img" aria-label={t.bookmark} />}
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
    selection?: { readonly id: string | undefined; readonly onChange: (id: string | undefined) => void },
    lightCanvas = true,
): { isOpen: (id: string) => boolean; toggle: (item: KnowledgeItem) => void; open: (id: string) => void } {
    const [local, setLocal] = useState<string | undefined>();
    const opened = selection ? selection.id : local;
    const setOpened = (id: string | undefined): void => (selection ? selection.onChange(id) : setLocal(id));
    const item = items.find((i) => i.id === opened);
    const setLit = view?.setLit;
    const about = item?.content.about.join(',') ?? '';
    useEffect(() => {
        if (lightCanvas) setLit?.(about ? about.split(',') : []);
    }, [about, setLit, lightCanvas]);
    useEffect(
        () => () => {
            if (lightCanvas) setLit?.([]);
        },
        [setLit, lightCanvas],
    );
    return { isOpen: (id) => id === opened, toggle: (i) => setOpened(opened === i.id ? undefined : i.id), open: setOpened };
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
export function KnowledgeList({
    onClose,
    closeLabel,
    onExpand,
    selection,
    sort,
    layout = 'sidebar',
}: {
    onClose: () => void;
    closeLabel: string;
    onExpand?: (button: HTMLButtonElement) => void;
    selection?: { readonly id: string | undefined; readonly onChange: (id: string | undefined) => void };
    sort?: { readonly order: Order; readonly onChange: (order: Order) => void };
    layout?: 'sidebar' | 'workspace';
}): ReactElement {
    const t = useT().knowledge;
    const view = useKnowledgeView();
    const api = useKnowledgeApi();
    // the page's (a label chip of an opened item sets them, wherever it is)
    const [ownFilters, setOwnFilters] = useState<Filters>(NO_FILTERS);
    const filters = view?.filters ?? ownFilters;
    const setFilters = view?.setFilters ?? setOwnFilters;
    const [localOrder, setLocalOrder] = useState<Order>('newest');
    const order = sort?.order ?? localOrder;
    const setOrder = sort?.onChange ?? setLocalOrder;
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
    const opened = useOpened(view, items, selection, layout === 'sidebar');
    /** An item linked from another (its replacement, a proposal's): opened in the list, fetched when it is not listed. */
    const openItem = async (id: string): Promise<void> => {
        if (!items.some((i) => i.id === id)) {
            const got = await api.get(id).catch(() => undefined);
            if (!got) return;
            setItems((old) => (old.some((i) => i.id === id) ? old : [got.item, ...old]));
        }
        if (!opened.isOpen(id)) opened.open(id);
    };
    return (
        <OpenItemContext.Provider value={(id) => void openItem(id)}>
            <div className={`list knowledge-list${layout === 'workspace' ? ' knowledge-workspace-list' : ''}`}>
                <div className="list-head">
                    <span className="list-title">{t.title}</span>
                    {layout === 'workspace' && <OrderSwitch order={order} onOrder={setOrder} />}
                    {onExpand && (
                        <Act
                            kind="open"
                            className="knowledge-expand"
                            onClick={(event) => onExpand(event.currentTarget)}
                            data-tooltip={t.openWorkspace}
                            aria-label={t.openWorkspace}
                            icon={<Expand size={14} aria-hidden />}
                        >
                            <span>{t.openWorkspace}</span>
                        </Act>
                    )}
                    {layout === 'sidebar' && (
                        <button type="button" className="icon-button" onClick={onClose} data-tooltip={closeLabel} aria-label={closeLabel}>
                            <PanelLeftClose size={16} aria-hidden />
                        </button>
                    )}
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
                    {layout === 'sidebar' && (
                        <div className="knowledge-sidebar-order">
                            <OrderSwitch order={order} onOrder={setOrder} />
                        </div>
                    )}
                    <Proposals />
                    <div className="knowledge-filters">
                        <ChipRow
                            label={t.axes.when}
                            values={WHENS}
                            names={t.whens}
                            on={filters.when}
                            onToggle={(v) => setFilters(toggled(filters, 'when', v))}
                        />
                        <ChipRow
                            label={t.axes.kind}
                            values={KINDS}
                            names={t.kinds}
                            on={filters.kind}
                            onToggle={(v) => setFilters(toggled(filters, 'kind', v))}
                        />
                        <ChipRow
                            label={t.axes.origin}
                            values={ORIGINS}
                            names={t.origins}
                            on={filters.origin}
                            onToggle={(v) => setFilters(toggled(filters, 'origin', v))}
                        />
                        {/* the perspective has no fixed values: chosen from an item's chip, shown while it filters */}
                        {filters.perspective !== undefined && (
                            <ChipRow
                                label={t.axes.perspective}
                                values={[filters.perspective]}
                                names={{ [filters.perspective]: filters.perspective }}
                                on={[filters.perspective]}
                                onToggle={() =>
                                    setFilters({
                                        q: filters.q,
                                        when: filters.when,
                                        kind: filters.kind,
                                        origin: filters.origin,
                                        ...(filters.bookmarked && { bookmarked: true }),
                                        ...(filters.retired && { retired: true }),
                                    })
                                }
                            />
                        )}
                        <span className="knowledge-chips">
                            <button
                                type="button"
                                className="knowledge-chip"
                                aria-pressed={filters.bookmarked === true}
                                data-tooltip={t.bookmarkShared}
                                onClick={() => setFilters({ ...filters, bookmarked: !filters.bookmarked })}
                            >
                                {t.showBookmarked}
                            </button>
                            <button
                                type="button"
                                className="knowledge-chip"
                                aria-pressed={filters.retired === true}
                                onClick={() => setFilters({ ...filters, retired: !filters.retired })}
                            >
                                {t.showRetired}
                            </button>
                        </span>
                    </div>
                    {items.length === 0 ? (
                        <p className="muted">{t.noMatch}</p>
                    ) : (
                        <ul className="knowledge-items">
                            {ordered(items, order).map((i) =>
                                layout === 'workspace' ? (
                                    <li key={i.id} className="knowledge-workspace-row">
                                        <button
                                            type="button"
                                            className="knowledge-workspace-row-button"
                                            aria-current={opened.isOpen(i.id) ? 'true' : undefined}
                                            onClick={() => opened.open(i.id)}
                                        >
                                            <span className="knowledge-kind">{t.kinds[i.content.labels.kind]}</span>
                                            <span className="knowledge-item-title">{i.content.title}</span>
                                            {i.bookmarked && <Bookmark size={14} fill="currentColor" aria-label={t.bookmark} />}
                                            {i.conflictsWith.length > 0 && <CircleAlert size={14} aria-label={t.conflict} />}
                                            <span className="knowledge-workspace-row-meta">
                                                <Meta item={i} />
                                            </span>
                                        </button>
                                    </li>
                                ) : (
                                    <ItemRow key={i.id} item={i} from={undefined} open={opened.isOpen(i.id)} onToggle={() => opened.toggle(i)} />
                                ),
                            )}
                        </ul>
                    )}
                    {next !== undefined && (
                        <Act kind="open" onClick={() => void more()}>
                            {t.more}
                        </Act>
                    )}
                </div>
            </div>
        </OpenItemContext.Provider>
    );
}

/** A roomier place to read and manage an item. The canvas and chat stay mounted behind this screen. */
export function KnowledgeWorkspace({
    selected,
    onSelect,
    order,
    onOrder,
    onBack,
    onLeave,
}: {
    selected: string | undefined;
    onSelect: (id: string | undefined) => void;
    order: Order;
    onOrder: (order: Order) => void;
    onBack: () => void;
    onLeave: () => void;
}): ReactElement {
    const t = useT().knowledge;
    const view = useKnowledgeView();
    const api = useKnowledgeApi();
    const [item, setItem] = useState<KnowledgeItem | null | undefined>();
    const [showDetail, setShowDetail] = useState(selected !== undefined);
    const backButton = useRef<HTMLButtonElement>(null);
    const detailPane = useRef<HTMLElement>(null);
    const listPane = useRef<HTMLElement>(null);
    useLayoutEffect(() => {
        backButton.current?.focus();
    }, []);
    const version = view?.version ?? 0;
    useEffect(() => {
        if (!selected) return;
        let stale = false;
        api.get(selected).then(
            (got) => !stale && setItem(got?.item ?? null),
            () => !stale && setItem(null),
        );
        return () => {
            stale = true;
        };
    }, [api, selected, version]);
    const choose = (id: string | undefined): void => {
        const mobile = window.matchMedia('(max-width: 700px)').matches;
        if (mobile && id)
            flushSync(() => {
                onSelect(id);
                setShowDetail(true);
            });
        else onSelect(id);
        if (id) {
            setItem(undefined);
            setShowDetail(true);
            if (mobile) detailPane.current?.focus();
        }
    };
    const contextualView: KnowledgeView | undefined = view && {
        ...view,
        select: (sticky) => {
            onLeave();
            view.select(sticky);
        },
        filterByLabel: (chip) => view.setFilters(onlyLabel(chip)),
        ...(view.messageOf && {
            messageOf: (session: string, message: string) => {
                const source = view.messageOf?.(session, message);
                return (
                    source && {
                        ...source,
                        open: () => {
                            onLeave();
                            source.open();
                        },
                    }
                );
            },
        }),
    };
    return (
        <KnowledgeContext.Provider value={contextualView}>
            <section className="knowledge-workspace" aria-label={t.title} data-mobile-detail={showDetail}>
                <header className="knowledge-workspace-header">
                    <Act kind="see" className="knowledge-workspace-back" ref={backButton} onClick={onBack}>
                        {t.backToCanvas}
                    </Act>
                    <h1>{t.title}</h1>
                </header>
                <div className="knowledge-workspace-columns">
                    <aside className="knowledge-workspace-list-pane" aria-label={t.listLabel} ref={listPane}>
                        <KnowledgeList
                            onClose={onBack}
                            closeLabel={t.backToCanvas}
                            layout="workspace"
                            selection={{ id: selected, onChange: choose }}
                            sort={{ order, onChange: onOrder }}
                        />
                    </aside>
                    <main className="knowledge-workspace-detail-pane" aria-label={t.detailLabel} ref={detailPane} tabIndex={-1}>
                        {showDetail && (
                            <Act
                                kind="see"
                                className="knowledge-workspace-list-back"
                                onClick={() => {
                                    flushSync(() => setShowDetail(false));
                                    listPane.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
                                }}
                            >
                                {t.backToList}
                            </Act>
                        )}
                        {!selected ? (
                            <p className="muted">{t.chooseItem}</p>
                        ) : item === undefined ? (
                            <p className="muted" role="status">
                                {t.loadingItem}
                            </p>
                        ) : item === null ? (
                            <p className="muted" role="status">
                                {t.missingItem}
                            </p>
                        ) : (
                            <OpenItemContext.Provider value={choose}>
                                <article className="knowledge-workspace-detail" key={item.id}>
                                    <div className="knowledge-workspace-detail-heading">
                                        <span className="knowledge-kind">{t.kinds[item.content.labels.kind]}</span>
                                        <h2>{item.content.title}</h2>
                                    </div>
                                    <Meta item={item} />
                                    <ItemDetail item={item} from={undefined} />
                                </article>
                            </OpenItemContext.Provider>
                        )}
                    </main>
                </div>
            </section>
        </KnowledgeContext.Provider>
    );
}

/** The AI's proposals to retire (or unretire) waiting for a person, at the head of the ナレッジ list: 廃止の候補 n. */
function Proposals(): ReactElement | null {
    const t = useT().knowledge;
    const view = useKnowledgeView();
    const proposals = view?.proposals ?? [];
    if (proposals.length === 0) return null;
    return (
        <details className="knowledge-proposals" open>
            <summary>{t.proposalCount(proposals.length)}</summary>
            <ul>
                {proposals.map((p) => (
                    <ProposalCard key={p.id} proposal={p} />
                ))}
            </ul>
        </details>
    );
}

/** One proposal: what it asks of which item, why, on what evidence; 承認 / 却下. */
function ProposalCard({ proposal }: { proposal: Knowledge.OpenRetirementProposal }): ReactElement {
    const t = useT().knowledge;
    const view = useKnowledgeView();
    const date = useShortDate();
    const [busy, setBusy] = useState(false);
    const decide = async (f: ((p: Knowledge.OpenRetirementProposal) => Promise<void>) | undefined): Promise<void> => {
        setBusy(true);
        await f?.(proposal);
        setBusy(false);
    };
    return (
        <li className="knowledge-proposal">
            <span className="knowledge-proposal-head">
                <span className="knowledge-kind">{proposal.action === 'retire' ? t.retire : t.unretire}</span>
                <ItemLink id={proposal.item} />
            </span>
            {proposal.reason && (
                <span className="knowledge-meta">
                    {t.reasons[proposal.reason]}
                    {proposal.replacedBy && ' → '}
                    {proposal.replacedBy && <ItemLink id={proposal.replacedBy} />}
                </span>
            )}
            <span className="knowledge-proposal-why">{proposal.explanation}</span>
            <div className="knowledge-sources" role="group" aria-label={t.evidence}>
                {proposal.evidence.map((e) => {
                    if (e.kind === 'Said') {
                        const said = view?.messageOf?.(e.session, e.message);
                        return (
                            <ReferenceLine
                                key={`s${e.session}/${e.message}`}
                                who={said?.who ?? date(proposal.proposedAt)}
                                head={e.quote}
                                tooltip={e.quote}
                                onClick={said?.open}
                            />
                        );
                    }
                    if (e.kind === 'Decision')
                        return (
                            <span key={`d${e.item}`} className="knowledge-evidence">
                                <span className="knowledge-kind">{t.kinds.decision}</span>
                                <ItemLink id={e.item} />
                            </span>
                        );
                    const name = view?.label(e.sticky) ?? e.sticky;
                    return (
                        <span key={`k${e.sticky}`} className="knowledge-evidence">
                            <TargetLink name={name} tooltip={name} kind="DtesElement" onClick={() => view?.select(e.sticky)} />
                            <span>{e.change}</span>
                        </span>
                    );
                })}
            </div>
            <span className="knowledge-actions">
                <Act kind="decide" disabled={busy} onClick={() => void decide((p) => view?.approve(p) ?? Promise.resolve())}>
                    {t.approve}
                </Act>
                <Act kind="danger" disabled={busy} onClick={() => void decide((p) => view?.dismiss(p) ?? Promise.resolve())}>
                    {t.dismiss}
                </Act>
            </span>
        </li>
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

/** 消しました or 廃止しました / 元に戻す, for 10 seconds after a deletion or a retirement; and a failure, once. */
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
                <span>{view.undoable.what === 'deleted' ? t.deleted : t.retiredDone}</span>
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
