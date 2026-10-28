import { GitCompare } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { GitRefs } from '../src/server/git';
import type { Baseline, BaselineSpec } from '../src/server/protocol';
import { useT } from './i18n';

/** How the baseline is named in the header: the previous save, or the ref with its commit. */
export function baselineName(b: Baseline, previous: string): string {
    if (b.kind === 'previous') return previous;
    return b.commit && !/^[0-9a-f]{7,40}$/i.test(b.ref) ? `${b.ref} (${b.commit.hash.slice(0, 7)})` : b.ref;
}

/**
 * The header's button showing what the model is compared with; it opens the menu choosing it (`BaselineMenu`), which
 * the heading of the changes opens too.
 */
export function BaselineButton({ baseline, open, onToggle }: { baseline: Baseline; open: boolean; onToggle: (anchor: HTMLElement) => void }) {
    const t = useT();
    return (
        <button
            className={`baseline-button${baseline.kind === 'git' ? ' baseline-git' : ''}${baseline.kind === 'git' && baseline.error ? ' baseline-broken' : ''}`}
            aria-haspopup="listbox"
            aria-expanded={open}
            data-tooltip={t.baselineHint}
            onClick={(e) => onToggle(e.currentTarget)}
        >
            <GitCompare size={14} aria-hidden />
            <span className="baseline-summary">
                {t.baseline}: {baselineName(baseline, t.baselinePrevious)}
            </span>
            <span aria-hidden>▾</span>
        </button>
    );
}

/** Room left between the menu and the window's edges. */
const MENU_MARGIN = 8;
/** How long the menu waits for the revisions before it opens without them (as 読み込み中…), so as not to grow once open. */
const REFS_WAIT_MS = 250;

/**
 * Where the menu goes next to the button that opened it: below it in the upper half of the window, above it in the
 * lower half (the heading of the changes, in the bottom pane), aligned with its nearer side. Fixed, so that no pane
 * clips it.
 */
export function menuPlacement(anchor: DOMRect, viewport: { width: number; height: number }): { below: boolean; style: CSSProperties } {
    const below = anchor.top + anchor.height / 2 < viewport.height / 2;
    const left = anchor.left + anchor.width / 2 < viewport.width / 2;
    const style = {
        ...(below
            ? { top: anchor.bottom + 4, maxHeight: viewport.height - anchor.bottom - 4 - MENU_MARGIN }
            : { bottom: viewport.height - anchor.top + 4, maxHeight: anchor.top - 4 - MENU_MARGIN }),
        ...(left ? { left: Math.max(MENU_MARGIN, anchor.left) } : { right: Math.max(MENU_MARGIN, viewport.width - anchor.right) }),
    };
    return { below, style };
}

/**
 * The menu choosing what the model is compared with: the previous save, or a git revision (a branch, a tag, one of the
 * latest commits, or any ref typed in), next to `anchor`, the button that opened it. The choice is the server's, so it
 * applies to every open page. It closes on Escape, on a choice, and on a click outside it and its button (which
 * toggles it).
 */
export function BaselineMenu({ baseline, anchor, onClose }: { baseline: Baseline; anchor: HTMLElement; onClose: () => void }) {
    const t = useT();
    const [refs, setRefs] = useState<GitRefs | null>(null);
    const [typed, setTyped] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [waited, setWaited] = useState(false);
    const root = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            const inside = (el: Node | null) => !!el && e.target instanceof Node && el.contains(e.target);
            if (!inside(root.current) && !inside(anchor)) onClose();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [anchor, onClose]);

    // the branches and commits change while the page is open: list them each time it opens
    useEffect(() => {
        let cancelled = false;
        const timer = setTimeout(() => setWaited(true), REFS_WAIT_MS);
        fetch('/api/git/refs')
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the response of our own server's api/git/refs
            .then((r) => (r.ok ? (r.json() as Promise<GitRefs>) : null))
            .then((r) => !cancelled && setRefs(r ?? { branches: [], tags: [], commits: [] }))
            .catch(() => !cancelled && setRefs({ branches: [], tags: [], commits: [] }));
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, []);

    const choose = async (spec: BaselineSpec) => {
        const r = await fetch('/api/baseline', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) });
        if (r.ok) onClose();
        else setError(await r.text());
    };
    const isRef = (ref: string) => baseline.kind === 'git' && baseline.ref === ref;
    const empty = refs && !refs.branches.length && !refs.tags.length && !refs.commits.length;
    // opened once the revisions are listed (or after a while), so that it does not grow once open
    if (!refs && !waited) return null;
    const { below, style } = menuPlacement(anchor.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });

    return (
        <div className={`baseline-menu ${below ? 'baseline-menu-below' : 'baseline-menu-above'}`} role="listbox" ref={root} style={style}>
            <button role="option" aria-selected={baseline.kind === 'previous'} className="baseline-option" onClick={() => choose({ kind: 'previous' })}>
                <strong>{t.baselinePrevious}</strong>
                <span className="muted small">{t.baselinePreviousHint}</span>
            </button>
            <form
                className="baseline-ref"
                onSubmit={(e) => {
                    e.preventDefault();
                    if (typed.trim()) void choose({ kind: 'git', ref: typed.trim() });
                }}
            >
                <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t.baselineRef} aria-label={t.baselineRef} autoFocus />
                <button type="submit" disabled={!typed.trim()}>
                    {t.compare}
                </button>
            </form>
            {error && <div className="baseline-error">{error}</div>}
            {!refs && <div className="muted small">{t.loadingRefs}</div>}
            {empty && <div className="muted small">{t.noGitRefs}</div>}
            {refs && (
                <>
                    <RefGroup title={t.branches} refs={refs.branches} isRef={isRef} onPick={(ref) => choose({ kind: 'git', ref })} />
                    <RefGroup title={t.tags} refs={refs.tags} isRef={isRef} onPick={(ref) => choose({ kind: 'git', ref })} />
                    {refs.commits.length > 0 && (
                        <div className="baseline-group">
                            <div className="baseline-group-title">{t.recentCommits}</div>
                            {refs.commits.map((c) => (
                                <button
                                    key={c.hash}
                                    role="option"
                                    aria-selected={baseline.kind === 'git' && baseline.commit?.hash === c.hash && isRef(c.short)}
                                    className="baseline-option baseline-commit"
                                    title={c.date}
                                    onClick={() => choose({ kind: 'git', ref: c.short })}
                                >
                                    <code>{c.short}</code>
                                    <span className="baseline-subject">{c.subject}</span>
                                </button>
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

function RefGroup({ title, refs, isRef, onPick }: { title: string; refs: string[]; isRef: (ref: string) => boolean; onPick: (ref: string) => void }) {
    if (!refs.length) return null;
    return (
        <div className="baseline-group">
            <div className="baseline-group-title">{title}</div>
            {refs.map((r) => (
                <button key={r} role="option" aria-selected={isRef(r)} className="baseline-option" onClick={() => onPick(r)}>
                    <code>{r}</code>
                </button>
            ))}
        </div>
    );
}
