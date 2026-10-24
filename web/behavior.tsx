import { allFieldsOf, emitSuffix, emittedEvents, policiesReactingTo, policiesRunning, type CommandModel, type DomainModel, type ElementModel, type FieldModel } from '../src/model/model';
import type { Messages } from './i18n';
import type { Namer, Select } from './model-utils';

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

/** Parameters or payload in two columns: the name (ラベル 名前 in 両方) and the type. */
function FieldGrid({ fields, ctx, names, onSelect }: { fields: FieldModel[]; ctx: string; names: Namer; onSelect: Select }) {
    return (
        <div className="bcard-fields">
            {fields.map((f) => (
                <div key={f.name} className="bcard-field" title={f.doc}>
                    <span className="bcard-fname">
                        <Named x={f} names={names} />
                    </span>
                    <span className="bcard-ftype">
                        {f.type.kind === 'ref' && f.type.target ? (
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

/**
 * `[下書き] [確定済み] → [取消済み]`, or `● → [下書き]` for a factory, one row per transition; in 両方 a chip shows the
 * label, and the name on hover.
 */
function Transition({ agg, c, names, onSelect }: { agg: ElementModel; c: CommandModel; names: Namer; onSelect: Select }) {
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
    return c.transitions.map((t, i) => (
        <div key={i} className="bcard-transition">
            {c.factory ? <span className="initial-state" aria-hidden>●</span> : chips(t.from)}
            <span className="muted">→</span>
            {chips(t.to)}
        </div>
    ));
}

/**
 * The command's requirements (`requires`): each with its expression, or that it is not expressed in the DSL, and the
 * error the command returns when it does not hold.
 */
export function Requirements({ c, model, names, tx, onSelect }: { c: CommandModel; model: DomainModel; names: Namer; tx: Messages; onSelect: Select }) {
    return (
        <div className="bcard-requires">
            {c.requires.map((r) => (
                <div key={r.name} className="bcard-require">
                    <span className="bcard-rname">
                        <Named x={r} names={names} />
                    </span>
                    {r.source !== undefined ? <code>{r.source}</code> : <em className="not-in-dsl">{tx.notInDsl}</em>}
                    <span className="bcard-outcome">
                        <span className="muted" title={tx.requirementElseHint}>else</span>
                        <KindLink kind={model.elements[r.error]?.kind ?? 'error'} id={r.error} x={model.elements[r.error] ?? { name: r.error }} names={names} onSelect={onSelect} />
                    </span>
                    {r.doc && <div className="bcard-doc">{r.doc}</div>}
                </div>
            ))}
        </div>
    );
}

/** The fields a command may change (`changes`), by their names in the display mode. */
export function Changes({ agg, c, names }: { agg: ElementModel; c: CommandModel; names: Namer }) {
    const fields = allFieldsOf(agg);
    return (
        <div className="bcard-changes">
            {c.changes.map((name) => (
                <code key={name} className="bcard-change">
                    <Named x={fields.find((f) => f.name === name) ?? { name }} names={names} />
                </code>
            ))}
        </div>
    );
}

/** The policies of a list as links, after a caption (`実行するポリシー`, `反応するポリシー`); nothing when there are none. */
function PolicyLinks({ caption, policies, names, onSelect }: { caption: string; policies: ElementModel[]; names: Namer; onSelect: Select }) {
    if (!policies.length) return null;
    return (
        <div className="bcard-outcome">
            <span className="bcard-caption">{caption}</span>
            {policies.map((p) => (
                <KindLink key={p.id} kind="policy" id={p.id} x={p} names={names} onSelect={onSelect} />
            ))}
        </div>
    );
}

/**
 * A policy's reaction: the event, and the command it runs, as links; that it runs eventually, by any mechanism; and
 * with `input`, what the command needs (its parameters, after the aggregate's ID unless a factory).
 */
export function PolicyReaction({ p, model, names, tx, onSelect, input }: { p: ElementModel; model: DomainModel; names: Namer; tx: Messages; onSelect: Select; input?: boolean }) {
    if (!p.policy) return null;
    const { event, aggregate, command } = p.policy;
    const agg = model.elements[aggregate];
    const c = agg?.commands?.find((x) => x.name === command);
    const id = agg?.fields.find((f) => f.name === 'id');
    const fields = c ? [...(!c.factory && id ? [{ ...id, name: agg!.name.charAt(0).toLowerCase() + agg!.name.slice(1), label: agg!.label }] : []), ...c.params] : [];
    return (
        <div className="bcard-reaction">
            <div className="bcard-outcome">
                <span className="bcard-caption">{tx.whenEvent}</span>
                <KindLink kind="event" id={event} x={model.elements[event] ?? { name: event }} names={names} onSelect={onSelect} />
            </div>
            <div className="bcard-outcome">
                <span className="bcard-caption">{tx.runsCommand}</span>
                {c ? (
                    <KindLink kind="command" id={c.id} x={{ name: `${agg!.name}.${c.name}`, ...(c.label && { label: c.label }) }} names={names} onSelect={onSelect} />
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

export function CommandCard({ agg, c, model, names, tx, onSelect }: { agg: ElementModel; c: CommandModel; model: DomainModel; names: Namer; tx: Messages; onSelect: Select }) {
    const outcome = (id: string) => model.elements[id] ?? { name: id };
    return (
        <div className="bcard">
            <div className="bcard-head">
                <CardTitle kind="command" x={c} names={names} onClick={() => onSelect(c.id)} />
                {c.factory && <span className="factory-badge">{tx.factory}</span>}
            </div>
            {(agg.states?.length ?? 0) > 0 && <Transition agg={agg} c={c} names={names} onSelect={onSelect} />}
            {c.params.length > 0 && (
                <div className="bcard-part">
                    <div className="bcard-caption">{tx.params}</div>
                    <FieldGrid fields={c.params} ctx={agg.context} names={names} onSelect={onSelect} />
                </div>
            )}
            {c.requires.length > 0 && (
                <div className="bcard-part">
                    <div className="bcard-caption">{tx.requirements}</div>
                    <Requirements c={c} model={model} names={names} tx={tx} onSelect={onSelect} />
                </div>
            )}
            {c.changes.length > 0 && (
                <div className="bcard-part">
                    <div className="bcard-caption">{tx.changedFields}</div>
                    <Changes agg={agg} c={c} names={names} />
                </div>
            )}
            {c.emits.length + c.errors.length > 0 && (
                <div className="bcard-outcomes">
                    {c.emits.length > 0 && (
                        <span className="bcard-outcome">
                            <span className="muted" title={tx.raisesHint}>⇒</span>
                            {c.emits.map((e, i) => (
                                <span key={i} className="bcard-emit">
                                    <KindLink kind={model.elements[e.event]?.kind ?? 'event'} id={e.event} x={outcome(e.event)} names={names} onSelect={onSelect} />
                                    {emitSuffix(e) && <code className="bcard-emit-when">{emitSuffix(e)}</code>}
                                </span>
                            ))}
                        </span>
                    )}
                    {c.errors.length > 0 && (
                        <span className="bcard-outcome">
                            <span className="muted" title={tx.returnsHint}>✕</span>
                            {c.errors.map((e) => (
                                <KindLink key={e} kind={model.elements[e]?.kind ?? 'error'} id={e} x={outcome(e)} names={names} onSelect={onSelect} />
                            ))}
                        </span>
                    )}
                </div>
            )}
            <PolicyLinks caption={tx.triggeredBy} policies={policiesRunning(model, agg.id, c.name)} names={names} onSelect={onSelect} />
        </div>
    );
}

/** An event or error with the commands it comes from and its payload. */
export function OutcomeCard({ id, commands, model, names, tx, onSelect }: { id: string; commands: CommandModel[]; model: DomainModel; names: Namer; tx: Messages; onSelect: Select }) {
    const el = model.elements[id];
    const kind = el?.kind ?? 'error';
    return (
        <div className="bcard">
            <div className="bcard-head">
                <CardTitle kind={kind} x={el ?? { name: id }} names={names} onClick={() => onSelect(id)} />
                {el?.kind === 'event' && <PersistenceBadge persistent={!!el.persistent} tx={tx} />}
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
                    <FieldGrid fields={el.fields} ctx={el.context} names={names} onSelect={onSelect} />
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
