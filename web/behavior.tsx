import {
    allFieldsOf,
    emitSuffix,
    emittedEvents,
    policiesReactingTo,
    policiesRunning,
    type CommandModel,
    type DomainModel,
    type ElementModel,
    type FieldModel,
} from '../src/model/model';
import type { Messages } from './i18n';
import type { Namer, Select } from './model-utils';
import { diffRows, rowClass, type RowChange } from './row-diff';

/**
 * Cards of the aggregate's 振る舞い and イベント tabs: one per command, and one per event or error its commands raise or return.
 * They take the names and messages as props (no hooks), so that their clicks can be tested without a DOM.
 */

/** Whether an event is persisted by contract. */
export function PersistenceBadge({ persistent, tx }: { persistent: boolean; tx: Messages }) {
    return (
        <span className={`persistence-badge${persistent ? ' persistent' : ''}`} title={persistent ? tx.persistentHint : tx.transientHint}>
            {persistent ? tx.persistent : tx.transient}
        </span>
    );
}

/** A card's heading: the kind's colour band, the label in bold and the name small after it (by the display mode). */
function CardTitle({ kind, x, names, onClick }: { kind: string; x: { name: string; label?: string }; names: Namer; onClick: () => void }) {
    const both = names.mode === 'both' && !!x.label;
    return (
        <a className="bcard-title" onClick={onClick}>
            <span className={`bcard-band band-${kind}`} aria-hidden />
            <strong>{both ? x.label : names.of(x)}</strong>
            {both && <span className="bcard-name">{x.name}</span>}
        </a>
    );
}

/** A name in the display mode; in 両方 the label, and the name small after it. */
function Named({ x, names }: { x: { name: string; label?: string }; names: Namer }) {
    return names.mode === 'both' && x.label ? (
        <>
            {x.label} <span className="bcard-name">{x.name}</span>
        </>
    ) : (
        <>{names.of(x)}</>
    );
}

/** A link to a command, event or error with the dot of its kind, as in the explorer. */
function KindLink({ kind, id, x, names, onSelect }: { kind: string; id: string; x: { name: string; label?: string }; names: Namer; onSelect: Select }) {
    return (
        <a className="kind-link" onClick={() => onSelect(id)}>
            <span className={`tree-dot dot-${kind}`} aria-hidden />
            <Named x={x} names={names} />
        </a>
    );
}

/**
 * Parameters or payload in two columns: the name (ラベル 名前 in 両方) and the type. With `base` (the baseline's
 * fields), added, changed and removed fields are marked, and a changed type shows the old one struck through.
 */
function FieldGrid({ fields, base, ctx, names, onSelect }: { fields: FieldModel[]; base?: FieldModel[]; ctx: string; names: Namer; onSelect: Select }) {
    return (
        <div className="bcard-fields">
            {diffRows(fields, base, (f) => f.name).map(({ item: f, change, before }) => (
                <div key={`${f.name}:${change ?? ''}`} className={rowClass(change, 'bcard-field')} title={f.doc}>
                    <span className="bcard-fname">
                        <Named x={f} names={names} />
                    </span>
                    <span className="bcard-ftype">
                        {before && <OldType before={before} f={f} ctx={ctx} names={names} />}
                        {f.type.kind === 'ref' && f.type.target ? (
                            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the condition above checks that the type is a 'ref' (lost in the closure)
                            <a onClick={() => onSelect((f.type as { ref: string }).ref)}>{names.type(f.type, ctx)}</a>
                        ) : (
                            names.type(f.type, ctx)
                        )}
                        {f.multiplicity}
                        {f.fieldSet && (
                            <a className="field-origin" onClick={() => onSelect(f.fieldSet!)}>
                                {names.short(f.fieldSet)}
                            </a>
                        )}
                    </span>
                </div>
            ))}
        </div>
    );
}

/** A changed field's former type and multiplicity, struck through, when they differ from the current ones. */
export function OldType({ before, f, ctx, names }: { before: FieldModel; f: FieldModel; ctx: string; names: Namer }) {
    const old = names.type(before.type, ctx) + before.multiplicity;
    return old === names.type(f.type, ctx) + f.multiplicity ? null : <del className="was">{old}</del>;
}

/**
 * `[下書き] [確定済み] → [取消済み]`, or `● → [下書き]` for a factory, one row per transition; in 両方 a chip shows the
 * label, and the name on hover.
 */
function Transition({ agg, c, base, names, onSelect }: { agg: ElementModel; c: CommandModel; base?: CommandModel; names: Namer; onSelect: Select }) {
    const chips = (states: string[]) =>
        states.map((name) => {
            const s = agg.states?.find((x) => x.name === name);
            const both = names.mode === 'both' && !!s?.label;
            return (
                <a key={name} className="state-chip" title={both ? name : undefined} onClick={() => onSelect(s?.id ?? agg.id)}>
                    {both ? s!.label : names.state(agg, name)}
                </a>
            );
        });
    const key = (t: CommandModel['transitions'][number]) => `${t.from.join(',')}->${t.to.join(',')}`;
    return diffRows(c.transitions, base?.transitions, key).map(({ item: t, change }, i) => (
        <div key={i} className={rowClass(change, 'bcard-transition')}>
            {c.factory ? (
                <span className="initial-state" aria-hidden>
                    ●
                </span>
            ) : (
                chips(t.from)
            )}
            <span className="muted">→</span>
            {chips(t.to)}
        </div>
    ));
}

/**
 * The command's requirements (`requires`): each with its expression, or that it is not expressed in the DSL, and the
 * error the command returns when it does not hold.
 */
export function Requirements({
    c,
    base,
    model,
    names,
    tx,
    onSelect,
}: {
    c: CommandModel;
    base?: CommandModel;
    model: DomainModel;
    names: Namer;
    tx: Messages;
    onSelect: Select;
}) {
    return (
        <div className="bcard-requires">
            {diffRows(c.requires, base?.requires, (r) => r.name).map(({ item: r, change, before }) => (
                <div key={`${r.name}:${change ?? ''}`} className={rowClass(change, 'bcard-require')}>
                    <span className="bcard-rname">
                        <Named x={r} names={names} />
                    </span>
                    {before?.source !== undefined && before.source !== r.source && <del className="was">{before.source}</del>}
                    {r.source !== undefined ? <code>{r.source}</code> : <em className="not-in-dsl">{tx.notInDsl}</em>}
                    <span className="bcard-outcome">
                        <span className="muted" title={tx.requirementElseHint}>
                            else
                        </span>
                        <KindLink
                            kind={model.elements[r.error]?.kind ?? 'error'}
                            id={r.error}
                            x={model.elements[r.error] ?? { name: r.error }}
                            names={names}
                            onSelect={onSelect}
                        />
                    </span>
                    {r.doc && <div className="bcard-doc">{r.doc}</div>}
                </div>
            ))}
        </div>
    );
}

/** The fields a command may change (`changes`), by their names in the display mode. */
export function Changes({ agg, c, base, names }: { agg: ElementModel; c: CommandModel; base?: CommandModel; names: Namer }) {
    const fields = allFieldsOf(agg);
    return (
        <div className="bcard-changes">
            {diffRows(c.changes, base?.changes, (n) => n).map(({ item: name, change }) => (
                <code key={name} className={rowClass(change, 'bcard-change')}>
                    <Named x={fields.find((f) => f.name === name) ?? { name }} names={names} />
                </code>
            ))}
        </div>
    );
}

/** The policies of a list as links, after a caption (`実行するポリシー`, `反応するポリシー`); nothing when there are none. */
function PolicyLinks({
    caption,
    policies,
    base,
    names,
    onSelect,
}: {
    caption: string;
    policies: ElementModel[];
    base?: ElementModel[];
    names: Namer;
    onSelect: Select;
}) {
    if (!policies.length && !base?.length) return null;
    return (
        <div className="bcard-outcome">
            <span className="bcard-caption">{caption}</span>
            {diffRows(policies, base, (p) => p.id).map(({ item: p, change }) => (
                <span key={p.id} className={rowClass(change)}>
                    <KindLink kind="policy" id={p.id} x={p} names={names} onSelect={onSelect} />
                </span>
            ))}
        </div>
    );
}

/**
 * A policy's reaction: the event, and the command it runs, as links; that it runs eventually, by any mechanism; and
 * with `input`, what the command needs (its parameters, after the aggregate's ID unless a factory).
 */
export function PolicyReaction({
    p,
    model,
    names,
    tx,
    onSelect,
    input,
}: {
    p: ElementModel;
    model: DomainModel;
    names: Namer;
    tx: Messages;
    onSelect: Select;
    input?: boolean;
}) {
    if (!p.policy) return null;
    const { event, aggregate, command } = p.policy;
    const agg = model.elements[aggregate];
    const c = agg?.commands?.find((x) => x.name === command);
    const id = agg?.fields.find((f) => f.name === 'id');
    const fields = c
        ? [...(!c.factory && id ? [{ ...id, name: agg!.name.charAt(0).toLowerCase() + agg!.name.slice(1), label: agg!.label }] : []), ...c.params]
        : [];
    return (
        <div className="bcard-reaction">
            <div className="bcard-outcome">
                <span className="bcard-caption">{tx.whenEvent}</span>
                <KindLink kind="event" id={event} x={model.elements[event] ?? { name: event }} names={names} onSelect={onSelect} />
            </div>
            <div className="bcard-outcome">
                <span className="bcard-caption">{tx.runsCommand}</span>
                {c ? (
                    <KindLink
                        kind="command"
                        id={c.id}
                        x={{ name: `${agg!.name}.${c.name}`, ...(c.label && { label: c.label }) }}
                        names={names}
                        onSelect={onSelect}
                    />
                ) : (
                    <code>{`${aggregate}.${command}`}</code>
                )}
            </div>
            <div className="muted small">{tx.eventually}</div>
            {input && fields.length > 0 && (
                <div className="bcard-part">
                    <div className="bcard-caption">{tx.policyInput}</div>
                    <FieldGrid fields={fields} ctx={p.context} names={names} onSelect={onSelect} />
                </div>
            )}
        </div>
    );
}

/**
 * The baseline a card is compared with: its model, and the command (or event, error) as it was there; `change` marks the
 * whole card. Without it nothing is marked.
 */
export interface CardBase<T> {
    model: DomainModel;
    item?: T;
    change?: RowChange;
}

export function CommandCard({
    agg,
    c,
    model,
    names,
    tx,
    onSelect,
    base,
}: {
    agg: ElementModel;
    c: CommandModel;
    model: DomainModel;
    names: Namer;
    tx: Messages;
    onSelect: Select;
    base?: CardBase<CommandModel>;
}) {
    const outcome = (id: string) => model.elements[id] ?? base?.model.elements[id] ?? { name: id };
    // the parts of a removed or added card are not marked one by one
    const was = base?.change === 'changed' || !base?.change ? base?.item : undefined;
    const has = (part: keyof CommandModel) => {
        const now = c[part];
        const then = was?.[part];
        return (Array.isArray(now) && now.length > 0) || (Array.isArray(then) && then.length > 0);
    };
    return (
        <div className={rowClass(base?.change, 'bcard')}>
            <div className="bcard-head">
                <CardTitle kind="command" x={c} names={names} onClick={() => onSelect(c.id)} />
                {c.factory && <span className="factory-badge">{tx.factory}</span>}
                {base?.change && <span className={`change change-${base.change}`}>{tx[base.change]}</span>}
            </div>
            {(agg.states?.length ?? 0) > 0 && <Transition agg={agg} c={c} base={was} names={names} onSelect={onSelect} />}
            {has('params') && (
                <div className="bcard-part">
                    <div className="bcard-caption">{tx.params}</div>
                    <FieldGrid fields={c.params} base={was?.params} ctx={agg.context} names={names} onSelect={onSelect} />
                </div>
            )}
            {has('requires') && (
                <div className="bcard-part">
                    <div className="bcard-caption">{tx.requirements}</div>
                    <Requirements c={c} base={was} model={model} names={names} tx={tx} onSelect={onSelect} />
                </div>
            )}
            {has('changes') && (
                <div className="bcard-part">
                    <div className="bcard-caption">{tx.changedFields}</div>
                    <Changes agg={agg} c={c} base={was} names={names} />
                </div>
            )}
            {(has('emits') || has('errors')) && (
                <div className="bcard-outcomes">
                    {has('emits') && (
                        <span className="bcard-outcome">
                            <span className="muted" title={tx.raisesHint}>
                                ⇒
                            </span>
                            {diffRows(c.emits, was?.emits, (e) => e.event).map(({ item: e, change }, i) => (
                                <span key={i} className={rowClass(change, 'bcard-emit')}>
                                    <KindLink
                                        kind={model.elements[e.event]?.kind ?? 'event'}
                                        id={e.event}
                                        x={outcome(e.event)}
                                        names={names}
                                        onSelect={onSelect}
                                    />
                                    {emitSuffix(e) && <code className="bcard-emit-when">{emitSuffix(e)}</code>}
                                </span>
                            ))}
                        </span>
                    )}
                    {has('errors') && (
                        <span className="bcard-outcome">
                            <span className="muted" title={tx.returnsHint}>
                                ✕
                            </span>
                            {diffRows(c.errors, was?.errors, (e) => e).map(({ item: e, change }) => (
                                <span key={e} className={rowClass(change)}>
                                    <KindLink kind={model.elements[e]?.kind ?? 'error'} id={e} x={outcome(e)} names={names} onSelect={onSelect} />
                                </span>
                            ))}
                        </span>
                    )}
                </div>
            )}
            <PolicyLinks
                caption={tx.triggeredBy}
                policies={policiesRunning(model, agg.id, c.name)}
                base={was && base && policiesRunning(base.model, agg.id, c.name)}
                names={names}
                onSelect={onSelect}
            />
        </div>
    );
}

/** An event or error with the commands it comes from and its payload. */
export function OutcomeCard({
    id,
    commands,
    model,
    names,
    tx,
    onSelect,
    base,
}: {
    id: string;
    commands: CommandModel[];
    model: DomainModel;
    names: Namer;
    tx: Messages;
    onSelect: Select;
    /** The baseline: the card is marked by `change`, and the payload against the baseline's event or error. */
    base?: CardBase<ElementModel>;
}) {
    const el = model.elements[id] ?? base?.item;
    const kind = el?.kind ?? 'error';
    const was = base?.change === 'changed' || !base?.change ? base?.item : undefined;
    return (
        <div className={rowClass(base?.change, 'bcard')}>
            <div className="bcard-head">
                <CardTitle kind={kind} x={el ?? { name: id }} names={names} onClick={() => onSelect(id)} />
                {el?.kind === 'event' && <PersistenceBadge persistent={!!el.persistent} tx={tx} />}
                {base?.change && <span className={`change change-${base.change}`}>{tx[base.change]}</span>}
            </div>
            {el?.doc && <div className="bcard-doc">{el.doc}</div>}
            <div className="bcard-outcome">
                <span className="bcard-caption">{tx.origin}</span>
                {commands.map((c) => (
                    <KindLink key={c.id} kind="command" id={c.id} x={c} names={names} onSelect={onSelect} />
                ))}
            </div>
            {kind === 'event' && <PolicyLinks caption={tx.reactedToBy} policies={policiesReactingTo(model, id)} names={names} onSelect={onSelect} />}
            {el && el.fields.length > 0 && (
                <div className="bcard-part">
                    <div className="bcard-caption">{tx.payload}</div>
                    <FieldGrid fields={el.fields} base={was?.fields} ctx={el.context} names={names} onSelect={onSelect} />
                </div>
            )}
        </div>
    );
}

/** The events (`emits`) or errors (`errors`) of the aggregate's commands, with the commands of each. */
export function outcomesOf(commands: CommandModel[], kind: 'emits' | 'errors'): Map<string, CommandModel[]> {
    const out = new Map<string, CommandModel[]>();
    for (const c of commands) {
        for (const e of kind === 'emits' ? emittedEvents(c) : c.errors) out.set(e, [...(out.get(e) ?? []), c]);
    }
    return out;
}
