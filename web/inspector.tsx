import { PanelRightClose } from 'lucide-react';
import { createContext, useContext, type ReactNode } from 'react';
import type { DisplayMode } from '../src/graph/ir';
import type { Diagnostic } from '../src/core/diagnostics';
import type { ModelDiff } from '../src/graph/diff';
import type { CommandModel, DomainModel, ElementModel, FieldModel, InvariantModel, Location } from '../src/model/model';
import { dependencyCounts } from '../src/graph/context-map';
import { contextDependencies, groupByContext, supportingContexts, type ContextDependency } from '../src/model/dependencies';
import { highlight } from './highlight';
import { KIND_GROUPS, KIND_LABEL, namer, resolve, type Namer, type Resolved, type Select } from './model-utils';
import { ownerElement } from './render';
import { CodeLines, CopyLocation } from './source';
import { usagesOf } from './usages';

export type InspectorTab = 'structure' | 'behavior' | 'references' | 'source';
const TAB_LABEL: Record<InspectorTab, string> = { structure: '構造', behavior: '振る舞い', references: '参照', source: 'ソース' };

/** Where the selected item can be shown in the main area. */
export type RevealTarget = 'contextMap' | 'structure' | 'states' | 'primitives' | 'source';

/** Display names in the current mode (日本語 / English / 両方). */
const NamerContext = createContext<Namer>(namer('both', null));
const useNames = (): Namer => useContext(NamerContext);

export interface InspectorProps {
    model: DomainModel | null;
    mode: DisplayMode;
    selected: string | undefined;
    diagnostics: Diagnostic[];
    diff: ModelDiff;
    sources: { path: string; text: string }[];
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
            return ['structure', 'behavior', 'source'];
        case 'command':
            return ['structure', 'behavior', 'source'];
        case 'element':
            return r.el.kind === 'aggregate' ? ['structure', 'behavior', 'references', 'source'] : ['structure', 'references', 'source'];
    }
}

/** Views in which the item appears. */
function revealTargets(r: Resolved): RevealTarget[] {
    const out: RevealTarget[] = [];
    if (r.kind === 'element') {
        if (r.el.kind === 'aggregate' || r.el.kind === 'entity' || r.el.kind === 'valueObject' || r.el.kind === 'union') out.push('structure');
        if (r.el.kind === 'aggregate') out.push('states');
        if (r.el.kind === 'primitive' || r.el.kind === 'id' || r.el.kind === 'enum') out.push('primitives');
        out.push('source');
    } else if (r.kind === 'context') {
        out.push('contextMap', 'structure');
    } else if (r.kind === 'state' || r.kind === 'command') {
        out.push('states', 'source');
    }
    return out;
}

const REVEAL_LABEL: Record<RevealTarget, string> = { contextMap: 'コンテキストマップ', structure: '構造図', states: '状態遷移', primitives: 'Primitives', source: 'ソース' };

export function Inspector(props: InspectorProps) {
    const { model, selected } = props;
    const history = (
        <div className="history">
            <button disabled={!props.canBack} onClick={props.onBack} title="戻る" aria-label="戻る">
                ←
            </button>
            <button disabled={!props.canForward} onClick={props.onForward} title="進む" aria-label="進む">
                →
            </button>
            <button className="icon-button" onClick={props.onClose} title="インスペクタを閉じる" aria-label="インスペクタを閉じる">
                <PanelRightClose size={16} aria-hidden />
            </button>
        </div>
    );
    if (!model)
        return (
            <div className="inspector">
                <div className="inspector-head">
                    <div className="inspector-row">{history}</div>
                    <p className="muted">モデルがまだありません。</p>
                </div>
            </div>
        );
    const r = selected ? resolve(model, selected) : undefined;
    if (!selected || !r) {
        return (
            <div className="inspector">
                <div className="inspector-head">
                    <div className="inspector-row">{history}</div>
                    <p className="muted">{selected ? `${selected} は現在のモデルにありません。` : 'エクスプローラや図で要素を選ぶと、ここに詳細が出ます。'}</p>
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
                    {r.kind === 'context' && r.shared && <span className="shared-badge">共有</span>}
                    {change && <span className={`change change-${change}`}>{change === 'added' ? '追加' : '変更'}</span>}
                    {history}
                </div>
                <h2>{props.mode === 'both' && head.label ? head.label : title}</h2>
                {props.mode === 'both' && head.label && <div className="en-name">{head.name}</div>}
                {head.doc && <p className="doc">{head.doc}</p>}
                {head.location && (
                    <div className="inspector-loc">
                        <CopyLocation loc={head.location} />
                    </div>
                )}
                {revealTargets(r).length > 0 && (
                    <div className="reveal">
                        <span className="muted small">見る:</span>
                        {revealTargets(r).map((t) => (
                            <button key={t} onClick={() => props.onReveal(t, selected)}>
                                {REVEAL_LABEL[t]}
                            </button>
                        ))}
                    </div>
                )}
                {diags.length > 0 && (
                    <div className="inspector-diags">
                        {diags.map((d, i) => (
                            <div key={i} className={`diag diag-${d.severity}`}>
                                <code>{d.code}</code> {d.message}
                            </div>
                        ))}
                    </div>
                )}
            </div>
            {tabs.length > 1 && (
                <div className="subtabs" role="tablist">
                    {tabs.map((t) => (
                        <button key={t} role="tab" aria-selected={t === tab} className={t === tab ? 'active' : ''} onClick={() => props.onTab(t)}>
                            {TAB_LABEL[t]}
                        </button>
                    ))}
                </div>
            )}
            <div className="inspector-body">
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
    if (!model) return null;
    if (tab === 'source') {
        const loc = headOf(r).location;
        return loc ? <SourceSnippet loc={loc} sources={props.sources} onOpen={() => props.onReveal('source', props.selected!)} /> : null;
    }

    if (r.kind === 'context') return <ContextBody model={model} ctx={r.name} onSelect={onSelect} onFocus={props.onFocusContext} />;

    if (r.kind === 'state') {
        const { agg, state } = r;
        if (tab === 'behavior') {
            const incoming = (agg.commands ?? []).filter((c) => c.to.includes(state.name));
            const outgoing = (agg.commands ?? []).filter((c) => c.from.includes(state.name));
            return (
                <>
                    <CommandList title="この State に入る Command" agg={agg} commands={incoming} onSelect={onSelect} />
                    <CommandList title="この State から出る Command" agg={agg} commands={outgoing} onSelect={onSelect} />
                </>
            );
        }
        return (
            <>
                <Fields title="State 固有フィールド" fields={state.fields} ctx={agg.context} onSelect={onSelect} empty="State 固有のフィールドはありません。" />
                <Invariants items={state.invariants} title="Invariant（この State のみ）" labelOnly />
                <p className="muted small">
                    共通フィールドは集約 <a onClick={() => onSelect(agg.id)}>{names.of(agg)}</a> を参照。
                </p>
            </>
        );
    }

    if (r.kind === 'command') {
        const { agg, command: c } = r;
        if (tab === 'behavior') {
            return (
                <>
                    <Section title="遷移">
                        <code className="block">{names.transition(agg, c) || '（State なし）'}</code>
                    </Section>
                    <Section title="発生し得る Event（0 件以上）">
                        {c.emits.length ? c.emits.map((e) => <OutcomeRow key={e} model={model} id={e} onSelect={onSelect} />) : <span className="muted">なし</span>}
                    </Section>
                    <Section title="返し得る Error">
                        {c.errors.length ? c.errors.map((e) => <OutcomeRow key={e} model={model} id={e} onSelect={onSelect} />) : <span className="muted">なし</span>}
                    </Section>
                </>
            );
        }
        return (
            <>
                <Fields title="パラメータ" fields={c.params} ctx={agg.context} onSelect={onSelect} empty="パラメータはありません。" />
                <Section title="契約">
                    <code className="block">
                        {c.factory ? 'create ' : ''}command {c.name}({c.params.map((p) => `${p.name}: ${namer('en', model).type(p.type, agg.context)}${p.multiplicity}`).join(', ')})
                    </code>
                </Section>
            </>
        );
    }

    const el = r.el;
    if (tab === 'behavior') {
        return (
            <>
                <CommandList title={`Command（${el.commands?.length ?? 0}）`} agg={el} commands={el.commands ?? []} onSelect={onSelect} />
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
                    {el.kind === 'id' ? 'Domain Primitive（識別子）' : 'Domain Primitive'} ／ 基底型: <code>{names.primitive(el.base)}</code>
                </p>
            )}
            {el.values && (
                <Section title="値">
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
                        判別子: <code>{el.discriminator}</code>
                        {el.tagType && (
                            <>
                                {' '}／ 値: <a onClick={() => onSelect(el.tagType!)}>{names.id(el.tagType)}</a>
                            </>
                        )}
                    </p>
                    {(el.variants ?? []).map((v) => (
                        <div key={v.name} title={v.doc}>
                            <Fields title={`${names.of(v)}`} fields={v.fields} ctx={el.context} onSelect={onSelect} empty="フィールドはありません。" />
                            <Invariants items={v.invariants} title={`Invariant（${names.of(v)}）`} />
                        </div>
                    ))}
                </>
            )}
            {el.kind !== 'id' && el.kind !== 'primitive' && el.kind !== 'enum' && el.kind !== 'union' && (
                <Fields
                    title={el.states?.length ? '共通フィールド' : el.kind === 'event' || el.kind === 'error' ? 'ペイロード' : 'フィールド'}
                    fields={el.fields}
                    ctx={el.context}
                    onSelect={onSelect}
                    empty="フィールドはありません。"
                />
            )}
            {(el.kind === 'aggregate' || el.kind === 'entity' || el.kind === 'valueObject') && (
                <Invariants items={el.invariants} title={el.states?.length ? 'Invariant（全State共通）' : 'Invariant'} labelOnly={el.kind === 'aggregate'} />
            )}
            {(el.kind === 'id' || el.kind === 'primitive') && <Invariants items={el.invariants} title="Invariant（適用: 値（value））" />}
            {el.states && el.states.length > 0 && (
                <Section title={`State（${el.states.length}）`}>
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
    if (groups.length === 0) return null;
    return (
        <Section title={`${title}（${groups.length}）`}>
            {groups.map((g) => (
                <details key={other(g)} className="deps">
                    <summary>
                        <a onClick={() => onSelect(other(g))}>{names.id(other(g))}</a>
                        <span className="muted small"> {dependencyCounts(g.ids, g.types)[names.mode]}</span>
                    </summary>
                    {g.uses.map((u, i) => (
                        <div key={i} className="sub small">
                            <a onClick={() => onSelect(u.source)}>{names.id(u.source)}</a>
                            <span className="muted">.{u.path} → </span>
                            <a onClick={() => onSelect(u.target)}>{names.id(u.target)}</a>
                            <span className={`dep-kind dep-${u.kind}`}>{u.kind === 'id' ? 'ID' : '型'}</span>
                        </div>
                    ))}
                </details>
            ))}
        </Section>
    );
}

function ContextBody({ model, ctx, onSelect, onFocus }: { model: DomainModel; ctx: string; onSelect: Select; onFocus: (ctx: string) => void }) {
    const names = useNames();
    const els = Object.values(model.elements).filter((e) => e.context === ctx);
    const terms = model.terms[ctx] ?? [];
    const groups = groupByContext(contextDependencies(model));
    return (
        <>
            {!supportingContexts(model).has(ctx) && (
                <p>
                    <button onClick={() => onFocus(ctx)}>この BC だけを構造図で見る</button>
                </p>
            )}
            <Dependencies title="依存先（この BC が使う）" groups={groups.filter((g) => g.from === ctx)} other={(g) => g.to} onSelect={onSelect} />
            <Dependencies title="依存元（この BC を使う）" groups={groups.filter((g) => g.to === ctx)} other={(g) => g.from} onSelect={onSelect} />
            {KIND_GROUPS.map(({ kind, title }) => {
                const items = els.filter((e) => e.kind === kind);
                if (!items.length) return null;
                return (
                    <Section key={kind} title={`${title}（${items.length}）`}>
                        {items.map((e) => (
                            <div key={e.id} className="sub">
                                <a onClick={() => onSelect(e.id)}>{names.of(e)}</a>
                            </div>
                        ))}
                    </Section>
                );
            })}
            {terms.length > 0 && (
                <Section title="用語集（terms）">
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
    const typeUses = usagesOf(model, el.id, names.of);
    const idType = el.fields.find((f) => f.name === 'id' && f.type.kind === 'ref')?.type;
    const idUses = el.kind === 'aggregate' && idType?.kind === 'ref' ? usagesOf(model, idType.ref, names.of).filter((u) => u.target !== el.id) : [];
    const commands = Object.values(model.elements).flatMap((a) =>
        (a.commands ?? []).filter((c) => c.emits.includes(el.id) || c.errors.includes(el.id)).map((c) => ({ agg: a, c })),
    );
    if (!typeUses.length && !idUses.length && !commands.length) return <p className="muted">どこからも参照されていません。</p>;
    return (
        <>
            {commands.length > 0 && (
                <Section title={el.kind === 'event' ? '発生させる Command' : '返す Command'}>
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
                <Section title={`型として使われている場所（${typeUses.length}）`}>
                    {typeUses.map((u) => (
                        <div key={u.key} className="sub">
                            <a onClick={() => onSelect(u.target)}>{u.text}</a>
                        </div>
                    ))}
                </Section>
            )}
            {idUses.length > 0 && (
                <Section title={`ID（${idType!.kind === 'ref' ? names.id(idType!.ref) : ''}）で参照している場所（${idUses.length}）`}>
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
    return (
        <Section title={title}>
            {commands.length === 0 && <span className="muted">なし</span>}
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
    const emitters = new Map<string, CommandModel[]>();
    for (const c of agg.commands ?? []) {
        for (const e of c[kind]) emitters.set(e, [...(emitters.get(e) ?? []), c]);
    }
    if (emitters.size === 0) return null;
    return (
        <Section title={`${kind === 'emits' ? '発生させる Event' : '返し得る Error'}（${emitters.size}）`}>
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

const SNIPPET_LINES = 60;

/** The DSL declaration of the selected item. */
function SourceSnippet({ loc, sources, onOpen }: { loc: Location; sources: { path: string; text: string }[]; onOpen: () => void }) {
    const source = sources.find((s) => s.path === loc.file);
    if (!source) return null;
    const lines = highlight(source.text);
    const to = Math.min(loc.endLine, loc.line + SNIPPET_LINES - 1);
    return (
        <>
            <div className="snippet">
                <CodeLines lines={lines} from={loc.line} to={to} />
            </div>
            {to < loc.endLine && (
                <p className="muted small">
                    … 残り {loc.endLine - to} 行は <a onClick={onOpen}>Source ビュー</a>で確認できます。
                </p>
            )}
        </>
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

const LABEL_SOURCE = { term: '用語', type: '型' } as const;

/**
 * Fields / parameters. 両方: Japanese name, English name and type; 日本語 / English: one name column, and the type
 * in that language.
 */
function Fields({ title, fields, ctx, onSelect, empty }: { title: string; fields: FieldModel[]; ctx: string; onSelect: Select; empty?: string }) {
    const names = useNames();
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
                                    {f.labelSource && f.labelSource !== 'inline' && <span className="label-src">{LABEL_SOURCE[f.labelSource]}</span>}
                                </td>
                            )}
                            <td className={names.mode === 'ja' ? 'flabel' : 'fname'}>
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
