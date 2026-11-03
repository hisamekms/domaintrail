// What `/` lists in the composer (the plan's "message templates", round 4, and "`/` commands", round 5), without
// React: the commands (`/es`, `/model`: each starts an interview with the AI) and the templates (built in, then the
// team's from `domaintrail.jsonc`: each only puts its text in the composer). The list depends on what is open and
// selected (`TemplateContext`); filtering after `/` matches an item's stable English ID and its name in the UI
// language. A template's `{target}` is where the selected element goes, as a `#` mention and the message's target.
import { tokenName, type InterviewCommandId, type TemplateContext } from '@domaintrail/collaboration';
import type { MessageTemplateBody, SessionStateBody } from '@domaintrail/collaboration/protocol';
import type { Lang } from '@domaintrail/visualization';
import type { ComposerValue, MentionCandidate } from './mentions';
import { targetKey, type TargetDraft } from './targets';

/** The commands' IDs, in the order `/` lists them. */
const COMMAND_IDS: readonly InterviewCommandId[] = ['es', 'model'];

/** A text in each UI language. */
export type Localized = Readonly<Record<Lang, string>>;

/** A template: its stable ID, its name and text in each language, and where it is offered (absent: everywhere). */
export interface MessageTemplate {
    readonly id: string;
    readonly name: Localized;
    readonly text: Localized;
    readonly when?: readonly TemplateContext[];
    /** The team's (`templates` in domaintrail.jsonc), shown after the built-in ones. */
    readonly team?: boolean;
}

/** The built-in templates, short beginnings of a message for Event Storming and modeling. */
export const BUILT_IN_TEMPLATES: readonly MessageTemplate[] = [
    {
        id: 'next-events',
        name: { ja: 'このあとを足す', en: 'Add what comes next' },
        text: { ja: 'このあとに起きることを足して', en: 'Add the events that happen next' },
        when: ['big-picture'],
    },
    {
        id: 'around',
        name: { ja: '前後を詰める', en: 'Fill in around it' },
        text: { ja: '{target} の前後を詰めて', en: 'Fill in what happens before and after {target}' },
        when: ['event'],
    },
    {
        id: 'hotspots',
        name: { ja: '迷いどころを挙げる', en: 'Raise hotspots' },
        text: { ja: '迷っているところや抜けをホットスポットにして', en: 'Mark what is unclear or missing as hotspots' },
        when: ['storming'],
    },
    {
        id: 'commands',
        name: { ja: 'コマンドとポリシーを足す', en: 'Add commands and policies' },
        text: { ja: 'イベントごとにコマンドとポリシーを足して', en: 'Add the commands and policies of each event' },
        when: ['design-level'],
    },
    {
        id: 'invariants',
        name: { ja: '不変条件を挙げる', en: 'List the invariants' },
        text: { ja: '{target} の不変条件を一覧にして', en: 'List the invariants of {target}' },
        when: ['aggregate'],
    },
    {
        id: 'states',
        name: { ja: '状態を見直す', en: 'Review the states' },
        text: { ja: '{target} の状態と遷移を見直して', en: 'Review the states and transitions of {target}' },
        when: ['aggregate', 'state'],
    },
    {
        id: 'explain',
        name: { ja: '説明してもらう', en: 'Explain it' },
        text: { ja: '{target} を説明して', en: 'Explain {target}' },
        when: ['element'],
    },
    {
        id: 'review',
        name: { ja: '気になる点を挙げる', en: 'Point out issues' },
        text: { ja: 'このモデルで気になるところを挙げて', en: 'Point out what looks off in this model' },
        when: ['model'],
    },
];

/** What the page shows: the view's kind and a storming's level, and the element selected (with its kind). */
export interface SlashScope {
    readonly view: { readonly kind: 'storming'; readonly level: string } | { readonly kind: 'model' } | { readonly kind: 'other' };
    readonly selected?: { readonly target: TargetDraft; readonly kind?: MentionCandidate['kind']; readonly mention?: string };
}

/** The template contexts a scope is in. */
export function templateContexts(scope: SlashScope): ReadonlySet<TemplateContext> {
    const out = new Set<TemplateContext>();
    if (scope.view.kind === 'storming') {
        out.add('storming');
        out.add(scope.view.level === 'big-picture' ? 'big-picture' : 'design-level');
    } else if (scope.view.kind === 'model') out.add('model');
    const selected = scope.selected;
    if (!selected) {
        out.add('none');
        return out;
    }
    out.add('element');
    const t = selected.target.target;
    const kind = selected.kind?.kind;
    if (t.kind === 'DtesOccurrence' || kind === 'event') out.add('event');
    if (kind === 'aggregate') out.add('aggregate');
    if (kind === 'state' || (t.kind === 'DtElement' && t.element.includes('#'))) out.add('state');
    return out;
}

/** A team's template as the page uses it: its name and text in both languages (one text stands for both). */
export function teamTemplate(t: MessageTemplateBody): MessageTemplate {
    const both = (v: MessageTemplateBody['name']): Localized => (typeof v === 'string' ? { ja: v, en: v } : { ja: v.ja ?? v.en ?? '', en: v.en ?? v.ja ?? '' });
    return { id: t.id, name: both(t.name), text: both(t.text), ...(t.when && { when: t.when }), team: true };
}

/** One entry after `/`: a command (starts an interview) or a template (puts its text in the composer). */
export type SlashItem =
    | { readonly kind: 'command'; readonly id: InterviewCommandId; readonly name: string }
    | { readonly kind: 'template'; readonly id: string; readonly name: string; readonly template: MessageTemplate };

/** Whether `text` in the composer is a `/` query: `/` then the query, nothing else (no line, no space). */
export function slashQuery(text: string): string | undefined {
    const m = /^\/([^\s/]{0,40})$/u.exec(text);
    return m ? m[1] : undefined;
}

/** Whether an item's ID or name matches a query (ignoring case and width). */
function matches(id: string, name: string, query: string): boolean {
    if (!query) return true;
    const q = query.normalize('NFKC').toLowerCase();
    return id.toLowerCase().includes(q) || name.normalize('NFKC').toLowerCase().includes(q);
}

/**
 * What `/` lists for a query: the commands first (only for who may start one, and while none runs), then the templates
 * offered in the scope's contexts — the built-in ones, then the team's — in the UI language. Items whose ID starts
 * with the query come before those that only contain it.
 */
export function slashItems(input: {
    readonly query: string;
    readonly lang: Lang;
    readonly scope: SlashScope;
    readonly commandNames: Readonly<Record<InterviewCommandId, string>>;
    /** The person may start an interview now: the facilitator (in Solo, the person) and none runs. */
    readonly canStart: boolean;
    readonly team?: readonly MessageTemplateBody[];
}): SlashItem[] {
    const { query, lang, scope } = input;
    const contexts = templateContexts(scope);
    const commands: SlashItem[] = input.canStart
        ? COMMAND_IDS.map((id): SlashItem => ({ kind: 'command', id, name: input.commandNames[id] })).filter((c) => matches(c.id, c.name, query))
        : [];
    const offered = (t: MessageTemplate): boolean => !t.when || t.when.some((w) => contexts.has(w));
    // a template that needs the selection is offered only with one
    const fits = (t: MessageTemplate): boolean => !t.text[lang].includes('{target}') || scope.selected !== undefined;
    const templates = [...BUILT_IN_TEMPLATES, ...(input.team ?? []).map(teamTemplate)]
        .filter((t) => offered(t) && fits(t))
        .map((t): SlashItem => ({ kind: 'template', id: t.id, name: t.name[lang], template: t }))
        .filter((t) => matches(t.id, t.name, query));
    const prefix = (i: SlashItem): number => (query && i.id.startsWith(query.toLowerCase()) ? 0 : 1);
    return [...commands.sort((a, b) => prefix(a) - prefix(b)), ...templates.sort((a, b) => prefix(a) - prefix(b))];
}

/**
 * The composer after picking a template: its text in the UI language, the selected element as the message's target and
 * `#` mention where the text says `{target}` (the composer's other targets and people are dropped with the `/` text).
 */
export function templateValue(template: MessageTemplate, lang: Lang, selected: SlashScope['selected']): ComposerValue {
    const text = template.text[lang];
    if (!selected || !text.includes('{target}')) return { text, chips: [], people: [] };
    const name = tokenName(selected.mention ?? selected.target.label ?? 'target');
    return { text: text.replaceAll('{target}', `#${name}[1]`), chips: [{ target: selected.target, mentioned: true }], people: [] };
}

/** The selected element with its kind and mention name, from `#`'s candidates (by its key). */
export function selectedOf(target: TargetDraft | undefined, candidates: readonly MentionCandidate[]): SlashScope['selected'] {
    if (!target) return undefined;
    const c = candidates.find((x) => x.key === targetKey(target.target));
    return { target, ...(c && { kind: c.kind, mention: c.mention }) };
}

/** The interview running in the session, if any. */
export function runningInterview(state: Pick<SessionStateBody, 'interviews'>): InterviewJson | undefined {
    return (state.interviews ?? []).find((i) => i.state === 'Asking' || i.state === 'Briefed');
}

export type InterviewJson = NonNullable<SessionStateBody['interviews']>[number];
