// The small windows anchored to a sticky (ADR 0033): 編集 (its label, selected, and its name; a new name says how many
// references it rewrites, and a bad or taken one is an error at once), ホットスポットを付ける (the question, and a free name)
// and 解決を書く. Enter saves, Escape cancels; what the server refuses is said in the window, which stays open.
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { localNameProblem, referencesTo, type Storming } from '@domaintrail/storming';
import { Act } from '../shared/act';
import { TOOLTIP_ATTR } from '../tooltip';
import { useT } from '../i18n';
import { EDIT_FIELDS, isMac, type Sticky, type StickyField, type StickyFieldId } from './registry';

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

/**
 * Whether a press closes a window anchored to a sticky (cancelled, nothing written): one that starts outside it, unless
 * the IME is composing. A drag that starts inside (selecting text) and ends outside starts no press outside.
 */
export function outsidePressCancels(press: { readonly inside: boolean; readonly composing: boolean }): boolean {
    return !press.inside && !press.composing;
}

/** A form anchored under the sticky (above it when there is no room below), kept inside the canvas. */
function Popover({
    anchor,
    label,
    onCancel,
    onSubmit,
    focus,
    children,
}: {
    anchor: Anchor;
    label: string;
    onCancel: () => void;
    onSubmit: () => void;
    /** The field focused first (its `data-field`); else the first. */
    focus?: string;
    children: ReactNode;
}): ReactNode {
    const ref = useRef<HTMLFormElement>(null);
    const [top, setTop] = useState(anchor.y + anchor.h + GAP);
    useLayoutEffect(() => {
        const h = ref.current?.offsetHeight ?? 0;
        const below = anchor.y + anchor.h + GAP;
        setTop(below + h <= anchor.height ? below : Math.max(GAP, anchor.y - h - GAP));
        const first =
            (focus !== undefined ? ref.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-field="${focus}"]`) : null) ??
            ref.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
        first?.focus();
        first?.select();
        // the focus is placed when the window opens only
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [anchor.y, anchor.h, anchor.height]);
    const left = Math.max(GAP, Math.min(anchor.x, anchor.width - WIDTH - GAP));
    // a press outside cancels, as Escape does (a press on another sticky then selects it); never while composing
    const composing = useRef(false);
    useEffect(() => {
        const onDown = (e: PointerEvent): void => {
            const inside = e.target instanceof Node && ref.current !== null && ref.current.contains(e.target);
            if (outsidePressCancels({ inside, composing: composing.current })) onCancel();
        };
        document.addEventListener('pointerdown', onDown, true);
        return () => document.removeEventListener('pointerdown', onDown, true);
    }, [onCancel]);
    const onKeyDown = (e: KeyboardEvent<HTMLFormElement>): void => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
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
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
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
    id,
    label,
    value,
    onChange,
    mono,
    invalid,
    describedBy,
}: {
    id?: string;
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
                {...(id !== undefined && { 'data-field': id })}
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

/** What a person changed in the edit window: only the fields that differ (`resolution: null` clears it). */
export interface EditValues {
    readonly label?: string;
    readonly name?: string;
    readonly question?: string;
    readonly resolution?: string | null;
}

/** The fields' values as a sticky has them now. */
export function fieldValues(sticky: Sticky): Readonly<Record<StickyFieldId, string>> {
    return { label: sticky.label ?? '', name: sticky.local, question: sticky.label ?? '', resolution: sticky.resolution ?? '' };
}

/** The changes of `values` against the sticky, for the fields of its kind (a field emptied that may not be: left out). */
export function editValues(sticky: Sticky, fields: readonly StickyField[], values: Readonly<Record<StickyFieldId, string>>): EditValues {
    const now = fieldValues(sticky);
    const out: { -readonly [K in keyof EditValues]: EditValues[K] } = {};
    for (const { id } of fields) {
        const v = values[id].trim();
        if (v === now[id].trim()) continue;
        if (id === 'resolution') out.resolution = v.length === 0 ? null : v;
        else if (v.length > 0) out[id] = v;
    }
    return out;
}

/**
 * 編集: a window built from the fields the sticky's kind declares (`EDIT_FIELDS`): a label and a name (checked as typed;
 * a new name says what it rewrites), or a hotspot's question and resolution on several lines (Enter a new line,
 * ⌘/Ctrl+Enter saves; a resolution emptied reopens it). `focus`: the field focused first.
 */
export function EditForm(props: {
    sticky: Sticky;
    storming: Storming;
    anchor: Anchor;
    focus?: StickyFieldId;
    onSave: (change: EditValues) => Promise<SaveResult>;
    onClose: () => void;
}): ReactNode {
    const { sticky, storming } = props;
    const t = useT().stickies;
    const e = t.edit;
    const fields = EDIT_FIELDS[sticky.kind];
    const [values, setValues] = useState(() => fieldValues(sticky));
    const set = (id: StickyFieldId) => (v: string) => setValues((old) => ({ ...old, [id]: v }));
    const errorId = useId();
    const has = (id: StickyFieldId): boolean => fields.some((f) => f.id === id);
    const n = values.name.trim();
    const problem = has('name') ? localNameProblem(n, new Set(declarationNames(storming)), sticky.local) : undefined;
    const nameError =
        problem === 'format'
            ? e.problems.format
            : problem === 'keyword'
              ? e.problems.keyword(n)
              : problem === 'duplicate'
                ? e.problems.duplicate(n)
                : undefined;
    const emptied = (id: 'label' | 'question'): boolean => has(id) && values[id].trim().length === 0 && sticky.label !== undefined;
    const textError = emptied('label') ? e.emptyLabel : emptied('question') ? e.emptyQuestion : undefined;
    const renamed = has('name') && n !== sticky.local && !nameError;
    const references = renamed ? referencesTo(storming, sticky.local).length : 0;
    const change = editValues(sticky, fields, values);
    const changed = Object.keys(change).length > 0;
    const { saving, error, run } = useSave(() => props.onSave(change), props.onClose);
    const invalid = nameError !== undefined || textError !== undefined;
    const several = fields.some((f) => f.lines === 'several');
    const mac = isMac();
    const save = (): void => {
        if (!invalid && changed) run();
    };
    const names: Record<StickyFieldId, string> = { label: e.label, name: e.name, question: t.hotspot.label, resolution: t.resolve.label };
    return (
        <Popover
            anchor={props.anchor}
            label={sticky.kind === 'hotspot' ? e.hotspotDialog : e.dialog}
            onCancel={props.onClose}
            onSubmit={save}
            {...(props.focus !== undefined && { focus: props.focus })}
        >
            {fields.map((f) =>
                f.lines === 'one' ? (
                    <Field
                        key={f.id}
                        id={f.id}
                        label={names[f.id]}
                        value={values[f.id]}
                        onChange={set(f.id)}
                        mono={f.id === 'name'}
                        invalid={f.id === 'name' ? nameError !== undefined : textError !== undefined}
                        describedBy={errorId}
                    />
                ) : (
                    <label key={f.id} className="sticky-form-field">
                        <span>{names[f.id]}</span>
                        <textarea
                            data-field={f.id}
                            value={values[f.id]}
                            rows={3}
                            readOnly={saving}
                            aria-describedby={errorId}
                            aria-keyshortcuts={mac ? 'Meta+Enter' : 'Control+Enter'}
                            onChange={(ev) => set(f.id)(ev.target.value)}
                            onKeyDown={(ev) => {
                                if (ev.key !== 'Enter' || ev.nativeEvent.isComposing || !(ev.metaKey || ev.ctrlKey)) return;
                                ev.preventDefault();
                                save();
                            }}
                        />
                    </label>
                ),
            )}
            <div id={errorId} aria-live="polite">
                {renamed && references > 0 && <p className="sticky-form-impact">{e.impact(references, references)}</p>}
                {(nameError ?? textError ?? error) !== undefined && <p className="sticky-form-error">{nameError ?? textError ?? error}</p>}
            </div>
            <Foot
                save={e.save}
                saving={saving}
                disabled={invalid || !changed}
                onCancel={props.onClose}
                {...(several && { saveKeys: mac ? '⌘Enter' : 'Ctrl+Enter' })}
            />
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

/**
 * ホットスポットを付ける: its question, on several lines (Enter a new line, ⌘/Ctrl+Enter saves). Its name is not asked: dt
 * writes it at once under a provisional name, and the AI renames it afterwards.
 */
export function HotspotForm(props: { anchor: Anchor; onSave: (question: string) => Promise<SaveResult>; onClose: () => void }): ReactNode {
    const t = useT().stickies;
    return (
        <TextForm label={t.hotspot.dialog} field={t.hotspot.label} save={t.hotspot.save} onSave={props.onSave} onClose={props.onClose} anchor={props.anchor} />
    );
}

/** A window of one text on several lines: Enter a new line, ⌘/Ctrl+Enter saves (said in the button's tooltip only). */
function TextForm(props: {
    anchor: Anchor;
    label: string;
    field: string;
    save: string;
    initial?: string;
    onSave: (text: string) => Promise<SaveResult>;
    onClose: () => void;
}): ReactNode {
    const [text, setText] = useState(props.initial ?? '');
    const errorId = useId();
    const { saving, error, run } = useSave(() => props.onSave(text.trim()), props.onClose);
    const ready = text.trim().length > 0 && text.trim() !== props.initial;
    const mac = isMac();
    return (
        <Popover anchor={props.anchor} label={props.label} onCancel={props.onClose} onSubmit={() => ready && run()}>
            <label className="sticky-form-field">
                <span>{props.field}</span>
                <textarea
                    value={text}
                    rows={3}
                    readOnly={saving}
                    aria-describedby={errorId}
                    aria-keyshortcuts={mac ? 'Meta+Enter' : 'Control+Enter'}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key !== 'Enter' || e.nativeEvent.isComposing || !(e.metaKey || e.ctrlKey)) return;
                        e.preventDefault();
                        if (ready) run();
                    }}
                />
            </label>
            <div id={errorId} aria-live="polite">
                {error !== undefined && <p className="sticky-form-error">{error}</p>}
            </div>
            <Foot save={props.save} saving={saving} disabled={!ready} onCancel={props.onClose} saveKeys={mac ? '⌘Enter' : 'Ctrl+Enter'} />
        </Popover>
    );
}
