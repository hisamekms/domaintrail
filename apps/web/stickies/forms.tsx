// The small windows anchored to a sticky (ADR 0033): 編集 (its label, selected, and its name; a new name says how many
// references it rewrites, and a bad or taken one is an error at once), ホットスポットを付ける (the question, and a free name)
// and 解決を書く. Enter saves, Escape cancels; what the server refuses is said in the window, which stays open.
import { useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { localNameProblem, referencesTo, type Storming } from '@domaintrail/storming';
import { LoaderCircle } from 'lucide-react';
import { Act } from '../shared/act';
import { TOOLTIP_ATTR } from '../tooltip';
import { useT } from '../i18n';
import { isMac, type Sticky } from './registry';

/** Where a window is anchored: the sticky's box on the canvas (viewport pixels), and the canvas's size. */
export interface Anchor {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly width: number;
    readonly height: number;
}

/** What a save may answer: nothing (done, the window closes) or what to say in it. */
export type SaveResult = undefined | string;

const WIDTH = 320;
const GAP = 8;

/** A form anchored under the sticky (above it when there is no room below), kept inside the canvas. */
function Popover({
    anchor,
    label,
    onCancel,
    onSubmit,
    children,
}: {
    anchor: Anchor;
    label: string;
    onCancel: () => void;
    onSubmit: () => void;
    children: ReactNode;
}): ReactNode {
    const ref = useRef<HTMLFormElement>(null);
    const [top, setTop] = useState(anchor.y + anchor.h + GAP);
    useLayoutEffect(() => {
        const h = ref.current?.offsetHeight ?? 0;
        const below = anchor.y + anchor.h + GAP;
        setTop(below + h <= anchor.height ? below : Math.max(GAP, anchor.y - h - GAP));
        const first = ref.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
        first?.focus();
        first?.select();
    }, [anchor.y, anchor.h, anchor.height]);
    const left = Math.max(GAP, Math.min(anchor.x, anchor.width - WIDTH - GAP));
    const onKeyDown = (e: KeyboardEvent<HTMLFormElement>): void => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
        }
    };
    return (
        <form
            ref={ref}
            className="sticky-form motion-pop"
            role="dialog"
            aria-label={label}
            style={{ left, top, width: WIDTH }}
            onKeyDown={onKeyDown}
            // the canvas never sees a press in it (no pan, no selection)
            onPointerDown={(e) => e.stopPropagation()}
            onSubmit={(e: FormEvent) => {
                e.preventDefault();
                onSubmit();
            }}
        >
            {children}
        </form>
    );
}

function Field({
    label,
    value,
    onChange,
    mono,
    invalid,
    describedBy,
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    mono?: boolean;
    invalid?: boolean;
    describedBy?: string;
}): ReactNode {
    return (
        <label className="sticky-form-field">
            <span>{label}</span>
            <input
                className={mono ? 'mono' : undefined}
                value={value}
                spellCheck={!mono}
                aria-invalid={invalid === true}
                {...(describedBy !== undefined && { 'aria-describedby': describedBy })}
                onChange={(e) => onChange(e.target.value)}
            />
        </label>
    );
}

/** The window's foot: 取消 and the decision; their keys (Escape, `saveKeys`) are in their tooltips only. */
function Foot({
    save,
    saving,
    disabled,
    onCancel,
    saveKeys = 'Enter',
}: {
    save: string;
    saving: boolean;
    disabled: boolean;
    onCancel: () => void;
    saveKeys?: string;
}): ReactNode {
    const e = useT().stickies.edit;
    return (
        <div className="sticky-form-foot">
            <Act kind="stop" onClick={onCancel} aria-keyshortcuts="Escape" {...{ [TOOLTIP_ATTR]: 'Esc' }}>
                {e.cancel}
            </Act>
            <Act kind="decide" type="submit" disabled={disabled || saving} aria-busy={saving} aria-keyshortcuts={saveKeys} {...{ [TOOLTIP_ATTR]: saveKeys }}>
                {save}
            </Act>
        </div>
    );
}

/** Runs a save; keeps the window open with what it says when it says something. */
function useSave(save: () => Promise<SaveResult>, onDone: () => void): { saving: boolean; error: string | undefined; run: () => void } {
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const run = (): void => {
        if (saving) return;
        setSaving(true);
        setError(undefined);
        save().then(
            (said) => {
                setSaving(false);
                if (said === undefined) onDone();
                else setError(said);
            },
            (e: unknown) => {
                setSaving(false);
                setError(e instanceof Error ? e.message : String(e));
            },
        );
    };
    return { saving, error, run };
}

/** 編集: the label (selected first) and the name, checked as typed; a new name says what it rewrites. */
export function EditForm(props: {
    sticky: Sticky;
    storming: Storming;
    anchor: Anchor;
    onSave: (change: { label?: string; name?: string }) => Promise<SaveResult>;
    onClose: () => void;
}): ReactNode {
    const { sticky, storming } = props;
    const t = useT().stickies;
    const e = t.edit;
    const [label, setLabel] = useState(sticky.label ?? '');
    const [name, setName] = useState(sticky.local);
    const errorId = useId();
    const n = name.trim();
    const l = label.trim();
    const taken = new Set(declarationNames(storming));
    const problem = localNameProblem(n, taken, sticky.local);
    const nameError =
        problem === 'format'
            ? e.problems.format
            : problem === 'keyword'
              ? e.problems.keyword(n)
              : problem === 'duplicate'
                ? e.problems.duplicate(n)
                : undefined;
    const labelError = l.length === 0 && sticky.label !== undefined ? e.emptyLabel : undefined;
    const renamed = n !== sticky.local && !nameError;
    const references = renamed ? referencesTo(storming, sticky.local).length : 0;
    const changed = (l !== (sticky.label ?? '') && l.length > 0) || n !== sticky.local;
    const { saving, error, run } = useSave(
        () => props.onSave({ ...(l !== (sticky.label ?? '') && l.length > 0 && { label: l }), ...(n !== sticky.local && { name: n }) }),
        props.onClose,
    );
    const invalid = nameError !== undefined || labelError !== undefined;
    return (
        <Popover anchor={props.anchor} label={e.dialog} onCancel={props.onClose} onSubmit={() => !invalid && changed && run()}>
            <Field label={e.label} value={label} onChange={setLabel} invalid={labelError !== undefined} describedBy={errorId} />
            <Field label={e.name} value={name} onChange={setName} mono invalid={nameError !== undefined} describedBy={errorId} />
            <div id={errorId} aria-live="polite">
                {renamed && references > 0 && <p className="sticky-form-impact">{e.impact(references, references)}</p>}
                {(nameError ?? labelError ?? error) !== undefined && <p className="sticky-form-error">{nameError ?? labelError ?? error}</p>}
            </div>
            <Foot save={e.save} saving={saving} disabled={invalid || !changed} onCancel={props.onClose} />
        </Popover>
    );
}

/** Every local ID of a storming (one namespace across kinds). */
function* declarationNames(storming: Storming): Iterable<string> {
    for (const el of storming.elements) {
        yield el.id;
        if (el.kind === 'stage') for (const tl of el.timelines) yield* timelineNames(tl);
        if (el.kind === 'timeline') yield* timelineNames(el);
    }
}

function* timelineNames(tl: Extract<Storming['elements'][number], { kind: 'timeline' }>): Iterable<string> {
    yield tl.id;
    for (const s of tl.steps) if (s.type === 'group') yield s.id;
}

/** ホットスポットを付ける: its question, on several lines (Enter a new line, ⌘/Ctrl+Enter saves); its name is the AI's, else dt's. */
export function HotspotForm(props: { anchor: Anchor; onSave: (question: string) => Promise<SaveResult>; onClose: () => void }): ReactNode {
    const t = useT().stickies;
    const [question, setQuestion] = useState('');
    const errorId = useId();
    const { saving, error, run } = useSave(() => props.onSave(question.trim()), props.onClose);
    const ready = question.trim().length > 0;
    const saveKeys = isMac() ? '⌘Enter' : 'Ctrl+Enter';
    return (
        <Popover anchor={props.anchor} label={t.hotspot.dialog} onCancel={props.onClose} onSubmit={() => ready && run()}>
            <label className="sticky-form-field">
                <span>{t.hotspot.label}</span>
                <textarea
                    value={question}
                    rows={3}
                    readOnly={saving}
                    aria-describedby={errorId}
                    aria-keyshortcuts={isMac() ? 'Meta+Enter' : 'Control+Enter'}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key !== 'Enter' || e.nativeEvent.isComposing || !(e.metaKey || e.ctrlKey)) return;
                        e.preventDefault();
                        if (ready) run();
                    }}
                />
            </label>
            <div id={errorId} aria-live="polite">
                {saving && (
                    <p className="sticky-form-busy" role="status">
                        <LoaderCircle size={13} className="spin" aria-hidden />
                        {t.hotspot.naming}
                    </p>
                )}
                {error !== undefined && <p className="sticky-form-error">{error}</p>}
            </div>
            <Foot save={t.hotspot.save} saving={saving} disabled={!ready} onCancel={props.onClose} saveKeys={saveKeys} />
        </Popover>
    );
}

/** 解決を書く: the resolution (what was there, if it was resolved already). */
export function ResolveForm(props: {
    anchor: Anchor;
    resolution?: string;
    onSave: (resolution: string) => Promise<SaveResult>;
    onClose: () => void;
}): ReactNode {
    const t = useT().stickies;
    const [resolution, setResolution] = useState(props.resolution ?? '');
    const errorId = useId();
    const { saving, error, run } = useSave(() => props.onSave(resolution.trim()), props.onClose);
    const ready = resolution.trim().length > 0 && resolution.trim() !== props.resolution;
    return (
        <Popover anchor={props.anchor} label={t.resolve.dialog} onCancel={props.onClose} onSubmit={() => ready && run()}>
            <Field label={t.resolve.label} value={resolution} onChange={setResolution} describedBy={errorId} />
            <div id={errorId} aria-live="polite">
                {error !== undefined && <p className="sticky-form-error">{error}</p>}
            </div>
            <Foot save={t.resolve.save} saving={saving} disabled={!ready} onCancel={props.onClose} />
        </Popover>
    );
}
