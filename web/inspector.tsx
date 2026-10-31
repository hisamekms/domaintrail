import { PanelRightClose, Undo2 } from 'lucide-react';
import { createContext, useContext, type ReactNode } from 'react';
import type { DisplayMode } from '../src/visualization/domain/graph/ir';
import type { Diagnostic } from '../src/core/diagnostics';
import type { ModelDiff } from '../src/visualization/domain/graph/diff';
import {
    emitSuffix,
    emittedEvents,
    type CommandModel,
    type DomainModel,
    type ElementModel,
    type FieldModel,
    type InvariantModel,
    type Location,
    type TypeExpr,
} from '../src/model/model';
import { dependencyCounts } from '../src/visualization/domain/graph/context-map';
import { contextDependencies, groupByContext, supportingContexts, type ContextDependency } from '../src/model/dependencies';
import { Changes, CommandCard, OldType, OutcomeCard, outcomesOf, PersistenceBadge, PolicyReaction, Requirements } from './behavior';
import { useLang, useT, type ItemKind } from './i18n';
import {
    KIND_ORDER,
    fieldSetUsers,
    inCatalog,
    namer,
    policiesReactingTo,
    policiesRunning,
    resolve,
    selectedFile,
    type Namer,
    type Resolved,
    type Select,
} from './model-utils';
import { ownerElement } from './render';
import { diffRows, rowClass, type RowChange } from './row-diff';
import { SourceView, type SourceFocus } from './source';
import { isStormingSelection, stormingSelectionName } from './storming';
import { usagesOf } from './usages';

export type InspectorTab = 'structure' | 'states' | 'behavior' | 'events' | 'references' | 'source';

/** Where the selected item can be shown in the main area. */
export type RevealTarget = 'contextMap' | 'structure' | 'catalog';

/** Display names in the current mode (ラベル / 名前 / 両方). */
const NamerContext = createContext<Namer>(namer('both', null));
const useNames = (): Namer => useContext(NamerContext);

/**
 * The baseline model and the selected item as it is there (none when it was added): the lists of the tabs mark their
 * added, changed and removed rows against it. Null without a baseline.
 */
const BaseContext = createContext<{ model: DomainModel; r: Resolved | undefined } | null>(null);
const useBase = () => useContext(BaseContext);

export interface InspectorProps {
    model: DomainModel | null;
    mode: DisplayMode;
    selected: string | undefined;
    diagnostics: Diagnostic[];
    diff: ModelDiff;
    /** The model compared with (see `ViewPayload.base`). */
    base: DomainModel | null;
    /** The selected item is shown from `model`, the baseline, as it was removed. */
    removedItem?: boolean;
    sources: { path: string; text: string }[];
    /** Where the source tab (or a selected file) scrolls to. */
    sourceFocus: SourceFocus | undefined;
    /** The state diagram of an aggregate (the 状態遷移 tab). */
    statesView: (aggregateId: string) => ReactNode;
    /** The details of a storming element (`es/…`), under the back and close buttons (`history`). */
    stormingView: (id: string, history: ReactNode) => ReactNode;
    tab: InspectorTab;
    onTab: (tab: InspectorTab) => void;
    onSelect: Select;
    onReveal: (target: RevealTarget, id: string) => void;
    /** Shows one bounded context in the Structure View, with its dependencies as stubs. */
    onFocusContext: (ctx: string) => void;
    /** The selection "back" returns to, if any. */
    backTo: string | undefined;
    onBack: () => void;
    onClose: () => void;
}

/** Tabs that make sense for a selected item, in display order. */
export function tabsFor(r: Resolved): InspectorTab[] {
    switch (r.kind) {
        case 'context':
            return ['structure'];
        case 'state':
            return ['structure', 'states', 'behavior', 'source'];
        case 'command':
            return ['structure', 'states', 'behavior', 'source'];
        case 'element':
            if (r.el.kind === 'aggregate') return ['structure', 'states', 'behavior', 'events', 'references', 'source'];
            return r.el.kind === 'policy' ? ['structure', 'source'] : ['structure', 'references', 'source'];
    }
}

/** Views in which the item appears. */
function revealTargets(r: Resolved): RevealTarget[] {
    const out: RevealTarget[] = [];
    if (r.kind === 'element') {
        if (r.el.kind === 'aggregate' || r.el.kind === 'entity' || r.el.kind === 'valueObject' || r.el.kind === 'union') out.push('structure');
        if (inCatalog(r.el.kind)) out.push('catalog');
    } else if (r.kind === 'context') {
        out.push('contextMap', 'structure');
    }
    return out;
}

export function Inspector(props: InspectorProps) {
    const { model, selected } = props;
    const tx = useT();
    const backName =
        props.backTo &&
        (selectedFile(props.backTo) ?? (isStormingSelection(props.backTo) ? stormingSelectionName(props.backTo) : namer(props.mode, model).id(props.backTo)));
    // its own row above the kind badge: back on the left, close on the right, so the two aren't mistaken for each other
    const history = (
        <div className="history">
            {backName && (
                <button className="back-button" onClick={props.onBack} data-tooltip={tx.backTo(backName)} aria-label={tx.backTo(backName)}>
                    <Undo2 size={14} aria-hidden />
                    <span className="back-name">{backName}</span>
                </button>
            )}
            <button className="icon-button close-button" onClick={props.onClose} data-tooltip={tx.closeInspector} aria-label={tx.closeInspector}>
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
                    {history}
                    <div className="inspector-row">
                        <span className="kind kind-file">{tx.fileKind}</span>
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
    // a storming is shown even without a model (a workspace of .dtes files only, or .dt files that do not parse)
    if (isStormingSelection(selected)) return <div className="inspector">{props.stormingView(selected, history)}</div>;
    if (!model)
        return (
            <div className="inspector">
                <div className="inspector-head">
                    {history}
                    <p className="muted">{tx.noModel}</p>
                </div>
            </div>
        );
    const r = selected ? resolve(model, selected) : undefined;
    // a removed item is shown as it was in the baseline
    if (selected && !r && props.base && resolve(props.base, selected)) return <Inspector {...props} model={props.base} base={null} removedItem />;
    if (!selected || !r) {
        return (
            <div className="inspector">
                <div className="inspector-head">
                    {history}
                    <p className="muted">{selected ? tx.notInModel(selected) : tx.pickElement}</p>
                </div>
            </div>
        );
    }

    const names = namer(props.mode, model);
    const tabs = tabsFor(r);
    const tab = tabs.includes(props.tab) ? props.tab : tabs[0];
    const diags = props.diagnostics.filter((d) => d.elementId === selected || (r.kind === 'element' && d.elementId && ownerElement(d.elementId) === selected));
    const change: RowChange | undefined = props.removedItem
        ? 'removed'
        : props.diff.added.includes(selected)
          ? 'added'
          : props.diff.changed.includes(selected)
            ? 'changed'
            : undefined;
    const head = headOf(r);
    const baseR = props.base && change !== 'added' ? resolve(props.base, selected) : undefined;
    const baseHead = baseR && headOf(baseR);

    const title = names.of({ name: head.name, label: head.label });
    return (
        <NamerContext.Provider value={names}>
            <BaseContext.Provider value={props.base ? { model: props.base, r: baseR } : null}>
                <div className={`inspector${props.removedItem ? ' inspector-removed' : ''}`}>
                    <div className="inspector-head">
                        {history}
                        <div className="inspector-row">
                            <span className={`kind kind-${head.kind}`}>{tx.kinds[head.kind]}</span>
                            {r.kind === 'context' && r.shared && <span className="shared-badge">{tx.shared}</span>}
                            {r.kind === 'element' && r.el.kind === 'event' && <PersistenceBadge persistent={!!r.el.persistent} tx={tx} />}
                            {change && <span className={`change change-${change}`}>{tx[change]}</span>}
                        </div>
                        {baseHead && baseHead.label !== head.label && (
                            <div className="was-line">
                                <del className="was">{props.mode === 'both' ? (baseHead.label ?? baseHead.name) : names.of(baseHead)}</del>
                            </div>
                        )}
                        <h2>{props.mode === 'both' && head.label ? head.label : title}</h2>
                        {props.mode === 'both' && head.label && <div className="canonical-name">{head.name}</div>}
                        {props.removedItem && <p className="muted small">{tx.removedFromBaseline}</p>}
                        {baseHead?.doc && baseHead.doc !== head.doc && (
                            <p className="doc">
                                <del className="was">{baseHead.doc}</del>
                            </p>
                        )}
                        {head.doc && <p className="doc">{head.doc}</p>}
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
            </BaseContext.Provider>
        </NamerContext.Provider>
    );
}

function headOf(r: Resolved): { kind: ItemKind; name: string; label?: string; doc?: string; location?: Location } {
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
    const base = useBase();
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
        const was = base?.r?.kind === 'state' ? base.r : undefined;
        if (tab === 'behavior') {
            const into = (a: ElementModel, name: string) => (a.commands ?? []).filter((c) => c.transitions.some((t) => t.to.includes(name)));
            const outOf = (a: ElementModel, name: string) => (a.commands ?? []).filter((c) => c.transitions.some((t) => t.from.includes(name)));
            return (
                <>
                    <CommandList
                        title={tx.commandsInto}
                        agg={agg}
                        model={model}
                        commands={into(agg, state.name)}
                        base={was && into(was.agg, was.state.name)}
                        onSelect={onSelect}
                    />
                    <CommandList
                        title={tx.commandsOutOf}
                        agg={agg}
                        model={model}
                        commands={outOf(agg, state.name)}
                        base={was && outOf(was.agg, was.state.name)}
                        onSelect={onSelect}
                    />
                </>
            );
        }
        return (
            <>
                <Fields title={tx.stateFields} fields={state.fields} base={was?.state.fields} ctx={agg.context} onSelect={onSelect} empty={tx.noStateFields} />
                <Invariants items={state.invariants} base={was?.state.invariants} title={tx.stateInvariants} labelOnly />
                <p className="muted small">{tx.commonFieldsAt(<a onClick={() => onSelect(agg.id)}>{names.of(agg)}</a>)}</p>
            </>
        );
    }

    if (r.kind === 'command') {
        const { agg, command: c } = r;
        const was = base?.r?.kind === 'command' ? base.r : undefined;
        if (tab === 'behavior') {
            const transition = names.transition(agg, c) || tx.noStates;
            const oldTransition = was && (names.transition(was.agg, was.command) || tx.noStates);
            const emits = diffRows(c.emits, was?.command.emits, (e) => e.event);
            const errors = diffRows(c.errors, was?.command.errors, (e) => e);
            return (
                <>
                    <Section title={tx.transition}>
                        {oldTransition !== undefined && oldTransition !== transition && <del className="was block">{oldTransition}</del>}
                        <code className="block">{transition}</code>
                    </Section>
                    {(c.requires.length > 0 || (was?.command.requires.length ?? 0) > 0) && (
                        <Section title={tx.requirements}>
                            <Requirements c={c} base={was?.command} model={model} names={names} tx={tx} onSelect={onSelect} />
                        </Section>
                    )}
                    {!c.factory && (
                        <Section title={tx.changedFields}>
                            {c.changes.length || was?.command.changes.length ? (
                                <Changes agg={agg} c={c} base={was?.command} names={names} />
                            ) : (
                                <span className="muted">{tx.none}</span>
                            )}
                        </Section>
                    )}
                    <Section title={tx.mayRaise}>
                        {emits.length ? (
                            emits.map(({ item: e, change }, i) => (
                                <OutcomeRow key={i} model={model} id={e.event} suffix={emitSuffix(e)} change={change} onSelect={onSelect} />
                            ))
                        ) : (
                            <span className="muted">{tx.none}</span>
                        )}
                    </Section>
                    <Section title={tx.mayReturn}>
                        {errors.length ? (
                            errors.map(({ item: e, change }) => <OutcomeRow key={e} model={model} id={e} change={change} onSelect={onSelect} />)
                        ) : (
                            <span className="muted">{tx.none}</span>
                        )}
                    </Section>
                    <PolicyList
                        title={tx.triggeredBy}
                        policies={policiesRunning(model, agg.id, c.name)}
                        base={was && base ? policiesRunning(base.model, was.agg.id, was.command.name) : undefined}
                        onSelect={onSelect}
                    />
                </>
            );
        }
        const contract = (m: DomainModel, a: ElementModel, x: CommandModel) =>
            `${x.factory ? 'create ' : ''}command ${x.name}(${x.params.map((p) => `${p.name}: ${namer('name', m).type(p.type, a.context)}${p.multiplicity}`).join(', ')})`;
        const oldContract = was && base && contract(base.model, was.agg, was.command);
        return (
            <>
                <Fields title={tx.params} fields={c.params} base={was?.command.params} ctx={agg.context} onSelect={onSelect} empty={tx.noParams} />
                <Section title={tx.contract}>
                    {oldContract !== undefined && oldContract !== contract(model, agg, c) && <del className="was block">{oldContract}</del>}
                    <code className="block">{contract(model, agg, c)}</code>
                </Section>
            </>
        );
    }

    const el = r.el;
    const was = base?.r?.kind === 'element' ? base.r.el : undefined;
    if (tab === 'behavior') {
        return (
            <>
                <CommandList
                    title={tx.counted(tx.commands, el.commands?.length ?? 0)}
                    agg={el}
                    model={model}
                    commands={el.commands ?? []}
                    base={was && (was.commands ?? [])}
                    onSelect={onSelect}
                />
                <AggregateOutcomes agg={el} was={was} model={model} kind="errors" onSelect={onSelect} />
            </>
        );
    }
    if (tab === 'events') return <AggregateOutcomes agg={el} was={was} model={model} kind="emits" onSelect={onSelect} />;
    if (tab === 'references') return <References model={model} el={el} onSelect={onSelect} />;

    if (el.kind === 'policy') {
        return (
            <Section title={tx.reaction}>
                <PolicyReaction p={el} model={model} names={names} tx={tx} onSelect={onSelect} input />
            </Section>
        );
    }

    // structure
    return (
        <>
            {el.base && (
                <p>
                    {el.kind === 'id' ? tx.identifier : tx.kinds.primitive}
                    {tx.separator}
                    {tx.baseType}: {was?.base && was.base !== el.base && <del className="was">{names.primitive(was.base)}</del>}
                    <code>{names.primitive(el.base)}</code>
                </p>
            )}
            {el.verified && <VerifiedBody el={el} onSelect={onSelect} />}
            {el.values && (
                <Section title={tx.values}>
                    <div className="chips">
                        {diffRows(el.values, was?.values, (v) => v).map(({ item: v, change }) => (
                            <code key={v} className={rowClass(change)}>
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
                    {diffRows(el.variants ?? [], was?.variants, (v) => v.name).map(({ item: v, change }) => {
                        // the rows of an added or removed variant are not marked one by one
                        const old = change === 'changed' || !change ? was?.variants?.find((x) => x.name === v.name) : undefined;
                        return (
                            <div key={v.name} title={v.doc} className={rowClass(change)}>
                                <Fields
                                    title={`${names.of(v)}`}
                                    fields={v.fields}
                                    base={old?.fields}
                                    ctx={el.context}
                                    onSelect={onSelect}
                                    empty={tx.noFields}
                                />
                                <Invariants items={v.invariants} base={old?.invariants} title={tx.variantInvariants(names.of(v))} />
                            </div>
                        );
                    })}
                </>
            )}
            {el.kind !== 'id' && el.kind !== 'primitive' && el.kind !== 'verified' && el.kind !== 'enum' && el.kind !== 'union' && (
                <Fields
                    title={el.states?.length ? tx.commonFields : el.kind === 'event' || el.kind === 'error' ? tx.payload : tx.fields}
                    fields={el.fields}
                    base={was?.fields}
                    ctx={el.context}
                    onSelect={onSelect}
                    empty={tx.noFields}
                />
            )}
            {(el.kind === 'aggregate' || el.kind === 'entity' || el.kind === 'valueObject') && (
                <Invariants
                    items={el.invariants}
                    base={was?.invariants}
                    title={el.states?.length ? tx.allStateInvariants : tx.invariants}
                    labelOnly={el.kind === 'aggregate'}
                />
            )}
            {(el.kind === 'id' || el.kind === 'primitive') && <Invariants items={el.invariants} base={was?.invariants} title={tx.valueInvariants} />}
            {((el.states?.length ?? 0) > 0 || (was?.states?.length ?? 0) > 0) && (
                <Section title={tx.counted(tx.states, el.states?.length ?? 0)}>
                    {diffRows(el.states ?? [], was?.states, (s) => s.name).map(({ item: s, change }) => (
                        <div key={s.id} className={rowClass(change, 'sub')}>
                            <a onClick={() => onSelect(s.id)}>{names.of(s)}</a>
                            {s.fields.length > 0 && <span className="muted small"> {s.fields.map((f) => names.field(f)).join(', ')}</span>}
                        </div>
                    ))}
                </Section>
            )}
        </>
    );
}

/** What a verified type verifies, the context its check needs and the errors of its factory. */
function VerifiedBody({ el, onSelect }: { el: ElementModel; onSelect: Select }) {
    const names = useNames();
    const tx = useT();
    const v = el.verified!;
    const type = (t: TypeExpr) => (t.kind === 'ref' ? <a onClick={() => onSelect(t.ref)}>{names.id(t.ref)}</a> : <code>{names.primitive(t.name)}</code>);
    return (
        <>
            <p className="muted small">{tx.verifiedNote}</p>
            <p>
                {tx.verifiedOf}: {type(v.of)}
            </p>
            {v.for && (
                <p>
                    {tx.verifiedFor}: {type(v.for.type)}
                    {v.for.optional && <span className="muted small"> {tx.verifiedOptional}</span>}
                </p>
            )}
            {v.errors.length > 0 && (
                <Section title={tx.verifiedErrors}>
                    {v.errors.map((e) => (
                        <div key={e} className="sub">
                            <a onClick={() => onSelect(e)}>{names.id(e)}</a>
                        </div>
                    ))}
                </Section>
            )}
        </>
    );
}

/** Dependencies of a context on others (or of others on it), one collapsible group per context with every use. */
function Dependencies({
    title,
    groups,
    other,
    onSelect,
}: {
    title: string;
    groups: ContextDependency[];
    other: (g: ContextDependency) => string;
    onSelect: Select;
}) {
    const names = useNames();
    const tx = useT();
    const lang = useLang();
    if (groups.length === 0) return null;
    return (
        <Section title={tx.counted(title, groups.length)}>
            {groups.map((g) => (
                <details key={other(g)} className="deps">
                    <summary>
                        <a onClick={() => onSelect(other(g))}>{names.id(other(g))}</a>
                        <span className="muted small"> {dependencyCounts(g.ids, g.types, g.events)[lang][names.mode]}</span>
                    </summary>
                    {g.uses.map((u, i) => (
                        <div key={i} className="sub small">
                            <a onClick={() => onSelect(u.source)}>{names.id(u.source)}</a>
                            <span className="muted">.{u.path} → </span>
                            <a onClick={() => onSelect(u.target)}>{names.id(u.target)}</a>
                            <span className={`dep-kind dep-${u.kind}`}>
                                {u.kind === 'id' ? 'ID' : u.kind === 'event' ? tx.eventDependency : tx.typeDependency}
                            </span>
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
    const base = useBase();
    const els = Object.values(model.elements).filter((e) => e.context === ctx);
    // the context's elements in the baseline, when it was there
    const baseEls = base?.r ? Object.values(base.model.elements).filter((e) => e.context === ctx) : undefined;
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
                const rows = diffRows(
                    items,
                    baseEls?.filter((e) => e.kind === kind),
                    (e) => e.id,
                );
                if (!rows.length) return null;
                return (
                    <Section key={kind} title={tx.counted(tx.kinds[kind], items.length)}>
                        {rows.map(({ item: e, change }) => (
                            <div key={e.id} className={rowClass(change, 'sub')}>
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
        (a.commands ?? []).filter((c) => emittedEvents(c).includes(el.id) || c.errors.includes(el.id)).map((c) => ({ agg: a, c })),
    );
    const users = el.kind === 'fieldSet' ? fieldSetUsers(model, el.id) : [];
    const verifiedTypes = Object.values(model.elements).filter((v) => v.verified);
    const isRef = (t: TypeExpr | undefined) => t?.kind === 'ref' && t.ref === el.id;
    const factories = verifiedTypes.filter((v) => v.verified!.errors.includes(el.id));
    const verifiedAs = verifiedTypes.filter((v) => isRef(v.verified!.of));
    const contextOf = verifiedTypes.filter((v) => isRef(v.verified!.for?.type));
    const verifiedLists: [string, ElementModel[]][] = [
        [tx.returnedByVerified, factories],
        [tx.verifiedAs, verifiedAs],
        [tx.contextOf, contextOf],
    ];
    const policies = el.kind === 'event' ? policiesReactingTo(model, el.id) : [];
    if (!typeUses.length && !idUses.length && !commands.length && !users.length && !policies.length && !verifiedLists.some(([, l]) => l.length))
        return <p className="muted">{tx.unreferenced}</p>;
    return (
        <>
            <PolicyList title={tx.reactedToBy} policies={policies} onSelect={onSelect} />
            {users.length > 0 && (
                <Section title={tx.fieldSetUsers(users.length)}>
                    {users.map((u) => (
                        <div key={u.id} className="sub">
                            <a onClick={() => onSelect(u.id)}>{names.id(u.id)}</a>
                            <span className="muted small"> {tx.kinds[u.kind]}</span>
                        </div>
                    ))}
                </Section>
            )}
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
            {verifiedLists.map(
                ([title, list]) =>
                    list.length > 0 && (
                        <Section key={title} title={title}>
                            {list.map((v) => (
                                <div key={v.id} className="sub">
                                    <a onClick={() => onSelect(v.id)}>{names.id(v.id)}</a>
                                </div>
                            ))}
                        </Section>
                    ),
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

/** Policies as links, each with its reaction; nothing when there are none. */
function PolicyList({ title, policies, base, onSelect }: { title: string; policies: ElementModel[]; base?: ElementModel[]; onSelect: Select }) {
    const names = useNames();
    if (!policies.length && !base?.length) return null;
    return (
        <Section title={title}>
            {diffRows(policies, base, (p) => p.id).map(({ item: p, change }) => (
                <div key={p.id} className={rowClass(change, 'sub')}>
                    <a onClick={() => onSelect(p.id)}>{names.of(p)}</a>
                    {p.policy && (
                        <span className="muted small mono">
                            {' '}
                            when {names.id(p.policy.event)} → {names.id(`${p.policy.aggregate}:${p.policy.command}`)}
                        </span>
                    )}
                </div>
            ))}
        </Section>
    );
}

/** Command cards; with `base` (the baseline's commands), added, changed and removed ones are marked. */
function CommandList({
    title,
    agg,
    model,
    commands,
    base,
    onSelect,
}: {
    title: string;
    agg: ElementModel;
    model: DomainModel;
    commands: CommandModel[];
    base?: CommandModel[];
    onSelect: Select;
}) {
    const names = useNames();
    const tx = useT();
    const baseline = useBase();
    const rows = diffRows(commands, base, (c) => c.name);
    return (
        <Section title={title}>
            {rows.length === 0 && <span className="muted">{tx.none}</span>}
            {rows.map(({ item: c, change }) => (
                <CommandCard
                    key={`${c.id}:${change ?? ''}`}
                    agg={agg}
                    c={c}
                    model={model}
                    names={names}
                    tx={tx}
                    onSelect={onSelect}
                    base={base && baseline ? { model: baseline.model, item: base.find((x) => x.name === c.name), change } : undefined}
                />
            ))}
        </Section>
    );
}

/** `orderId: OrderId, …` (or `注文ID: 注文ID, …`) */
const payloadText = (names: Namer, ev: ElementModel): string =>
    ev.fields.map((f) => `${names.field(f)}: ${names.type(f.type, ev.context)}${f.multiplicity}`).join(', ');

/** An event or error of a command; `suffix` is an event's multiplicity and `when` as written (`[1..*] when -> Draft`). */
function OutcomeRow({ model, id, suffix, change, onSelect }: { model: DomainModel; id: string; suffix?: string; change?: RowChange; onSelect: Select }) {
    const names = useNames();
    const ev = model.elements[id];
    return (
        <div className={rowClass(change, 'event-row')}>
            <a onClick={() => onSelect(id)}>{names.id(id)}</a>
            {suffix && <code className="emit-when"> {suffix}</code>}
            {ev && ev.fields.length > 0 && <div className="muted small mono">{payloadText(names, ev)}</div>}
        </div>
    );
}

/** Events the aggregate's commands may emit (`emits`) or errors they may return (`errors`), with the commands and the payload. */
function AggregateOutcomes({
    agg,
    was,
    model,
    kind,
    onSelect,
}: {
    agg: ElementModel;
    /** The aggregate in the baseline: added, changed and removed events or errors are marked against its own. */
    was?: ElementModel;
    model: DomainModel;
    kind: 'emits' | 'errors';
    onSelect: Select;
}) {
    const names = useNames();
    const tx = useT();
    const baseline = useBase();
    const outcomes = outcomesOf(agg.commands ?? [], kind);
    const before = was && outcomesOf(was.commands ?? [], kind);
    const rows = diffRows([...outcomes.keys()], before && [...before.keys()], (id) => id);
    // the errors are a part of the behaviour tab, but the events have a tab of their own, which says so when there are none
    if (rows.length === 0 && kind === 'errors') return null;
    return (
        <Section title={kind === 'emits' ? tx.raises(outcomes.size) : tx.returns(outcomes.size)}>
            {rows.length === 0 && <span className="muted">{tx.none}</span>}
            {rows.map(({ item: id, change }) => (
                <OutcomeCard
                    key={id}
                    id={id}
                    commands={outcomes.get(id) ?? before?.get(id) ?? []}
                    model={model}
                    names={names}
                    tx={tx}
                    onSelect={onSelect}
                    base={before && baseline ? { model: baseline.model, item: baseline.model.elements[id], change } : undefined}
                />
            ))}
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
function Fields({
    title,
    fields,
    base,
    ctx,
    onSelect,
    empty,
}: {
    title: string;
    fields: FieldModel[];
    /** The baseline's fields: added, changed and removed ones are marked, a changed type shows the old one struck through. */
    base?: FieldModel[];
    ctx: string;
    onSelect: Select;
    empty?: string;
}) {
    const names = useNames();
    const tx = useT();
    const rows = diffRows(fields, base, (f) => f.name);
    if (rows.length === 0) {
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
                    {rows.map(({ item: f, change, before }) => (
                        <tr key={`${f.name}:${change ?? ''}`} title={f.doc} className={rowClass(change)}>
                            {names.mode === 'both' && (
                                <td className="flabel">
                                    {before && before.label !== f.label && before.label && <del className="was">{before.label}</del>}
                                    {f.label}
                                    {f.labelSource && f.labelSource !== 'inline' && <span className="label-src">{tx.labelSources[f.labelSource]}</span>}
                                </td>
                            )}
                            <td className={names.mode === 'label' ? 'flabel' : 'fname'}>
                                {marker(f)}
                                {names.mode === 'both' ? f.name : names.field(f)}
                            </td>
                            <td>
                                {before && <OldType before={before} f={f} ctx={ctx} names={names} />}
                                {f.type.kind === 'ref' && f.type.target ? (
                                    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the condition above checks that the type is a 'ref' (lost in the closure)
                                    <a onClick={() => onSelect((f.type as { ref: string }).ref)}>{names.type(f.type, ctx)}</a>
                                ) : (
                                    names.type(f.type, ctx)
                                )}
                                {f.multiplicity}
                                {f.target && (
                                    <>
                                        {' '}
                                        →{' '}
                                        <a className="ref" onClick={() => onSelect(f.target!)}>
                                            {names.id(f.target)}
                                        </a>
                                    </>
                                )}
                                {f.fieldSet && <FieldOrigin id={f.fieldSet} onSelect={onSelect} />}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </Section>
    );
}

/** The field set a field comes from, faded after its type. */
function FieldOrigin({ id, onSelect }: { id: string; onSelect: Select }) {
    const names = useNames();
    const tx = useT();
    return (
        <a className="field-origin" onClick={() => onSelect(id)} data-tooltip={tx.fromFieldSet(names.id(id))}>
            {names.short(id)}
        </a>
    );
}

/**
 * Invariants. With `labelOnly`, an invariant that has a Japanese name is shown by its name alone;
 * the expression is shown only for unnamed ones.
 */
export function Invariants({
    items,
    base,
    title,
    labelOnly,
}: {
    items: InvariantModel[];
    /** The baseline's invariants: added, changed and removed ones are marked, a changed expression shows the old one struck through. */
    base?: InvariantModel[];
    title: string;
    labelOnly?: boolean;
}) {
    const names = useNames();
    const tx = useT();
    const rows = diffRows(items, base, (i) => i.name);
    if (rows.length === 0) return null;
    return (
        <Section title={title}>
            {rows.map(({ item: i, change, before }) => {
                const nameOnly = labelOnly && !!i.label;
                return (
                    <div key={`${i.name}:${change ?? ''}`} className={rowClass(change, 'sub')}>
                        <strong>{names.of(i)}</strong>
                        {!nameOnly && i.doc && <p className="doc">{i.doc}</p>}
                        {!nameOnly && before?.source !== undefined && before.source !== i.source && <del className="was block">{before.source}</del>}
                        {!nameOnly && (i.source !== undefined ? <code className="block">{i.source}</code> : <p className="not-in-dsl">{tx.notInDsl}</p>)}
                    </div>
                );
            })}
        </Section>
    );
}
