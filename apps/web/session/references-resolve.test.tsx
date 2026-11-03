// Element references of the AI as the chat resolves and shows them (references.ts, targets.ts `resolveTarget`): every
// kind of storming declaration — notes, timelines, exceptions, groups, stages — and the storming itself, by ID or label;
// the forms the AI writes besides the canonical one; inside each Markdown construct of an answer (code stays code); the
// views a click opens; and the other places that show the AI's words (the triage record, the proposal chips).
import { beforeAll, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MESSAGES } from '../i18n';
import { check } from '../test-helpers';
import type { TriageRecord } from './ai';
import { ChatProvider, type ChatContextValue } from './chat-context';
import { MarkdownText } from './markdown-text';
import { TargetNamingProvider } from './naming';
import { targetLabel } from './proposal-view';
import { parseReplyText, referencesAsText, referenceText } from './references';
import { resolveTarget, viewOfDeclaration, type ModelTarget, type NamingContext } from './targets';
import { TriageRecordPanel } from './triage-record';

// a storming with a declaration of every kind, a stage holding a timeline, an exception and a group
const DTES = `storming Kyushoku "給食当番" {
  event SmockPutOn "白衣を着た"
  event HandsWashed "手を洗った"
  event Served "配った"
  event Spilled "こぼした"
  event Cleaned "掃除した"
  event Returned "食缶を戻した"
  command PutOnSmock "白衣を着る" { actor Toban emits SmockPutOn }
  actor Toban "給食当番"
  external Kitchen "給食室"
  policy WhenSpilled "こぼしたら" { on Spilled issues PutOnSmock }
  aggregate Shokkan "食缶"
  readmodel Menu "献立"
  hotspot WhoCleans "誰が掃除する？" { on Cleaned }

  timeline Normal "いつもの流れ" {
    SmockPutOn
    HandsWashed
    Served
    group CleaningAndReturning "掃除と返却" {
      Cleaned
      Returned
    }
  }
  stage Lunch "給食" {
    timeline LunchFlow "給食の流れ" {
      HandsWashed
      Served
    }
    exception SpilledInHallway "廊下でこぼした" {
      Served
      Spilled
      then Served
    }
  }
}
`;

let naming: NamingContext;
let storming: NamingContext['stormings'][number]['storming'];
beforeAll(async () => {
    const a = await check({ 'kyushoku.dtes': DTES });
    const s = a.stormings.stormings[0];
    if (!s) throw new Error('no storming');
    storming = s;
    naming = { mode: 'label', model: a.model ?? null, stormings: [{ id: s.id, storming: s }] };
});

/** The one reference of a text, as the chat shows it. */
function shown(text: string, mode: NamingContext['mode'] = 'label'): ReturnType<typeof referenceText> {
    const ref = parseReplyText(text).find((s) => s.kind === 'ref');
    if (ref?.kind !== 'ref') throw new Error(`no reference in ${text}`);
    return referenceText(ref, { ...naming, mode });
}

describe('a reference to each kind of storming declaration resolves', () => {
    test.each([
        ['event', 'SmockPutOn', '白衣を着た'],
        ['command', 'PutOnSmock', '白衣を着る'],
        ['actor', 'Toban', '給食当番'],
        ['external', 'Kitchen', '給食室'],
        ['policy', 'WhenSpilled', 'こぼしたら'],
        ['aggregate', 'Shokkan', '食缶'],
        ['read model', 'Menu', '献立'],
        ['hotspot', 'WhoCleans', '誰が掃除する？'],
        ['timeline', 'Normal', 'いつもの流れ'],
        ['group', 'CleaningAndReturning', '掃除と返却'],
        ['stage', 'Lunch', '給食'],
        ['timeline in a stage', 'LunchFlow', '給食の流れ'],
        ['exception', 'SpilledInHallway', '廊下でこぼした'],
    ])('%s `@{es:Kyushoku/%s}`: its label, a link, the storming in the path', (_kind, id, label) => {
        expect(shown(`@{es:Kyushoku/${id}}`)).toEqual({ text: label, resolved: true, path: `給食当番 / ${label}` });
        expect(shown(`@{es:Kyushoku/${id}}`, 'name')).toMatchObject({ text: id, resolved: true });
        expect(shown(`@{es:Kyushoku/${id}}`, 'both')).toMatchObject({ text: `${label} (${id})`, resolved: true });
    });

    test('the storming itself `@{es:Kyushoku}`: its title', () => {
        expect(shown('@{es:Kyushoku}')).toEqual({ text: '給食当番', resolved: true });
        expect(shown('@{es:Kyushoku}', 'name')).toEqual({ text: 'Kyushoku', resolved: true });
    });

    test('one that does not exist (renamed, removed) is its identifier, not a link', () => {
        expect(shown('@{es:Kyushoku/HappyPath}')).toEqual({ text: 'HappyPath', resolved: false });
        expect(shown('@{es:Gone}')).toEqual({ text: 'Gone', resolved: false });
        expect(shown('@{es:Gone/SmockPutOn}')).toEqual({ text: 'SmockPutOn', resolved: false });
    });
});

describe('the forms the AI writes besides the canonical one', () => {
    test('by label instead of ID (the storming, an element), when the label names one declaration', () => {
        expect(shown('@{es:Kyushoku/いつもの流れ}')).toMatchObject({ text: 'いつもの流れ', resolved: true });
        expect(shown('@{es:給食当番}')).toEqual({ text: '給食当番', resolved: true });
        expect(shown('@{es:給食当番/白衣を着た}', 'name')).toMatchObject({ text: 'SmockPutOn', resolved: true });
    });

    test('`es:` left out: a storming or its element named like a `.dt` element', () => {
        expect(shown('@{Kyushoku/Normal}')).toMatchObject({ text: 'いつもの流れ', resolved: true });
        expect(shown('@{Kyushoku}')).toEqual({ text: '給食当番', resolved: true });
        // still a `.dt` identifier when nothing resolves
        expect(shown('@{Sales.Gone}')).toEqual({ text: 'Sales.Gone', resolved: false });
    });

    test('a path through a timeline: its last segment', () => {
        expect(shown('@{es:Kyushoku/Normal/Served}')).toMatchObject({ text: '配った', resolved: true, path: '給食当番 / 配った' });
        expect(shown('@{es:Kyushoku/Normal/Gone}')).toEqual({ text: 'Gone', resolved: false });
    });

    test('spaces inside the braces or around a `/`', () => {
        expect(shown('@{ es:Kyushoku/Normal }')).toMatchObject({ text: 'いつもの流れ', resolved: true });
        expect(shown('@{es:Kyushoku / Normal}')).toMatchObject({ text: 'いつもの流れ', resolved: true });
        // a space inside a name is no identifier
        expect(parseReplyText('@{es:Kyushoku/Smock PutOn}')).toEqual([{ kind: 'text', text: 'Smock PutOn' }]);
    });

    test('the target a click goes to is the canonical one', () => {
        expect(resolveTarget({ kind: 'DtElement', element: 'Kyushoku/いつもの流れ' }, naming)).toEqual({
            kind: 'DtesElement',
            storming: 'Kyushoku',
            local: 'Normal',
        });
        expect(resolveTarget({ kind: 'DtesStorming', storming: '給食当番' }, naming)).toEqual({ kind: 'DtesStorming', storming: 'Kyushoku' });
        expect(resolveTarget({ kind: 'DtesElement', storming: 'Kyushoku', local: 'Gone' }, naming)).toBeUndefined();
    });

    test('a label two declarations share names neither', async () => {
        const a = await check({ 'x.dtes': 'storming S "S" {\n  event A "同じ"\n  event B "同じ"\n}\n' });
        const s = a.stormings.stormings[0];
        if (!s) throw new Error('no storming');
        const ctx: NamingContext = { mode: 'label', model: null, stormings: [{ id: s.id, storming: s }] };
        expect(resolveTarget({ kind: 'DtesElement', storming: 'S', local: '同じ' }, ctx)).toBeUndefined();
        expect(resolveTarget({ kind: 'DtesElement', storming: 'S', local: 'A' }, ctx)).toEqual({ kind: 'DtesElement', storming: 'S', local: 'A' });
    });
});

describe('parsing next to punctuation and line breaks', () => {
    test('「」, （）, 、。, a colon, and a line break around a reference', () => {
        const segs = parseReplyText('「@{es:Kyushoku/Normal}」（@{es:Kyushoku/Lunch}）、@{es:Kyushoku}。:@{es:Kyushoku/Served}\n@{es:Kyushoku/Spilled}');
        expect(segs.filter((s) => s.kind === 'ref').map((s) => s.kind === 'ref' && s.id)).toEqual([
            'es:Kyushoku/Normal',
            'es:Kyushoku/Lunch',
            'es:Kyushoku',
            'es:Kyushoku/Served',
            'es:Kyushoku/Spilled',
        ]);
        expect(segs.filter((s) => s.kind === 'text').map((s) => s.kind === 'text' && s.text)).toEqual(['「', '」（', '）、', '。:', '\n']);
    });

    test('as plain text for a line that is not a link (the quote of an answer)', () => {
        expect(referencesAsText('@{es:Kyushoku/Normal} に @{es:Kyushoku/Gone}', naming)).toBe('いつもの流れ に Gone');
    });
});

/** An answer rendered in the page's naming. */
const html = (text: string): string =>
    renderToStaticMarkup(
        <TargetNamingProvider value={naming}>
            <MarkdownText text={text} onNavigate={() => {}} />
        </TargetNamingProvider>,
    );
const link = (label: string): string => `<a class="reply-element" data-tooltip="給食当番 / ${label}">${label}</a>`;

describe('references inside the Markdown of an answer', () => {
    test('in a paragraph, a heading, list items (nested too), bold and italic', () => {
        const out = html(
            [
                '## @{es:Kyushoku/Normal} の流れ',
                '',
                '@{es:Kyushoku/Lunch} では',
                '',
                '- @{es:Kyushoku/SmockPutOn} のあと、group @{es:Kyushoku/CleaningAndReturning}',
                '  - @{es:Kyushoku/Returned}（当番）',
                '1. **@{es:Kyushoku/SpilledInHallway}**',
                '',
                '*@{es:Kyushoku/Kitchen}* と **依頼〜準備**（@{es:Kyushoku/Served} の後）',
            ].join('\n'),
        );
        for (const label of ['いつもの流れ', '給食', '白衣を着た', '掃除と返却', '食缶を戻した', '廊下でこぼした', '給食室', '配った'])
            expect(out).toContain(link(label));
        expect(out).toContain(`<strong>${link('廊下でこぼした')}</strong>`);
        expect(out).toContain(`<em>${link('給食室')}</em>`);
        expect(out).not.toContain('@{');
    });

    test('in table cells, several to a cell', () => {
        const out = html(
            '| 例外 | アクター |\n|---|---|\n| @{es:Kyushoku/Spilled}・@{es:Kyushoku/HandsWashed} | @{es:Kyushoku/Toban}（@{es:Kyushoku/PutOnSmock} で頼む側） |',
        );
        expect(out).toContain(`<td>${link('こぼした')}・${link('手を洗った')}</td>`);
        expect(out).toContain(`<td>${link('給食当番')}（${link('白衣を着る')} で頼む側）</td>`);
    });

    test('inside code (a span or a block) a reference stays code, as written', () => {
        const out = html('`@{es:Kyushoku/Normal}` と\n\n```\n@{es:Kyushoku/Normal}\n```');
        expect(out).toContain('<code>@{es:Kyushoku/Normal}</code>');
        expect(out).toContain('<pre class="chat-md-code"><code>@{es:Kyushoku/Normal}</code></pre>');
        expect(out).not.toContain('reply-element');
    });

    test('after a backslash escape and inside a link text', () => {
        const out = html('\\*注意\\* @{es:Kyushoku/Normal} と [@{es:Kyushoku/Lunch}](https://e.com)');
        expect(out).toContain(`*注意* ${link('いつもの流れ')}`);
        expect(out).toContain(link('給食'));
    });
});

describe('what a click opens', () => {
    test('a timeline, an exception or a stage: its own view; a group: its timeline’s; a note: none (the integrated canvas)', () => {
        expect(viewOfDeclaration(storming, 'Normal')).toBe('Normal');
        expect(viewOfDeclaration(storming, 'LunchFlow')).toBe('LunchFlow');
        expect(viewOfDeclaration(storming, 'SpilledInHallway')).toBe('SpilledInHallway');
        expect(viewOfDeclaration(storming, 'Lunch')).toBe('@Lunch');
        expect(viewOfDeclaration(storming, 'CleaningAndReturning')).toBe('Normal');
        expect(viewOfDeclaration(storming, 'SmockPutOn')).toBeUndefined();
        expect(viewOfDeclaration(storming, 'Gone')).toBeUndefined();
    });
});

describe('the same resolution elsewhere', () => {
    test('a proposal chip: a timeline, a group, a stage and a label-named element, with their kind', () => {
        const t = MESSAGES.ja;
        const es = (local: string): ModelTarget => ({ kind: 'DtesElement', storming: 'Kyushoku', local });
        expect(targetLabel(es('Normal'), naming, t)).toMatchObject({ name: 'いつもの流れ', resolved: true, detail: `${t.esKinds.timeline}・給食当番` });
        expect(targetLabel(es('CleaningAndReturning'), naming, t)).toMatchObject({
            name: '掃除と返却',
            resolved: true,
            detail: `${t.esKinds.group}・給食当番`,
        });
        expect(targetLabel(es('Lunch'), naming, t)).toMatchObject({ name: '給食', resolved: true, detail: `${t.esKinds.stage}・給食当番` });
        expect(targetLabel(es('白衣を着た'), naming, t)).toMatchObject({ name: '白衣を着た', resolved: true, detail: `${t.esKinds.event}・給食当番` });
        expect(targetLabel(es('Gone'), naming, t)).toEqual({ name: 'Gone', resolved: false });
    });

    test("the triage record: the model's reason names elements as links; an error stays as written", () => {
        const triage = {
            state: 'Decided',
            id: 't1',
            session: 's',
            request: 'm1',
            addressedBy: 'Solo',
            addressedByParticipant: 'f',
            openedAt: '2026-11-03T07:30:51.184Z',
            steps: [
                {
                    stage: 'Model',
                    verdict: 'ChangeRequest',
                    reason: 'ストーミング（@{es:Kyushoku}）の @{es:Kyushoku/Normal} に要素を追加する内容',
                    durationMs: 1,
                    at: '2026-11-03T07:30:56.510Z',
                },
                { stage: 'Clef', verdict: 'Unknown', error: '@{es:Kyushoku} failed', durationMs: 0, at: '2026-11-03T07:30:56.510Z' },
            ],
            kind: 'ChangeRequest',
            decidedBy: 'Model',
            decidedAt: '2026-11-03T07:30:56.510Z',
        } as unknown as TriageRecord;
        const chat = {
            tx: MESSAGES.ja.session,
            session: { state: { proposals: [] } },
            nameOf: (id: string) => id,
            onNavigate: () => {},
        } as unknown as ChatContextValue;
        const out = renderToStaticMarkup(
            <TargetNamingProvider value={naming}>
                <ChatProvider value={chat}>
                    <TriageRecordPanel triage={triage} onClose={() => {}} />
                </ChatProvider>
            </TargetNamingProvider>,
        );
        expect(out).toContain('ストーミング（<a class="reply-element">給食当番</a>）の');
        expect(out).toContain(link('いつもの流れ'));
        expect(out).toContain('<span class="triage-reason session-error">@{es:Kyushoku} failed</span>');
    });
});
