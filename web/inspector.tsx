import { PanelRightClose } from 'lucide-react';
import { createContext, useContext, type ReactNode } from 'react';
import type { DisplayMode } from '../src/graph/ir';
import type { Diagnostic } from '../src/core/diagnostics';
import type { ModelDiff } from '../src/graph/diff';
import type { CommandModel, DomainModel, ElementModel, FieldModel, InvariantModel, Location } from '../src/model/model';
import { dependencyCounts } from '../src/graph/context-map';
import { contextDependencies, groupByContext, supportingContexts, type ContextDependency } from '../src/model/dependencies';
import { useLang, useT } from './i18n';
import { KIND_LABEL, KIND_ORDER, namer, resolve, selectedFile, type Namer, type Resolved, type Select } from './model-utils';
import { ownerElement } from './render';
import { CopyLocation, SourceView, type SourceFocus } from './source';
import { usagesOf } from './usages';

export type InspectorTab = 'structure' | 'states' | 'behavior' | 'references' | 'source';

/** Where the selected item can be shown in the main area. */
export type RevealTarget = 'contextMap' | 'structure' | 'primitives';

/** Display names in the current mode (ラベル / 名前 / 両方). */
const NamerContext = createContext<Namer>(namer('both', null));
const useNames = (): Namer => useContext(NamerContext);

export interface InspectorProps {
    model: DomainModel | null;
    mode: DisplayMode;
    selected: string | undefined;
    diagnostics: Diagnostic[];
    diff: ModelDiff;
    sources: { path: string; text: string }[];
    /** Where the source tab (or a selected file) scrolls to. */
    sourceFocus: SourceFocus | undefined;
    /** The state diagram of an aggregate (the 状態遷移 tab). */
    statesView: (aggregateId: string) => ReactNode;
    tab: InspectorTab;
    onTab: (tab: InspectorTab) => void;
    onSelect: Select;
    onReveal: (target: RevealTarget, id: string) => void;
    /** Shows one bounded context in the Structure View, with its dependencies as stubs. */
    onFocusContext: (ctx: string) => void;
    canBack: boolean;
    canForward: boolean;
    onBack: () => void;
    onForward: () => void;
    onClose: () => void;
}

/** Tabs that make sense for a selected item, in display order. */
function tabsFor(r: Resolved): InspectorTab[] {
    switch (r.kind) {
        case 'context':
            return ['structure'];
        case 'state':
            return ['structure', 'states', 'behavior', 'source'];
        case 'command':
            return ['structure', 'states', 'behavior', 'source'];
        case 'element':
            return r.el.kind === 'aggregate' ? ['structure', 'states', 'behavior', 'references', 'source'] : ['structure', 'references', 'source'];
    }
}

/** Views in which the item appears. */
function revealTargets(r: Resolved): RevealTarget[] {
    const out: RevealTarget[] = [];
    if (r.kind === 'element') {
        if (r.el.kind === 'aggregate' || r.el.kind === 'entity' || r.el.kind === 'valueObject' || r.el.kind === 'union') out.push('structure');
        if (r.el.kind === 'primitive' || r.el.kind === 'id' || r.el.kind === 'enum') out.push('primitives');
    } else if (r.kind === 'context') {
        out.push('contextMap', 'structure');
    }
    return out;
}


export function Inspector(props: InspectorProps) {
    const { model, selected } = props;
    const tx = useT();
    const history = (
        <div className="history">
            <button disabled={!props.canBack} onClick={props.onBack} title={tx.back} aria-label={tx.back}>
                ←
            </button>
            <button disabled={!props.canForward} onClick={props.onForward} title={tx.forward} aria-label={tx.forward}>
                →
            </button>
            <button className="icon-button" onClick={props.onClose} title={tx.closeInspector} aria-label={tx.closeInspector}>
                <PanelRightClose size={16} aria-hidden />
            </button>
        </div>
    );
    // a file can be shown even without a model (e.g. a syntax error before the first valid parse)
    const file = selectedFile(selected);
    if (file) {
        return (
            <div className="inspector">
                <div className="inspector-head">
                    <div className="inspector-row">
                        <span className="kind kind-file">{tx.fileKind}</span>
                        {history}
                    </div>
                    <h2>{file}</h2>
                    <DiagnosticList items={props.diagnostics.filter((d) => d.file === file)} />
                </div>
                <div className="inspector-body inspector-body-full">
                    <SourceView
                        sources={props.sources}
                        diagnostics={props.diagnostics}
                        model={model}
                        file={file}
                        focus={props.sourceFocus?.file === file ? props.sourceFocus : undefined}
                        onSelect={props.onSelect}
                    />
                </div>
            </div>
        );
    }
    if (!model)
        return (
            <div className="inspector">
                <div className="inspector-head">
                    <div className="inspector-row">{history}</div>
                    <p className="muted">{tx.noModel}</p>
                </div>
            </div>
        );
    const r = selected ? resolve(model, selected) : undefined;
    if (!selected || !r) {
        return (
            <div className="inspector">
                <div className="inspector-head">
                    <div className="inspector-row">{history}</div>
                    <p className="muted">{selected ? tx.notInModel(selected) : tx.pickElement}</p>
                </div>
            </div>
        );
    }

    const names = namer(props.mode, model);
    const tabs = tabsFor(r);
    const tab = tabs.includes(props.tab) ? props.tab : tabs[0];
    const diags = props.diagnostics.filter((d) => d.elementId === selected || (r.kind === 'element' && d.elementId && ownerElement(d.elementId) === selected));
    const change = props.diff.added.includes(selected) ? 'added' : props.diff.changed.includes(selected) ? 'changed' : undefined;
    const head = headOf(r);

    const title = names.of({ name: head.name, label: head.label });
    return (
        <NamerContext.Provider value={names}>
        <div className="inspector">
            <div className="inspector-head">
                <div className="inspector-row">
                    <span className={`kind kind-${head.kind}`}>{KIND_LABEL[head.kind] ?? head.kind}</span>
                    {r.kind === 'context' && r.shared && <span className="shared-badge">{tx.shared}</span>}
                    {change && <span className={`change change-${change}`}>{change === 'added' ? tx.added : tx.changed}</span>}
                    {history}
                </div>
                <h2>{props.mode === 'both' && head.label ? head.label : title}</h2>
                {props.mode === 'both' && head.label && <div className="canonical-name">{head.name}</div>}
                {head.doc && <p className="doc">{head.doc}</p>}
                {head.location && (
                    <div className="inspector-loc">
                        <CopyLocation loc={head.location} />
                    </div>
                )}
                {revealTargets(r).length > 0 && (
                    <div className="reveal">
                        <span className="muted small">{tx.showIn}</span>
                        {revealTargets(r).map((t) => (
                            <button key={t} onClick={() => props.onReveal(t, selected)}>
                                {tx.reveal[t]}
                            </button>
                        ))}
                    </div>
                )}
                <DiagnosticList items={diags} />
            </div>
            {tabs.length > 1 && (
                <div className="subtabs" role="tablist">
                    {tabs.map((t) => (
                        <button key={t} role="tab" aria-selected={t === tab} className={t === tab ? 'active' : ''} onClick={() => props.onTab(t)}>
                            {tx.tabs[t]}
                        </button>
                    ))}
                </div>
            )}
            <div className={`inspector-body${tab === 'source' || tab === 'states' ? ' inspector-body-full' : ''}`}>
                <Body {...props} r={r} tab={tab} />
            </div>
        </div>
        </NamerContext.Provider>
    );
}

function headOf(r: Resolved): { kind: string; name: string; label?: string; doc?: string; location?: Location } {
    switch (r.kind) {
        case 'context':
            return { kind: 'context', name: r.name, label: r.label };
        case 'element':
            return { kind: r.el.kind, name: r.el.id, label: r.el.label, doc: r.el.doc, location: r.el.location };
        case 'state':
            return { kind: 'state', name: `${r.agg.name}.${r.state.name}`, label: r.state.label, doc: r.state.doc, location: r.state.location };
        case 'command':
            return { kind: 'command', name: `${r.agg.name}.${r.command.name}`, label: r.command.label, doc: r.command.doc, location: r.command.location };
    }
}

function Body(props: InspectorProps & { r: Resolved; tab: InspectorTab }) {
    const { r, tab, model, onSelect } = props;
    const names = useNames();
    const tx = useT();
    if (!model) return null;
    if (tab === 'source') {
        const loc = headOf(r).location;
        if (!loc) return null;
        // the focus follows the selection, but may point at a diagnostic inside the declaration instead
        const focus = props.sourceFocus?.file === loc.file ? props.sourceFocus : loc;
        return <SourceView sources={props.sources} diagnostics={props.diagnostics} model={model} file={loc.file} focus={focus} onSelect={onSelect} />;
    }

    // the same aggregate's diagram for the aggregate, its states and its commands, so it stays while they are picked in it
    if (tab === 'states') return props.statesView(r.kind === 'element' ? r.el.id : r.kind === 'context' ? r.name : r.agg.id);

    if (r.kind === 'context') return <ContextBody model={model} ctx={r.name} onSelect={onSelect} onFocus={props.onFocusContext} />;

    if (r.kind === 'state') {
        const { agg, state } = r;
        if (tab === 'behavior') {
            const incoming = (agg.commands ?? []).filter((c) => c.to.includes(state.name));
            const outgoing = (agg.commands ?? []).filter((c) => c.from.includes(state.name));
            return (
                <>
                    <CommandList title={tx.commandsInto} agg={agg} commands={incoming} onSelect={onSelect} />
                    <CommandList title={tx.commandsOutOf} agg={agg} commands={outgoing} onSelect={onSelect} />
                </>
            );
        }
        return (
            <>
                <Fields title={tx.stateFields} fields={state.fields} ctx={agg.context} onSelect={onSelect} empty={tx.noStateFields} />
                <Invariants items={state.invariants} title={tx.stateInvariants} labelOnly />
                <p className="muted small">
                    {tx.commonFieldsAt(<a onClick={() => onSelect(agg.id)}>{names.of(agg)}</a>)}
                </p>
            </>
        );
    }

    if (r.kind === 'command') {
        const { agg, command: c } = r;
        if (tab === 'behavior') {
            return (
                <>
                    <Section title={tx.transition}>
                        <code className="block">{names.transition(agg, c) || tx.noStates}</code>
                    </Section>
                    <Section title={tx.mayRaise}>
                        {c.emits.length ? c.emits.map((e) => <OutcomeRow key={e} model={model} id={e} onSelect={onSelect} />) : <span className="muted">{tx.none}</span>}
                    </Section>
                    <Section title={tx.mayReturn}>
                        {c.errors.length ? c.errors.map((e) => <OutcomeRow key={e} model={model} id={e} onSelect={onSelect} />) : <span className="muted">{tx.none}</span>}
                    </Section>
                </>
            );
        }
        return (
            <>
                <Fields title={tx.params} fields={c.params} ctx={agg.context} onSelect={onSelect} empty={tx.noParams} />
                <Section title={tx.contract}>
                    <code className="block">
                        {c.factory ? 'create ' : ''}command {c.name}({c.params.map((p) => `${p.name}: ${namer('name', model).type(p.type, agg.context)}${p.multiplicity}`).join(', ')})
                    </code>
                </Section>
            </>
        );
    }

    const el = r.el;
    if (tab === 'behavior') {
        return (
            <>
                <CommandList title={tx.counted('Command', el.commands?.length ?? 0)} agg={el} commands={el.commands ?? []} onSelect={onSelect} />
                <AggregateOutcomes agg={el} model={model} kind="emits" onSelect={onSelect} />
                <AggregateOutcomes agg={el} model={model} kind="errors" onSelect={onSelect} />
            </>
        );
    }
    if (tab === 'references') return <References model={model} el={el} onSelect={onSelect} />;

    // structure
    return (
        <>
            {el.base && (
                <p>
                    {el.kind === 'id' ? tx.identifier : 'Domain Primitive'}
                    {tx.separator}
                    {tx.baseType}: <code>{names.primitive(el.base)}</code>
                </p>
            )}
            {el.values && (
                <Section title={tx.values}>
                    <div className="chips">
                        {el.values.map((v) => (
                            <code key={v}>
                                {names.mode === 'both' ? v : names.of({ name: v, label: el.valueLabels?.[v] })}
                                {names.mode === 'both' && el.valueLabels?.[v] && <span className="muted"> {el.valueLabels[v]}</span>}
                            </code>
                        ))}
                    </div>
                </Section>
            )}
            {el.kind === 'union' && (
                <>
                    <p>
                        {tx.discriminator}: <code>{el.discriminator}</code>
                        {el.tagType && (
                            <>
                                {tx.separator}
                                {tx.values}: <a onClick={() => onSelect(el.tagType!)}>{names.id(el.tagType)}</a>
                            </>
                        )}
                    </p>
                    {(el.variants ?? []).map((v) => (
                        <div key={v.name} title={v.doc}>
                            <Fields title={`${names.of(v)}`} fields={v.fields} ctx={el.context} onSelect={onSelect} empty={tx.noFields} />
                            <Invariants items={v.invariants} title={tx.variantInvariants(names.of(v))} />
                        </div>
                    ))}
                </>
            )}
            {el.kind !== 'id' && el.kind !== 'primitive' && el.kind !== 'enum' && el.kind !== 'union' && (
                <Fields
                    title={el.states?.length ? tx.commonFields : el.kind === 'event' || el.kind === 'error' ? tx.payload : tx.fields}
                    fields={el.fields}
                    ctx={el.context}
                    onSelect={onSelect}
                    empty={tx.noFields}
                />
            )}
            {(el.kind === 'aggregate' || el.kind === 'entity' || el.kind === 'valueObject') && (
                <Invariants items={el.invariants} title={el.states?.length ? tx.allStateInvariants : tx.invariants} labelOnly={el.kind === 'aggregate'} />
            )}
            {(el.kind === 'id' || el.kind === 'primitive') && <Invariants items={el.invariants} title={tx.valueInvariants} />}
            {el.states && el.states.length > 0 && (
                <Section title={tx.counted('State', el.states.length)}>
                    {el.states.map((s) => (
                        <div key={s.id} className="sub">
                            <a onClick={() => onSelect(s.id)}>{names.of(s)}</a>
                            {s.fields.length > 0 && <span className="muted small"> {s.fields.map((f) => names.field(f)).join(', ')}</span>}
                        </div>
                    ))}
                </Section>
            )}
        </>
    );
}

/** Dependencies of a context on others (or of others on it), one collapsible group per context with every use. */
function Dependencies({ title, groups, other, onSelect }: { title: string; groups: ContextDependency[]; other: (g: ContextDependency) => string; onSelect: Select }) {
    const names = useNames();
    const tx = useT();
    const lang = useLang();
    if (groups.length === 0) return null;
    return (
        <Section title={`${title}（${groups.length}）`}>
            {groups.map((g) => (
                <details key={other(g)} className="deps">
                    <summary>
                        <a onClick={() => onSelect(other(g))}>{names.id(other(g))}</a>
                        <span className="muted small"> {dependencyCounts(g.ids, g.types)[lang][names.mode]}</span>
                    </summary>
                    {g.uses.map((u, i) => (
                        <div key={i} className="sub small">
                            <a onClick={() => onSelect(u.source)}>{names.id(u.source)}</a>
                            <span className="muted">.{u.path} → </span>
                            <a onClick={() => onSelect(u.target)}>{names.id(u.target)}</a>
                            <span className={`dep-kind dep-${u.kind}`}>{u.kind === 'id' ? 'ID' : tx.typeDependency}</span>
                        </div>
                    ))}
                </details>
            ))}
        </Section>
    );
}

function ContextBody({ model, ctx, onSelect, onFocus }: { model: DomainModel; ctx: string; onSelect: Select; onFocus: (ctx: string) => void }) {
    const names = useNames();
    const tx = useT();
    const els = Object.values(model.elements).filter((e) => e.context === ctx);
    const terms = model.terms[ctx] ?? [];
    const groups = groupByContext(contextDependencies(model));
    return (
        <>
            {!supportingContexts(model).has(ctx) && (
                <p>
                    <button onClick={() => onFocus(ctx)}>{tx.focusContext}</button>
                </p>
            )}
            <Dependencies title={tx.dependencies} groups={groups.filter((g) => g.from === ctx)} other={(g) => g.to} onSelect={onSelect} />
            <Dependencies title={tx.dependents} groups={groups.filter((g) => g.to === ctx)} other={(g) => g.from} onSelect={onSelect} />
            {KIND_ORDER.map((kind) => {
                const items = els.filter((e) => e.kind === kind);
                if (!items.length) return null;
                return (
                    <Section key={kind} title={tx.counted(tx.kindGroups[kind], items.length)}>
                        {items.map((e) => (
                            <div key={e.id} className="sub">
                                <a onClick={() => onSelect(e.id)}>{names.of(e)}</a>
                            </div>
                        ))}
                    </Section>
                );
            })}
            {terms.length > 0 && (
                <Section title={tx.terms}>
                    <table className="fields">
                        <tbody>
                            {terms.map((t) => (
                                <tr key={t.name}>
                                    <td className="flabel">{t.label}</td>
                                    <td className="fname">{t.name}</td>
                                    <td className="muted">{t.doc}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </Section>
            )}
        </>
    );
}

/** Where an element is used: by fields / parameters, by references, and by commands (events, errors). */
function References({ model, el, onSelect }: { model: DomainModel; el: ElementModel; onSelect: Select }) {
    const names = useNames();
    const tx = useT();
    const typeUses = usagesOf(model, el.id, names.of);
    const idType = el.fields.find((f) => f.name === 'id' && f.type.kind === 'ref')?.type;
    const idUses = el.kind === 'aggregate' && idType?.kind === 'ref' ? usagesOf(model, idType.ref, names.of).filter((u) => u.target !== el.id) : [];
    const commands = Object.values(model.elements).flatMap((a) =>
        (a.commands ?? []).filter((c) => c.emits.includes(el.id) || c.errors.includes(el.id)).map((c) => ({ agg: a, c })),
    );
    if (!typeUses.length && !idUses.length && !commands.length) return <p className="muted">{tx.unreferenced}</p>;
    return (
        <>
            {commands.length > 0 && (
                <Section title={el.kind === 'event' ? tx.raisedBy : tx.returnedBy}>
                    {commands.map(({ agg, c }) => (
                        <div key={c.id} className="sub">
                            <a onClick={() => onSelect(c.id)}>
                                {names.of(agg)}.{names.of(c)}
                            </a>
                        </div>
                    ))}
                </Section>
            )}
            {typeUses.length > 0 && (
                <Section title={tx.typeUses(typeUses.length)}>
                    {typeUses.map((u) => (
                        <div key={u.key} className="sub">
                            <a onClick={() => onSelect(u.target)}>{u.text}</a>
                        </div>
                    ))}
                </Section>
            )}
            {idUses.length > 0 && (
                <Section title={tx.idUses(idType!.kind === 'ref' ? names.id(idType!.ref) : '', idUses.length)}>
                    {idUses.map((u) => (
                        <div key={u.key} className="sub">
                            <a onClick={() => onSelect(u.target)}>{u.text}</a>
                        </div>
                    ))}
                </Section>
            )}
        </>
    );
}

function CommandList({ title, agg, commands, onSelect }: { title: string; agg: ElementModel; commands: CommandModel[]; onSelect: Select }) {
    const names = useNames();
    const tx = useT();
    return (
        <Section title={title}>
            {commands.length === 0 && <span className="muted">{tx.none}</span>}
            {commands.map((c) => (
                <div key={c.id} className="sub">
                    <a onClick={() => onSelect(c.id)}>
                        {c.factory ? 'create ' : ''}
                        {names.of(c)}
                    </a>
                    <span className="muted small"> {names.transition(agg, c)}</span>
                </div>
            ))}
        </Section>
    );
}

/** `orderId: OrderId, …` (or `注文ID: 注文ID, …`) */
const payloadText = (names: Namer, ev: ElementModel): string =>
    ev.fields.map((f) => `${names.field(f)}: ${names.type(f.type, ev.context)}${f.multiplicity}`).join(', ');

function OutcomeRow({ model, id, onSelect }: { model: DomainModel; id: string; onSelect: Select }) {
    const names = useNames();
    const ev = model.elements[id];
    return (
        <div className="event-row">
            <a onClick={() => onSelect(id)}>{names.id(id)}</a>
            {ev && ev.fields.length > 0 && <div className="muted small mono">{payloadText(names, ev)}</div>}
        </div>
    );
}

/** Events the aggregate's commands may emit (`emits`) or errors they may return (`errors`), with the commands and the payload. */
function AggregateOutcomes({ agg, model, kind, onSelect }: { agg: ElementModel; model: DomainModel; kind: 'emits' | 'errors'; onSelect: Select }) {
    const names = useNames();
    const tx = useT();
    const emitters = new Map<string, CommandModel[]>();
    for (const c of agg.commands ?? []) {
        for (const e of c[kind]) emitters.set(e, [...(emitters.get(e) ?? []), c]);
    }
    if (emitters.size === 0) return null;
    return (
        <Section title={kind === 'emits' ? tx.raises(emitters.size) : tx.returns(emitters.size)}>
            {[...emitters].map(([id, commands]) => {
                const ev = model.elements[id];
                return (
                    <div key={id} className="event-row">
                        <a onClick={() => onSelect(id)}>{names.id(id)}</a>
                        {ev?.doc && <div className="muted small">{ev.doc}</div>}
                        <div className="small">
                            <span className="muted">← </span>
                            {commands.map((c) => (
                                <a key={c.id} className="ref" onClick={() => onSelect(c.id)}>
                                    {names.of(c)}
                                </a>
                            ))}
                        </div>
                        {ev && ev.fields.length > 0 && <div className="muted small mono">{payloadText(names, ev)}</div>}
                    </div>
                );
            })}
        </Section>
    );
}

function DiagnosticList({ items }: { items: Diagnostic[] }) {
    if (items.length === 0) return null;
    return (
        <div className="inspector-diags">
            {items.map((d, i) => (
                <div key={i} className={`diag diag-${d.severity}`}>
                    <code>{d.code}</code> {d.message}
                </div>
            ))}
        </div>
    );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section>
            <h3>{title}</h3>
            {children}
        </section>
    );
}

/**
 * Fields / parameters. 両方: label, name and type; ラベル / 名前: one name column, and the type by its label or
 * its name.
 */
function Fields({ title, fields, ctx, onSelect, empty }: { title: string; fields: FieldModel[]; ctx: string; onSelect: Select; empty?: string }) {
    const names = useNames();
    const tx = useT();
    if (fields.length === 0) {
        return empty ? (
            <Section title={title}>
                <span className="muted">{empty}</span>
            </Section>
        ) : null;
    }
    const marker = (f: FieldModel) => (f.kind === 'owns' ? '◆ ' : f.kind === 'references' ? '→ ' : '');
    return (
        <Section title={title}>
            <table className="fields">
                <tbody>
                    {fields.map((f) => (
                        <tr key={f.name} title={f.doc}>
                            {names.mode === 'both' && (
                                <td className="flabel">
                                    {f.label}
                                    {f.labelSource && f.labelSource !== 'inline' && <span className="label-src">{tx.labelSources[f.labelSource]}</span>}
                                </td>
                            )}
                            <td className={names.mode === 'label' ? 'flabel' : 'fname'}>
                                {marker(f)}
                                {names.mode === 'both' ? f.name : names.field(f)}
                            </td>
                            <td>
                                {f.type.kind === 'ref' && f.type.target ? (
                                    <a onClick={() => onSelect((f.type as { ref: string }).ref)}>{names.type(f.type, ctx)}</a>
                                ) : (
                                    names.type(f.type, ctx)
                                )}
                                {f.multiplicity}
                                {f.target && (
                                    <>
                                        {' '}→{' '}
                                        <a className="ref" onClick={() => onSelect(f.target!)}>
                                            {names.id(f.target)}
                                        </a>
                                    </>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </Section>
    );
}

/**
 * Invariants. With `labelOnly`, an invariant that has a Japanese name is shown by its name alone;
 * the expression is shown only for unnamed ones.
 */
function Invariants({ items, title, labelOnly }: { items: InvariantModel[]; title: string; labelOnly?: boolean }) {
    const names = useNames();
    if (items.length === 0) return null;
    return (
        <Section title={title}>
            {items.map((i) => {
                const nameOnly = labelOnly && !!i.label;
                return (
                    <div key={i.name} className="sub">
                        <strong>{names.of(i)}</strong>
                        {!nameOnly && i.doc && <p className="doc">{i.doc}</p>}
                        {!nameOnly && <code className="block">{i.source}</code>}
                    </div>
                );
            })}
        </Section>
    );
}
