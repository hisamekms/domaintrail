import type { CommandModel, DomainModel, ElementModel, FieldModel } from '../src/model/model';
import type { Messages } from './i18n';
import type { Namer, Select } from './model-utils';

/**
 * Cards of the aggregate's 振る舞い tab: one per command, and one per event or error its commands raise or return.
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
                    </span>
                </div>
            ))}
        </div>
    );
}

/** `[下書き] [確定済み] → [取消済み]`, or `● → [下書き]` for a factory; in 両方 a chip shows the label, and the name on hover. */
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
    return (
        <div className="bcard-transition">
            {c.factory ? <span className="initial-state" aria-hidden>●</span> : chips(c.from)}
            <span className="muted">→</span>
            {chips(c.to)}
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
            {c.emits.length + c.errors.length > 0 && (
                <div className="bcard-outcomes">
                    {c.emits.length > 0 && (
                        <span className="bcard-outcome">
                            <span className="muted" title={tx.raisesHint}>⇒</span>
                            {c.emits.map((e) => (
                                <KindLink key={e} kind={model.elements[e]?.kind ?? 'event'} id={e} x={outcome(e)} names={names} onSelect={onSelect} />
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
        for (const e of c[kind]) out.set(e, [...(out.get(e) ?? []), c]);
    }
    return out;
}
