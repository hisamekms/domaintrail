import { useEffect, useRef } from 'react';
import type { Diagnostic } from '../src/core/diagnostics';
import type { ModelDiff } from '../src/graph/diff';
import type { DisplayMode } from '../src/graph/ir';
import type { DomainModel, ElementModel, FieldModel, InvariantModel } from '../src/model/model';
import { useT } from './i18n';
import { PersistenceBadge } from './inspector';
import { catalogSections, commandsWithOutcome, namer, type CatalogSection, type Namer } from './model-utils';
import { ownerElement } from './render';
import { usagesOf } from './usages';

const KIND_LABEL: Record<ElementModel['kind'], string> = {
    aggregate: 'Aggregate',
    entity: 'Entity',
    valueObject: 'Value Object',
    union: 'Union',
    primitive: 'Primitive',
    id: 'ID',
    enum: 'Enum',
    event: 'Event',
    error: 'Error',
};

interface CatalogProps {
    model: DomainModel;
    mode: DisplayMode;
    diff: ModelDiff;
    diagnostics: Diagnostic[];
    selected: string | undefined;
    onSelect: (id: string) => void;
}

/** Cards to look over the model's elements, one section per kind of element, with links to jump to each section. */
export function Catalog(props: CatalogProps) {
    const { model } = props;
    const t = useT();
    const root = useRef<HTMLDivElement>(null);
    const sections = catalogSections(model);
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

    const jump = (key: string) => root.current?.querySelector(`#catalog-${key}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });

    return (
        <div className="catalog" ref={root}>
            <nav className="catalog-jump">
                {sections.map((s) => (
                    <button key={s.key} className={s.count ? '' : 'muted'} onClick={() => jump(s.key)}>
                        {t.catalogSections[s.key]} <span className="catalog-count">{s.count}</span>
                    </button>
                ))}
            </nav>
            {sections.map((s) => (
                <Section key={s.key} section={s} {...props} names={names} shared={shared} severity={severity} />
            ))}
        </div>
    );
}

/** One kind of element, per context; shared contexts come first. */
function Section(props: CatalogProps & { section: CatalogSection; names: Namer; shared: Set<string>; severity: Map<string, 'error' | 'warning'> }) {
    const { section, model, names } = props;
    const t = useT();
    return (
        <section className="catalog-section" id={`catalog-${section.key}`}>
            <h1>{t.catalogSections[section.key]}</h1>
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
    const classes = ['card', `card-kind-${el.kind}`, `dn-change-${change}`, props.selected === el.id ? 'card-selected' : '', props.severity ? `card-${props.severity}` : ''];

    return (
        <button className={classes.filter(Boolean).join(' ')} data-card={el.id} onClick={() => props.onSelect(el.id)} title={el.doc}>
            <div className="card-head">
                <span className="card-name">{names.of(el)}</span>
                <span className="card-tags">
                    {el.kind === 'event' && <PersistenceBadge persistent={!!el.persistent} />}
                    <span className={`kind kind-${el.kind} tiny`}>{KIND_LABEL[el.kind]}</span>
                </span>
            </div>
            <CardBody el={el} model={model} names={names} />
            <div className="card-foot muted">
                <CardUses el={el} model={model} names={names} shared={props.shared} />
                {change !== 'none' && <span className={`change change-${change}`}>{change === 'added' ? t.added : t.changed}</span>}
                {props.severity && <span className={`card-diag card-diag-${props.severity}`}>{props.severity === 'error' ? '✕' : '!'}</span>}
            </div>
        </button>
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
    if (el.kind === 'event' || el.kind === 'error') {
        const commands = commandsWithOutcome(model, el.id);
        if (!commands.length) return <>{el.kind === 'event' ? t.raisedByNone : t.returnedByNone}</>;
        return <>← {commands.map(({ agg, command }) => `${names.of(agg)}.${names.of(command)}`).join(', ')}</>;
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
                    </code>
                </li>
            ))}
        </ul>
    );
}

function Invariants({ invariants, names }: { invariants: InvariantModel[]; names: Namer }) {
    if (!invariants.length) return null;
    return (
        <ul className="card-invariants">
            {invariants.map((i) => (
                <li key={i.name}>
                    <span>✓ {names.of(i)}</span>
                    <code>{i.source}</code>
                </li>
            ))}
        </ul>
    );
}
