import { ChevronRight, Microscope, Telescope, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { type AnyDeclaration, declarations, type Diagnostic, type DomainModel, type NodeElement, type Storming } from '@domaintrail/modeling';
import {
    buildSemanticGraph,
    type DisplayMode,
    type EventOccurrence,
    firstDeclarations,
    type LaidOutGraph,
    type RenderGraph,
    stormingTimelines,
    stormingViewKey,
    timelineOccurrences,
    VIEW_LEVELS,
    type ViewLevel,
    type ViewOptions,
} from '@domaintrail/visualization';
import type { StormingView } from '@domaintrail/visualization/protocol';
import { useT } from './i18n';
import { fileSelection, nameIn, type Select } from './model-utils';
import type { SourceFocus } from './source';
import { LevelSwitch, SubjectPicker, ToolbarSubject } from './view/toolbar';

/** What the Event Storming view shows: a storming, a level and a timeline filter, all of them the page's state only. */
export interface StormingChoice {
    stormingId: string | undefined;
    level: ViewLevel;
    /** By storming ID: the selected timeline (none: the integrated canvas). */
    timelines: Record<string, string>;
}

/** The storming shown (the chosen one, or the first) and the view of it, as the payload keys it. */
export function shownStorming(stormings: readonly StormingView[], choice: StormingChoice): { storming: StormingView; options: ViewOptions } | undefined {
    const storming = stormings.find((s) => s.id === choice.stormingId) ?? stormings[0];
    if (!storming) return undefined;
    const level = VIEW_LEVELS.includes(choice.level) ? choice.level : 'big-picture';
    const timelineId = choice.timelines[storming.id];
    return { storming, options: timelineId !== undefined && storming.timelines.some((t) => t.id === timelineId) ? { level, timelineId } : { level } };
}

/** The drawing and the render graph of the shown view. */
export function stormingGraph(stormings: readonly StormingView[], choice: StormingChoice): { graph: LaidOutGraph; render: RenderGraph } | undefined {
    const shown = shownStorming(stormings, choice);
    return shown && shown.storming.views[stormingViewKey(shown.options)];
}

/** Selection IDs of storming elements: `es/<Storming>/<Local>` (`esElementId`). */
export const isStormingSelection = (id: string | undefined): id is string => !!id?.startsWith('es/');

function parseSelection(id: string): { stormingId: string; localId?: string } {
    const [, stormingId, localId] = id.split('/');
    return localId === undefined ? { stormingId } : { stormingId, localId };
}

/** The storming and the declaration a selection ID names, if they still exist. */
function lookup(stormings: readonly StormingView[], id: string): { view: StormingView; declaration?: AnyDeclaration } | undefined {
    const { stormingId, localId } = parseSelection(id);
    const view = stormings.find((s) => s.id === stormingId);
    if (!view) return undefined;
    if (localId === undefined) return { view };
    const declaration = firstDeclarations(view.storming).get(localId);
    return declaration && { view, declaration };
}

export const stormingExists = (stormings: readonly StormingView[], id: string): boolean => !!lookup(stormings, id);

/** Where a storming element is written. */
export function stormingLocation(stormings: readonly StormingView[], id: string): SourceFocus | undefined {
    const found = lookup(stormings, id);
    const range = (found?.declaration ?? found?.view.storming)?.range;
    return range && { file: range.file, line: range.start.line, endLine: range.end.line };
}

/** The name of a selection in the inspector's back button. */
export const stormingSelectionName = (id: string): string => id.slice(id.lastIndexOf('/') + 1);

/** The `.dt` item a `ref` names, when the model has it (an event or an aggregate `Ctx.Name`, a command `Ctx.Agg.cmd`). */
function dtTarget(model: DomainModel | null, kind: string, path: string): string | undefined {
    if (!model) return undefined;
    const segments = path.split('.');
    if (kind === 'command' && segments.length === 3) return model.elements[`${segments[0]}.${segments[1]}`]?.commands?.find((c) => c.name === segments[2])?.id;
    const el = segments.length === 2 ? model.elements[path] : undefined;
    return el?.kind === kind ? el.id : undefined;
}

const LEVEL_ICONS: Record<ViewLevel, LucideIcon> = { 'big-picture': Telescope, 'design-level': Microscope };

/**
 * The Event Storming view's toolbar: its subject, the storming then the timeline (すべて（統合） or one timeline) as a
 * breadcrumb of pickers, and its level. The timeline is what is looked at, not a filter: the integrated canvas and a
 * timeline draw different things.
 */
export function StormingToolbar({
    stormings,
    choice,
    mode,
    onChange,
}: {
    stormings: readonly StormingView[];
    choice: StormingChoice;
    mode: DisplayMode;
    onChange: (choice: StormingChoice) => void;
}) {
    const t = useT();
    const shown = shownStorming(stormings, choice);
    if (!shown) return null;
    const { storming, options } = shown;
    return (
        <ToolbarSubject>
            <nav className="subject-crumbs" aria-label={t.views.storming}>
                <SubjectPicker
                    label={t.stormingPicker}
                    value={storming.id}
                    options={stormings.map((s) => ({ value: s.id, label: nameIn(mode, s.id, s.label) }))}
                    onChange={(id) => onChange({ ...choice, stormingId: id })}
                />
                {storming.timelines.length > 0 && (
                    <>
                        <ChevronRight className="subject-sep" size={14} aria-hidden />
                        <SubjectPicker
                            label={t.timelineFilter}
                            value={options.timelineId ?? ''}
                            options={[
                                { value: '', label: t.allTimelines },
                                ...storming.timelines.map((tl) => ({ value: tl.id, label: nameIn(mode, tl.id, tl.label) })),
                            ]}
                            onChange={(id) => {
                                const { [storming.id]: _, ...others } = choice.timelines;
                                onChange({ ...choice, timelines: id ? { ...others, [storming.id]: id } : others });
                            }}
                        />
                    </>
                )}
            </nav>
            <LevelSwitch
                label={t.stormingLevel}
                levels={VIEW_LEVELS}
                value={options.level}
                icons={LEVEL_ICONS}
                names={(l) => ({ label: t.stormingLevels[l].label, tooltip: `${t.stormingLevels[l].label} — ${t.stormingLevels[l].hint}` })}
                onChange={(level) => onChange({ ...choice, level })}
            />
        </ToolbarSubject>
    );
}

/**
 * The inspector's view of a storming element: its kind, names and description, its `.dt` ref, its relations, and for
 * an event its occurrences in the timelines and the notes of the current view that stand for them (§6, §8.4).
 */
export function StormingDetails({
    stormings,
    selected,
    render,
    model,
    mode,
    diagnostics,
    history,
    onSelect,
}: {
    stormings: readonly StormingView[];
    selected: string;
    /** The render graph of the view shown, if it is a view of this storming. */
    render: RenderGraph | undefined;
    model: DomainModel | null;
    mode: DisplayMode;
    diagnostics: Diagnostic[];
    /** The back and close buttons. */
    history: ReactNode;
    onSelect: Select;
}) {
    const t = useT();
    const found = lookup(stormings, selected);
    if (!found) {
        return (
            <div className="inspector-head">
                {history}
                <p className="muted">{t.notInStorming(stormingSelectionName(selected))}</p>
            </div>
        );
    }
    const { view, declaration } = found;
    const storming = view.storming;
    const item = declaration ?? { ...storming, kind: undefined };
    const byId = firstDeclarations(storming);
    const name = (id: string) => nameIn(mode, id, byId.get(id)?.label);
    const link = (id: string) => <a onClick={() => onSelect(`es/${storming.id}/${id}`)}>{name(id)}</a>;
    const diags = diagnostics.filter((d) => d.elementId === selected);
    const file = item.range.file;

    return (
        <>
            <div className="inspector-head">
                {history}
                <div className="inspector-row">
                    <span className={`kind kind-es-${item.kind ?? 'storming'}`}>{item.kind ? t.esKinds[item.kind] : t.inStorming}</span>
                </div>
                <h2>{mode === 'both' && item.label ? item.label : nameIn(mode, item.id, item.label)}</h2>
                {mode === 'both' && item.label && <div className="canonical-name">{item.id}</div>}
                {item.doc && <p className="doc">{item.doc}</p>}
                <div className="reveal">
                    <span className="muted small">
                        {file}:{item.range.start.line}
                    </span>
                    <button onClick={() => onSelect(fileSelection(file))}>{t.openFile}</button>
                </div>
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
            <div className="inspector-body">
                {declaration && declaration.kind !== 'timeline' && declaration.kind !== 'group' && (
                    <>
                        {(declaration.kind === 'event' || declaration.kind === 'command' || declaration.kind === 'aggregate') && (
                            <RefSection declaration={declaration} model={model} onSelect={onSelect} />
                        )}
                        {declaration.kind === 'hotspot' && <HotspotSection clauses={declaration.clauses} />}
                        <Section title={t.esRelations}>
                            <Relations storming={storming} id={declaration.id} link={link} />
                        </Section>
                        {declaration.kind === 'event' && <Occurrences storming={storming} eventId={declaration.id} render={render} name={name} />}
                    </>
                )}
                {declaration?.kind === 'group' && (
                    <Section title={t.groupEvents}>
                        <ul className="es-list">
                            {declaration.events.map((e, i) => (
                                <li key={i}>{link(e.eventId)}</li>
                            ))}
                        </ul>
                    </Section>
                )}
                {declaration?.kind === 'timeline' && (
                    <Section title={t.esKinds.timeline}>
                        <ol className="es-list">
                            {declaration.steps.map((s, i) => (
                                <li key={i}>
                                    {s.type === 'event' ? (
                                        link(s.eventId)
                                    ) : (
                                        <>
                                            {link(s.id)} {'{ '}
                                            {s.events.map((e, j) => (
                                                <span key={j}>
                                                    {j > 0 && ', '}
                                                    {link(e.eventId)}
                                                </span>
                                            ))}
                                            {' }'}
                                        </>
                                    )}
                                </li>
                            ))}
                        </ol>
                    </Section>
                )}
            </div>
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

function RefSection({ declaration, model, onSelect }: { declaration: NodeElement; model: DomainModel | null; onSelect: Select }) {
    const t = useT();
    const refs = declaration.clauses.flatMap((c) => (c.type === 'ref' ? [c.path] : []));
    return (
        <Section title={t.dtRef}>
            {refs.length === 0 ? (
                <p className="muted small">{t.noDtRef}</p>
            ) : (
                refs.map((path) => {
                    const target = dtTarget(model, declaration.kind, path);
                    return (
                        <div key={path}>
                            {target ? (
                                <a onClick={() => onSelect(target)}>
                                    <code>{path}</code>
                                </a>
                            ) : (
                                <>
                                    <code>{path}</code> <span className="muted small">{t.unresolvedRef}</span>
                                </>
                            )}
                        </div>
                    );
                })
            )}
        </Section>
    );
}

function HotspotSection({ clauses }: { clauses: NodeElement['clauses'] }) {
    const t = useT();
    const status = clauses.find((c) => c.type === 'status');
    const resolution = clauses.find((c) => c.type === 'resolution');
    if (!status && !resolution) return null;
    return (
        <Section title={t.hotspotStatus}>
            {status && <div>{t.hotspotStatuses[status.value] ?? status.value}</div>}
            {resolution && (
                <p className="doc">
                    {t.resolution}: {resolution.text}
                </p>
            )}
        </Section>
    );
}

/** The valid relations of an element, both ways, as the semantic graph has them (§9.1). */
function Relations({ storming, id, link }: { storming: Storming; id: string; link: (id: string) => ReactNode }) {
    const t = useT();
    const edges = buildSemanticGraph(storming).edges.filter((e) => e.sourceId === id || e.targetId === id);
    if (edges.length === 0) return <p className="muted small">{t.noRelations}</p>;
    return (
        <ul className="es-list">
            {edges.map((e) => (
                <li key={`${e.kind}:${e.sourceId}->${e.targetId}`}>
                    <span className="muted small">{t.esRelationKinds[e.kind]}</span> {link(e.sourceId)} → {link(e.targetId)}
                </li>
            ))}
        </ul>
    );
}

/** An event's occurrences in every timeline, and the notes of the current view that stand for them. */
function Occurrences({
    storming,
    eventId,
    render,
    name,
}: {
    storming: Storming;
    eventId: string;
    render: RenderGraph | undefined;
    name: (id: string) => string;
}) {
    const t = useT();
    const timelines = stormingTimelines(storming);
    const occurrences = timelines.flatMap((tl) => timelineOccurrences(tl).filter((o) => o.eventId === eventId));
    const groupOf = new Map(declarations(storming).flatMap((d) => (d.kind === 'timeline' ? d.steps.map((s, i) => [`${d.id}/${i}`, s] as const) : [])));
    const describe = (o: EventOccurrence): string => {
        const step = groupOf.get(`${o.timelineId}/${o.stepPath[0]}`);
        return `${name(o.timelineId)} · ${t.stepOf(o.stepPath[0] + 1)}${step?.type === 'group' ? ` · ${t.inGroup(name(step.id))}` : ''}`;
    };
    const notes = render?.nodes.filter((n) => n.type === 'event' && n.eventId === eventId) ?? [];
    return (
        <>
            <Section title={t.occurrences}>
                {occurrences.length === 0 ? (
                    <p className="muted small">{t.noOccurrences}</p>
                ) : (
                    <ul className="es-list">
                        {occurrences.map((o) => (
                            <li key={`${o.timelineId}/${o.stepPath.join('.')}`}>{describe(o)}</li>
                        ))}
                    </ul>
                )}
            </Section>
            {notes.length > 0 && (
                <Section title={t.drawnAs(notes.length)}>
                    <ul className="es-list">
                        {notes.map((n) => (
                            <li key={n.id}>{n.type === 'event' && n.occurrences.length > 0 ? n.occurrences.map(describe).join(' / ') : t.noOccurrences}</li>
                        ))}
                    </ul>
                    {notes.some((n) => n.type === 'event' && new Set(n.occurrences.map((o) => o.timelineId)).size > 1) && (
                        <p className="muted small">{t.sharedNote}</p>
                    )}
                </Section>
            )}
        </>
    );
}
