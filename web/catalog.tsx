import type { Diagnostic } from '../src/core/diagnostics';
import type { ModelDiff } from '../src/graph/diff';
import type { DisplayMode } from '../src/graph/ir';
import { PRIMITIVE_LABELS } from '../src/graph/build';
import type { DomainModel, ElementModel } from '../src/model/model';
import { useT } from './i18n';
import { ownerElement } from './render';
import { usagesOf } from './usages';

const KINDS: ElementModel['kind'][] = ['primitive', 'id', 'enum'];
const KIND_LABEL: Partial<Record<ElementModel['kind'], string>> = { primitive: 'Primitive', id: 'ID', enum: 'Enum' };

const nameIn = (mode: DisplayMode, name: string, label?: string): string =>
    mode === 'name' || !label ? name : mode === 'label' ? label : `${label} (${name})`;

/**
 * Catalog of domain primitives (primitives, IDs, enums) per context; shared contexts come first.
 * Cards show base type, invariants and where each type is used.
 */
export function PrimitiveCatalog(props: {
    model: DomainModel;
    mode: DisplayMode;
    diff: ModelDiff;
    diagnostics: Diagnostic[];
    selected: string | undefined;
    onSelect: (id: string) => void;
}) {
    const { model, mode } = props;
    const t = useT();
    const shared = new Set(model.sharedContexts);
    const contexts = [...model.contexts].sort((a, b) => Number(shared.has(b)) - Number(shared.has(a)) || a.localeCompare(b));
    const severity = new Map<string, 'error' | 'warning'>();
    for (const d of props.diagnostics) {
        if (!d.elementId) continue;
        const id = ownerElement(d.elementId);
        if (severity.get(id) !== 'error') severity.set(id, d.severity);
    }

    return (
        <div className="catalog">
            {contexts.map((ctx) => {
                const items = Object.values(model.elements)
                    .filter((e) => e.context === ctx && KINDS.includes(e.kind))
                    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.name.localeCompare(b.name));
                return (
                    <section key={ctx} className={`catalog-context${shared.has(ctx) ? ' catalog-shared' : ''}`}>
                        <h2>
                            {nameIn(mode, ctx, model.contextLabels[ctx])}
                            {shared.has(ctx) && <span className="shared-badge">{t.sharedCatalog}</span>}
                        </h2>
                        {items.length === 0 ? (
                            <p className="muted">{t.noPrimitives}</p>
                        ) : (
                            <div className="cards">
                                {items.map((el) => (
                                    <Card key={el.id} el={el} {...props} shared={shared.has(ctx)} severity={severity.get(el.id)} />
                                ))}
                            </div>
                        )}
                    </section>
                );
            })}
        </div>
    );
}

function Card(props: {
    el: ElementModel;
    model: DomainModel;
    mode: DisplayMode;
    diff: ModelDiff;
    selected: string | undefined;
    shared: boolean;
    severity: 'error' | 'warning' | undefined;
    onSelect: (id: string) => void;
}) {
    const { el, model, mode } = props;
    const t = useT();
    const uses = usagesOf(model, el.id);
    const usedIn = [...new Set(uses.map((u) => u.context))].filter((c) => c !== el.context);
    const change = props.diff.added.includes(el.id) ? 'added' : props.diff.changed.includes(el.id) ? 'changed' : 'none';
    const classes = ['card', `card-${el.kind}`, `dn-change-${change}`, props.selected === el.id ? 'card-selected' : '', props.severity ? `card-${props.severity}` : ''];

    return (
        <button className={classes.filter(Boolean).join(' ')} onClick={() => props.onSelect(el.id)} title={el.doc}>
            <div className="card-head">
                <span className="card-name">{nameIn(mode, el.name, el.label)}</span>
                <span className={`kind kind-${el.kind} tiny`}>{KIND_LABEL[el.kind]}</span>
            </div>
            {el.base && <div className="card-base">{mode === 'label' ? (PRIMITIVE_LABELS[el.base] ?? el.base) : el.base}</div>}
            {el.values && (
                <div className="chips">
                    {el.values.map((v) => (
                        <code key={v}>{nameIn(mode, v, el.valueLabels?.[v])}</code>
                    ))}
                </div>
            )}
            {el.invariants.length > 0 && (
                <ul className="card-invariants">
                    {el.invariants.map((i) => (
                        <li key={i.name}>
                            <span>✓ {mode === 'name' || !i.label ? i.name : i.label}</span>
                            <code>{i.source}</code>
                        </li>
                    ))}
                </ul>
            )}
            <div className="card-foot muted">
                {t.usedIn(uses.length)}
                {props.shared && usedIn.length > 0 && <> · {usedIn.map((c) => nameIn(mode, c, model.contextLabels[c])).join(', ')}</>}
                {change !== 'none' && <span className={`change change-${change}`}>{change === 'added' ? t.added : t.changed}</span>}
                {props.severity && <span className={`card-diag card-diag-${props.severity}`}>{props.severity === 'error' ? '✕' : '!'}</span>}
            </div>
        </button>
    );
}
