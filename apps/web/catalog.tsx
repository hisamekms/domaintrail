import { Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DomainModel, ElementModel, FieldModel, InvariantModel, ModelDiff } from '@domaintrail/modeling';
import type { Diagnostic } from '@domaintrail/kernel';
import type { DisplayMode } from '@domaintrail/visualization';
import { useT, type Messages } from './i18n';
import { PersistenceBadge } from './behavior';
import { ContextList } from './context-picker';
import {
    CATALOG_SECTIONS,
    catalogSections,
    commandsWithOutcome,
    fieldSetUsers,
    filterCatalog,
    isCatalogFiltered,
    namer,
    orderedContexts,
    policiesReactingTo,
    policyTarget,
    type CatalogFilter,
    type CatalogSection,
    type Namer,
} from './model-utils';
import { ownerElement } from './render';
import { usagesOf } from './usages';
import { shownKinds, toggleKind } from './view/filters';
import { FilterSection } from './view/toolbar';

interface CatalogProps {
    model: DomainModel;
    mode: DisplayMode;
    diff: ModelDiff;
    diagnostics: Diagnostic[];
    selected: string | undefined;
    onSelect: (id: string) => void;
}

/** The catalog's filter (text, kinds and contexts), kept by the page while it is open: never remembered across reloads. */
export function useCatalogFilter(): { filter: CatalogFilter; setFilter: (filter: CatalogFilter) => void } {
    // not remembered, so that a reload never hides elements without saying so
    const [filter, setFilter] = useState<CatalogFilter>({ query: '', sections: [], contexts: null });
    return { filter, setFilter };
}

/** The catalog's text filter, at the left end of the view toolbar. */
export function CatalogSearch(props: { filter: CatalogFilter; onChange: (filter: CatalogFilter) => void }) {
    const { filter, onChange } = props;
    const t = useT();
    const setQuery = (query: string): void => onChange({ ...filter, query });
    return (
        <div className="explorer-filter view-search">
            <Search size={14} aria-hidden />
            <input
                value={filter.query}
                placeholder={t.filter}
                aria-label={t.filter}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Escape') setQuery('');
                }}
            />
            {filter.query && (
                <button className="icon-button" onClick={() => setQuery('')} data-tooltip={t.clearFilter} aria-label={t.clearFilter}>
                    <X size={14} aria-hidden />
                </button>
            )}
        </div>
    );
}

/** The catalog's part of the 絞り込み popover: the contexts and the kinds shown (none chosen: every kind). */
export function CatalogFilters(props: { model: DomainModel; mode: DisplayMode; filter: CatalogFilter; onChange: (filter: CatalogFilter) => void }) {
    const { model, filter, onChange } = props;
    const t = useT();
    const contextList = orderedContexts(model);
    const keys = CATALOG_SECTIONS.map((s) => s.key);
    const shown = shownKinds(keys, filter.sections);
    const allKinds = filter.sections.length === 0;
    const checkAll = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (checkAll.current) checkAll.current.indeterminate = !allKinds;
    });
    return (
        <>
            <FilterSection title={t.filters.contexts}>
                <ContextList
                    contexts={contextList}
                    labels={model.contextLabels}
                    selected={filter.contexts ?? contextList}
                    mode={props.mode}
                    onChange={(cs) => onChange({ ...filter, contexts: cs.length === contextList.length ? null : cs })}
                />
            </FilterSection>
            <FilterSection title={t.filters.kinds}>
                <div className="kind-list" role="group" aria-label={t.catalogKinds}>
                    <label className="check kind-list-all">
                        <input ref={checkAll} type="checkbox" checked={allKinds} disabled={allKinds} onChange={() => onChange({ ...filter, sections: [] })} />
                        {t.filters.allKinds}
                    </label>
                    {CATALOG_SECTIONS.map((s) => {
                        const on = shown.includes(s.key);
                        return (
                            <label key={s.key} className="check">
                                <input
                                    type="checkbox"
                                    checked={on}
                                    // the last kind shown stays: none chosen would show them all
                                    disabled={on && shown.length === 1}
                                    onChange={() => onChange({ ...filter, sections: toggleKind(keys, filter.sections, s.key) })}
                                />
                                <span className={`kind-dot kind-${s.kinds[0]}`} aria-hidden />
                                {t.catalogSections[s.key]}
                            </label>
                        );
                    })}
                </div>
            </FilterSection>
        </>
    );
}

/**
 * Cards to look over the model's elements, one section per kind of element.
 * The filter (text, kinds and contexts, chosen in the view toolbar) hides what does not match, sections included.
 */
export function Catalog(props: CatalogProps & { filter: CatalogFilter }) {
    const { model, filter, ...rest } = props;
    const root = useRef<HTMLDivElement>(null);
    const t = useT();
    const filtering = isCatalogFiltered(filter);
    const all = catalogSections(model);
    const sections = filterCatalog(all, filter).filter((s) => !filtering || s.shown > 0);
    const names = namer(props.mode, model);
    const shared = new Set(model.sharedContexts);
    const severity = new Map<string, 'error' | 'warning'>();
    for (const d of props.diagnostics) {
        if (!d.elementId) continue;
        const id = ownerElement(d.elementId);
        if (severity.get(id) !== 'error') severity.set(id, d.severity);
    }

    // Bring the selected card into view, e.g. when it was revealed from the explorer.
    useEffect(() => {
        if (props.selected) root.current?.querySelector(`[data-card="${CSS.escape(props.selected)}"]`)?.scrollIntoView({ block: 'nearest' });
    }, [props.selected]);

    return (
        <div className="catalog" ref={root}>
            {sections.length === 0 && <p className="muted">{t.catalogNoMatches}</p>}
            {sections.map((s) => (
                <Section
                    key={s.key}
                    section={s}
                    hits={filtering ? `${s.shown}/${s.count}` : undefined}
                    model={model}
                    {...rest}
                    names={names}
                    shared={shared}
                    severity={severity}
                />
            ))}
        </div>
    );
}

/** One kind of element, per context; shared contexts come first. */
function Section(
    props: CatalogProps & {
        section: CatalogSection;
        /** While filtering: matches / all. */
        hits?: string;
        names: Namer;
        shared: Set<string>;
        severity: Map<string, 'error' | 'warning'>;
    },
) {
    const { section, model, names } = props;
    const t = useT();
    return (
        <section className="catalog-section">
            <h1>
                {t.catalogSections[section.key]}
                {props.hits && <span className="catalog-count">{props.hits}</span>}
            </h1>
            {section.groups.length === 0 && <p className="muted">{t.catalogEmpty}</p>}
            {section.groups.map(({ context, items }) => (
                <section key={context} className={`catalog-context${props.shared.has(context) ? ' catalog-shared' : ''}`}>
                    <h2>
                        {names.of({ name: context, label: model.contextLabels[context] })}
                        {props.shared.has(context) && <span className="shared-badge">{t.sharedCatalog}</span>}
                    </h2>
                    <div className="cards">
                        {items.map((el) => (
                            <Card key={el.id} el={el} {...props} shared={props.shared.has(context)} severity={props.severity.get(el.id)} />
                        ))}
                    </div>
                </section>
            ))}
        </section>
    );
}

function Card(props: {
    el: ElementModel;
    model: DomainModel;
    names: Namer;
    diff: ModelDiff;
    selected: string | undefined;
    shared: boolean;
    severity: 'error' | 'warning' | undefined;
    onSelect: (id: string) => void;
}) {
    const { el, model, names } = props;
    const t = useT();
    const change = props.diff.added.includes(el.id) ? 'added' : props.diff.changed.includes(el.id) ? 'changed' : 'none';
    const classes = [
        'card',
        `card-kind-${el.kind}`,
        `dn-change-${change}`,
        props.selected === el.id ? 'card-selected' : '',
        props.severity ? `card-${props.severity}` : '',
    ];

    return (
        <button className={classes.filter(Boolean).join(' ')} data-card={el.id} onClick={() => props.onSelect(el.id)} title={el.doc}>
            <CardHead el={el} tx={t} />
            <CardBody el={el} model={model} names={names} />
            <div className="card-foot muted">
                <CardUses el={el} model={model} names={names} shared={props.shared} />
                {change !== 'none' && <span className={`change change-${change}`}>{change === 'added' ? t.added : t.changed}</span>}
                {props.severity && <span className={`card-diag card-diag-${props.severity}`}>{props.severity === 'error' ? '✕' : '!'}</span>}
            </div>
        </button>
    );
}

/**
 * The badges on a line of their own, then the label over the name whatever the display mode, so that the heading
 * has the card's width; an element without a label shows its name alone.
 */
export function CardHead({ el, tx }: { el: ElementModel; tx: Messages }) {
    return (
        <div className="card-head">
            <span className="card-tags">
                <span className={`kind kind-${el.kind} tiny`}>{tx.kinds[el.kind]}</span>
                {el.kind === 'event' && <PersistenceBadge persistent={!!el.persistent} tx={tx} />}
            </span>
            <span className="card-name" title={el.label ?? el.name}>
                {el.label ?? el.name}
            </span>
            {el.label && (
                <span className="card-subname" title={el.name}>
                    {el.name}
                </span>
            )}
        </div>
    );
}

/** What sets each kind apart: base type and values, fields, variants, states and commands. */
function CardBody({ el, model, names }: { el: ElementModel; model: DomainModel; names: Namer }) {
    const t = useT();
    switch (el.kind) {
        case 'primitive':
        case 'id':
        case 'enum':
            return (
                <>
                    {el.base && <div className="card-base">{names.primitive(el.base)}</div>}
                    {el.values && (
                        <div className="chips">
                            {el.values.map((v) => (
                                <code key={v}>{names.of({ name: v, label: el.valueLabels?.[v] })}</code>
                            ))}
                        </div>
                    )}
                    <Invariants invariants={el.invariants} names={names} />
                </>
            );
        case 'verified': {
            const v = el.verified!;
            return (
                <>
                    <div className="card-base">
                        {t.verifiedOf}: {names.type(v.of, el.context)}
                    </div>
                    {v.for && (
                        <div className="card-base">
                            {t.verifiedFor}: {names.type(v.for.type, el.context)}
                            {v.for.optional ? '?' : ''}
                        </div>
                    )}
                    {v.errors.length > 0 && (
                        <div className="chips">
                            {v.errors.map((e) => (
                                <code key={e}>{names.short(e)}</code>
                            ))}
                        </div>
                    )}
                </>
            );
        }
        case 'union':
            return (
                <>
                    {el.discriminator && <div className="card-base">{el.discriminator}</div>}
                    <Fields fields={el.fields} ctx={el.context} names={names} />
                    <div className="chips">
                        {(el.variants ?? []).map((v) => (
                            <code key={v.name}>{names.of(v)}</code>
                        ))}
                    </div>
                    <Invariants invariants={el.invariants} names={names} />
                </>
            );
        case 'aggregate':
            return (
                <>
                    <Fields fields={el.fields} ctx={el.context} names={names} />
                    {(el.states?.length ?? 0) > 0 && (
                        <div className="chips">
                            {el.states!.map((s) => (
                                <code key={s.id}>{names.of(s)}</code>
                            ))}
                        </div>
                    )}
                    {(el.commands?.length ?? 0) > 0 && (
                        <ul className="card-commands">
                            {el.commands!.map((c) => (
                                <li key={c.id}>
                                    {names.of(c)}
                                    <span className="muted">{names.transition(el, c)}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                    <Invariants invariants={el.invariants} names={names} />
                </>
            );
        case 'event':
            return el.fields.length ? <Fields fields={el.fields} ctx={el.context} names={names} /> : <span className="muted">{t.noFields}</span>;
        case 'policy': {
            const target = policyTarget(model, el);
            return (
                <ul className="card-fields">
                    <li>
                        <span>when</span>
                        <code>{el.policy ? names.id(el.policy.event) : ''}</code>
                    </li>
                    <li>
                        <span>→</span>
                        <code>{target ? `${names.of(target.agg)}.${names.of(target.command)}` : `${el.policy?.aggregate}.${el.policy?.command}`}</code>
                    </li>
                </ul>
            );
        }
        case 'error':
            return (
                <>
                    {el.doc && <p className="card-doc">{el.doc}</p>}
                    <Fields fields={el.fields} ctx={el.context} names={names} />
                </>
            );
        default:
            return (
                <>
                    <Fields fields={el.fields} ctx={el.context} names={names} />
                    <Invariants invariants={el.invariants} names={names} />
                </>
            );
    }
}

/** Where the element is used; for events and errors, the commands that emit or return it. */
function CardUses({ el, model, names, shared }: { el: ElementModel; model: DomainModel; names: Namer; shared: boolean }) {
    const t = useT();
    if (el.kind === 'policy') return <>{t.eventually}</>;
    if (el.kind === 'event' || el.kind === 'error') {
        const commands = commandsWithOutcome(model, el.id).map(({ agg, command }) => `${names.of(agg)}.${names.of(command)}`);
        // an error may also be returned by the factory of a verified type
        const factories = Object.values(model.elements)
            .filter((v) => v.verified?.errors.includes(el.id))
            .map((v) => names.of(v));
        const reactions = el.kind === 'event' ? policiesReactingTo(model, el.id) : [];
        const from =
            commands.length || factories.length ? `← ${[...commands, ...factories].join(', ')}` : el.kind === 'event' ? t.raisedByNone : t.returnedByNone;
        return (
            <>
                {from}
                {reactions.length > 0 && <> · ⇒ {reactions.map((p) => names.of(p)).join(', ')}</>}
            </>
        );
    }
    if (el.kind === 'verified') {
        const uses = usagesOf(model, el.id, names.of);
        return <>{uses.length ? `← ${uses.map((u) => u.text).join(', ')}` : t.usedIn(0)}</>;
    }
    if (el.kind === 'fieldSet') {
        const users = fieldSetUsers(model, el.id);
        return <>{users.length ? `← ${users.map((u) => names.of(u)).join(', ')}` : t.usedIn(0)}</>;
    }
    // aggregates are used through their ID (`references`), never as a type
    const idType = el.kind === 'aggregate' ? el.fields.find((f) => f.name === 'id' && f.type.kind === 'ref')?.type : undefined;
    const uses = idType?.kind === 'ref' ? usagesOf(model, idType.ref).filter((u) => u.target !== el.id) : usagesOf(model, el.id);
    const usedIn = [...new Set(uses.map((u) => u.context))].filter((c) => c !== el.context);
    return (
        <>
            {t.usedIn(uses.length)}
            {shared && usedIn.length > 0 && <> · {usedIn.map((c) => names.of({ name: c, label: model.contextLabels[c] })).join(', ')}</>}
        </>
    );
}

function Fields({ fields, ctx, names }: { fields: FieldModel[]; ctx: string; names: Namer }) {
    if (!fields.length) return null;
    return (
        <ul className="card-fields">
            {fields.map((f) => (
                <li key={f.name}>
                    <span>{names.field(f)}</span>
                    <code>
                        {f.kind === 'references' ? '→ ' : ''}
                        {names.type(f.type, ctx)}
                        {f.multiplicity}
                        {f.fieldSet && <span className="field-origin">{names.short(f.fieldSet)}</span>}
                    </code>
                </li>
            ))}
        </ul>
    );
}

export function Invariants({ invariants, names }: { invariants: InvariantModel[]; names: Namer }) {
    const t = useT();
    if (!invariants.length) return null;
    return (
        <ul className="card-invariants">
            {invariants.map((i) => (
                <li key={i.name}>
                    <span>✓ {names.of(i)}</span>
                    {i.source !== undefined ? <code>{i.source}</code> : <em className="not-in-dsl">{t.notInDsl}</em>}
                </li>
            ))}
        </ul>
    );
}
