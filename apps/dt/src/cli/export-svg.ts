// `dt export svg`: a diagram of the Live View drawn as the portable SVG its 書き出し → SVG saves, without a browser. The
// drawing is the page's (`@domaintrail/visualization`'s scene, heading, legend and `portableSvg`); what the browser gives
// the page comes from elsewhere: the colours from styles.css's custom properties (embedded in the CLI, read as the page
// reads them), the font stacks from the same file, and the text's widths from the table of those fonts
// (`tableMeasure`). The SVG names the font stacks and embeds no font.
import {
    buildScene,
    exportBounds,
    hideInDrawing,
    laidOutHidden,
    legendContent,
    legendKindNames,
    DIAGRAM_TEXTS,
    portableSvg,
    sheetHeading,
    stormingSheetSubject,
    styleFonts,
    stylePalette,
    styleTokens,
    stormingViewKey,
    tableMeasure,
    tokenColour,
    type DiagramTheme,
    type DisplayMode,
    type Hideable,
    type LaidOutGraph,
    type Lang,
    type LegendView,
    type SheetSubject,
    type StructureLevel,
    type ViewLevel,
} from '@domaintrail/visualization';
import type { StormingView } from '@domaintrail/visualization/protocol';
import styles from '../../../web/styles.css' with { type: 'text' };
import type { DiagramViews } from './ports.js';

/** What `dt export svg` draws, as its options say it. */
export interface SvgExportOptions {
    storming?: string | undefined;
    stage?: string | undefined;
    timeline?: string | undefined;
    /** The storming's level (`big-picture`, `design`) or the Structure View's (`detail`, `overview`, `aggregates`). */
    level?: string | undefined;
    exceptions?: 'show' | 'hide' | undefined;
    /** The resolved hotspots: drawn (default) or not, as the 絞り込み's 「解決済みを表示」 (in any view of a storming). */
    resolvedHotspots?: 'show' | 'hide' | undefined;
    model?: boolean | undefined;
    view?: 'map' | 'structure' | undefined;
    /** The Structure View's focused contexts. */
    context?: readonly string[] | undefined;
    /** The Context Map with the shared and external contexts. */
    all?: boolean | undefined;
    heading?: boolean | undefined;
    legend?: boolean | undefined;
    theme: DiagramTheme;
    lang: Lang;
    names: DisplayMode;
}

/** Why nothing was drawn: printed as one line, exiting with `exitCode` (2: the options; 1: the workspace). */
export class SvgExportError extends Error {
    constructor(
        message: string,
        readonly exitCode: 1 | 2,
    ) {
        super(message);
    }
}

/** The storming levels as the option names them. */
const STORMING_LEVELS: Record<string, ViewLevel> = { 'big-picture': 'big-picture', design: 'design-level' };
const STRUCTURE_LEVELS: readonly StructureLevel[] = ['detail', 'overview', 'aggregates'];
const isStructureLevel = (level: string): level is StructureLevel => (STRUCTURE_LEVELS as readonly string[]).includes(level);

/** A diagram to draw: its graph and what it is (its heading's subject and its legend). */
interface Chosen {
    graph: LaidOutGraph;
    subject: SheetSubject;
    legend: LegendView;
}

/** `choices` as an error lists them: `A, B (none)`. */
const listed = (choices: readonly string[]): string => (choices.length ? choices.join(', ') : '(none)');

/** Checks the options' combination before the workspace is read (exit 2 when it does not make sense). */
export function checkSvgOptions(o: SvgExportOptions): void {
    const usage = (message: string): never => {
        throw new SvgExportError(message, 2);
    };
    if (o.storming !== undefined && o.model) usage('Give --storming <ID> or --model, not both.');
    if (o.storming === undefined && !o.model) usage('Give the diagram to draw: --storming <ID> (an Event Storming) or --model (the domain model).');
    if (o.storming !== undefined) {
        if (o.view !== undefined || o.context !== undefined || o.all) usage('--view, --context and --all are options of --model.');
        if (o.stage !== undefined && o.timeline !== undefined) usage('Give --stage or --timeline, not both.');
        if (o.timeline !== undefined && o.exceptions !== undefined) usage('--exceptions applies to the whole storming or a stage, not to one timeline.');
        if (o.level !== undefined && !(o.level in STORMING_LEVELS))
            usage(`Unknown level '${o.level}' of a storming. Choose: ${Object.keys(STORMING_LEVELS).join(', ')}`);
        return;
    }
    if (o.stage !== undefined || o.timeline !== undefined || o.exceptions !== undefined || o.resolvedHotspots !== undefined)
        usage('--stage, --timeline, --exceptions and --resolved-hotspots are options of --storming.');
    const view = o.view ?? 'structure';
    if (view === 'map' && (o.context !== undefined || o.level !== undefined)) usage('--context and --level are options of --view structure.');
    if (view === 'structure' && o.all) usage('--all is an option of --view map.');
    if (o.level !== undefined && !isStructureLevel(o.level)) {
        usage(`Unknown level '${o.level}' of the Structure View. Choose: ${STRUCTURE_LEVELS.join(', ')}`);
    }
}

/** The storming view the options name, or an error naming the choices. */
function stormingDiagram(stormings: readonly StormingView[], o: SvgExportOptions): Chosen {
    const storming = stormings.find((s) => s.id === o.storming);
    if (!storming) throw new SvgExportError(`Unknown storming '${o.storming}'. Stormings: ${listed(stormings.map((s) => s.id))}`, 1);
    const stages = storming.stages ?? [];
    if (o.stage !== undefined && !stages.some((st) => st.id === o.stage)) {
        throw new SvgExportError(`Unknown stage '${o.stage}' of ${storming.id}. Stages: ${listed(stages.map((st) => st.id))}`, 1);
    }
    if (o.timeline !== undefined && !storming.timelines.some((t) => t.id === o.timeline)) {
        throw new SvgExportError(`Unknown timeline '${o.timeline}' of ${storming.id}. Timelines: ${listed(storming.timelines.map((t) => t.id))}`, 1);
    }
    const level = STORMING_LEVELS[o.level ?? 'big-picture']!;
    // what is hidden, as the 絞り込み hides it (`HIDDEN_BY`): the exceptions by the integrated canvas's or a stage's layout
    // without them (only when the storming has some), the resolved hotspots by leaving them out of the drawing
    const hidden = new Set<Hideable>([
        ...(o.exceptions === 'hide' ? (['exceptions'] as const) : []),
        ...(o.resolvedHotspots === 'hide' ? (['resolvedHotspots'] as const) : []),
    ]);
    const hide = laidOutHidden(storming.timelines.some((t) => t.exception) ? hidden : []);
    const options =
        o.timeline !== undefined ? { level, timelineId: o.timeline } : o.stage !== undefined ? { level, stageId: o.stage, ...hide } : { level, ...hide };
    const view = storming.views[stormingViewKey(options)];
    if (!view) throw new SvgExportError(`${storming.id} has no such view.`, 1);
    return { graph: hideInDrawing(view.graph, hidden), subject: stormingSheetSubject(storming, options), legend: 'storming' };
}

/** The domain model's view the options name. */
async function modelDiagram(views: DiagramViews, o: SvgExportOptions): Promise<Chosen> {
    const { payload } = views;
    if (!payload.model) throw new SvgExportError('The model has syntax errors or no .dt file; run `dt check` and fix them first.', 1);
    if ((o.view ?? 'structure') === 'map') {
        const all = o.all === true;
        const graph = all ? payload.contextMapAll : payload.contextMap;
        if (!graph) throw new SvgExportError('The model has no Context Map to draw.', 1);
        return { graph, subject: { view: 'contextMap', all }, legend: 'contextMap' };
    }
    const level: StructureLevel = o.level !== undefined && isStructureLevel(o.level) ? o.level : 'detail';
    const legendOf = (focused: boolean): LegendView => `${level === 'aggregates' ? 'aggregates' : 'structure'}${focused ? 'Focus' : ''}`;
    const contexts = [...new Set(o.context ?? [])];
    if (!contexts.length) {
        const graph = level === 'detail' ? payload.structure : level === 'overview' ? payload.overview : payload.aggregates;
        if (!graph) throw new SvgExportError('The model has no Structure View to draw.', 1);
        return { graph, subject: { view: 'structure', level, contexts: [] }, legend: legendOf(false) };
    }
    const unknown = contexts.filter((c) => !payload.focusContexts.includes(c));
    if (unknown.length) {
        throw new SvgExportError(`Unknown context ${unknown.map((c) => `'${c}'`).join(', ')}. Contexts: ${listed(payload.focusContexts)}`, 1);
    }
    const graph = await views.focusGraph(contexts, level);
    if (!graph) throw new SvgExportError(`Nothing to draw for ${contexts.join(', ')}.`, 1);
    const label = (id: string): string | undefined => payload.model?.contexts.find((c) => c.name === id)?.label;
    return { graph, subject: { view: 'structure', level, contexts: contexts.map((id) => ({ id, label: label(id) })) }, legend: legendOf(true) };
}

/**
 * The diagram the options name, drawn as the Live View's 書き出し → SVG draws it: the heading (`workspace`, the root's
 * name, first) and the legend if asked, in the theme's colours and the language's words.
 */
export async function exportSvg(views: DiagramViews, workspace: string, o: SvgExportOptions): Promise<string> {
    const chosen = o.storming !== undefined ? stormingDiagram(views.payload.stormings, o) : await modelDiagram(views, o);
    const t = DIAGRAM_TEXTS[o.lang];
    const tokens = styleTokens(styles);
    const fonts = styleFonts(tokens);
    const { payload } = views;
    const drawn = portableSvg({
        scene: buildScene(chosen.graph, { diff: { added: [], changed: [], removed: [] }, diagnostics: payload.diagnostics, mode: o.names, lang: o.lang }),
        bounds: exportBounds(chosen.graph),
        heading: o.heading ? sheetHeading(workspace, chosen.subject, t, o.names) : undefined,
        legend: o.legend ? { title: t.legend, content: legendContent(chosen.legend, t), kindNames: legendKindNames(t) } : undefined,
        palette: stylePalette(tokens, o.theme),
        fonts,
        measure: tableMeasure(fonts),
        // white in the light theme, as the page exports; the dark canvas's own background in the dark one
        paper: o.theme === 'dark' ? tokenColour(tokens, 'dark', '--canvas-bg') : undefined,
    });
    return drawn.svg;
}
