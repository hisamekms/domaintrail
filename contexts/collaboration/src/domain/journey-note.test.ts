// dt's note after a brief is confirmed (journey-note.ts): line 1 for each thing decided (an existing storming's journey
// added, a new storming created or not, a revision with the fields that changed, a participant's brief approved, a
// modeling journey added), line 2 from the guide's map of the journey (its 📍 step and the next step's command or place),
// in Japanese and English.
import { describe, expect, test } from 'bun:test';
import { analyzeDomain } from '@domaintrail/modeling';
import { analyzeStormings } from '@domaintrail/storming';
import type { Collaboration } from '../generated/index.js';
import type { GuideWorkspace } from './guide.js';
import { changedBriefFields, decidedOf, journeyNext, journeyNote } from './journey-note.js';
import { journeySummaries, type EsJourneyEntry, type JourneyFile, type ModelJourneyEntry } from './journey.js';

async function workspace(files: Record<string, string>, journey?: JourneyFile): Promise<GuideWorkspace> {
    const sources = Object.entries(files).map(([p, text]) => ({ path: p, text }));
    const domain = await analyzeDomain(sources.filter((s) => s.path.endsWith('.dt')));
    const es = await analyzeStormings(
        sources.filter((s) => s.path.endsWith('.dtes')),
        domain.model,
    );
    return { model: domain.model ?? null, stormings: es.stormings, diagnostics: [...domain.diagnostics, ...es.diagnostics], ...(journey && { journey }) };
}

const stages = async (): Promise<string> => Bun.file(new URL('../../../../test/fixtures/stages/convenience-store-stages.dtes', import.meta.url)).text();

const esEntry = (more: Partial<EsJourneyEntry> = {}): EsJourneyEntry => ({
    purpose: '交付の流れをつかむ',
    participants: ['窓口担当'],
    use: 'align',
    level: 'BigPicture',
    state: 'active',
    marks: [],
    ...more,
});
const modelEntry = (more: Partial<ModelJourneyEntry> = {}): ModelJourneyEntry => ({
    id: 'issuance',
    name: '交付のモデル',
    purpose: 'BC を切り出す',
    participants: [],
    pattern: 'FromStorming',
    from: { stormings: ['ConvenienceStoreIssuance'] },
    goal: 'invariants',
    state: 'active',
    marks: { steps: [], contexts: {} },
    ...more,
});
const file = (stormings: Record<string, EsJourneyEntry> = {}, modeling: ModelJourneyEntry[] = []): JourneyFile => ({ version: 1, stormings, modeling });

const ES_KEY = 'es:ConvenienceStoreIssuance';
const LABEL = '住民票などのコンビニ交付（ビッグピクチャ）';

describe('line 1: what was decided', () => {
    test('an existing storming: the brief confirmed, the journey added with its goal', async () => {
        const ws = await workspace({ 'a.dtes': await stages() }, file({ ConvenienceStoreIssuance: esEntry() }));
        const ja = journeyNote({ journey: ES_KEY, decided: { kind: 'esAdded', label: LABEL, level: 'BigPicture' }, language: 'Ja', workspace: ws });
        expect(ja.body.split('\n')[0]).toBe(`ブリーフを確定しました。ジャーニーに「${LABEL}」を加えました（ゴール：ビッグピクチャー）。`);
        const en = journeyNote({ journey: ES_KEY, decided: { kind: 'esAdded', label: 'Issuance', level: 'DesignLevel' }, language: 'En', workspace: ws });
        expect(en.body.split('\n')[0]).toBe('Brief confirmed. Added “Issuance” to the journeys (goal: Design Level).');
    });

    test('a new storming: created and added once its run ended; first the events, with no button', () => {
        const ja = journeyNote({ journey: 'es:Returns', decided: { kind: 'esCreated', label: '返品', level: 'BigPicture' }, language: 'Ja' });
        expect(ja.body).toBe(
            'ストーミング「返品」を作り、ジャーニーに加えました（ゴール：ビッグピクチャー）。\nまず出来事を出します。起きたことを話してください。',
        );
        expect(ja.note).toEqual({ journey: 'es:Returns' as Collaboration.GuideJourneyKey, targets: [] });
        const en = journeyNote({ journey: 'es:Returns', decided: { kind: 'esCreated', label: 'Returns', level: 'BigPicture' }, language: 'En' });
        expect(en.body).toBe('Created the storming “Returns” and added it to the journeys (goal: Big Picture).\nFirst, the events: tell what happens.');
    });

    test('a new storming whose run did not complete: said briefly, one line, the journey kept', () => {
        expect(journeyNote({ journey: 'es:Returns', decided: { kind: 'esNotCreated', label: '返品' }, language: 'Ja' }).body).toBe(
            'ストーミング「返品」を作れませんでした。ジャーニーはそのまま残しています。',
        );
        expect(journeyNote({ journey: 'es:Returns', decided: { kind: 'esNotCreated', label: 'Returns' }, language: 'En' }).body).toBe(
            'Could not create the storming “Returns”. Its journey is kept as written.',
        );
    });

    test('a revision: only the fields that changed, or that none did', () => {
        const ja = journeyNote({ journey: 'es:Returns', decided: { kind: 'revised', changed: ['purpose', 'level'] }, language: 'Ja' });
        expect(ja.body.split('\n')[0]).toBe('ブリーフを見直しました（目的・レベルが変わりました）。');
        const en = journeyNote({ journey: 'es:Returns', decided: { kind: 'revised', changed: ['scope', 'participants'] }, language: 'En' });
        expect(en.body.split('\n')[0]).toBe('Brief revised (changed: scope, people).');
        expect(journeyNote({ journey: 'es:Returns', decided: { kind: 'revised', changed: [] }, language: 'Ja' }).body.split('\n')[0]).toBe(
            'ブリーフを見直しました（変わったところはありません）。',
        );
    });

    test("a participant's brief approved by the facilitator: by their name", () => {
        const added = journeyNote({
            journey: 'es:Returns',
            decided: { kind: 'esAdded', label: '返品', level: 'BigPicture' },
            language: 'Ja',
            approvedBy: '佐藤',
        });
        expect(added.body.split('\n')[0]).toBe('佐藤が承認し、ジャーニーに加えました（ゴール：ビッグピクチャー）。');
        const model = journeyNote({
            journey: 'issuance',
            decided: { kind: 'modelAdded', name: '交付', pattern: 'OneContext', goal: 'commands' },
            language: 'En',
            approvedBy: 'Sato',
        });
        expect(model.body.split('\n')[0]).toBe('Sato approved it and added it to the journeys (One BC in depth → Commands).');
        const created = journeyNote({
            journey: 'es:Returns',
            decided: { kind: 'esCreated', label: '返品', level: 'BigPicture' },
            language: 'Ja',
            approvedBy: '佐藤',
        });
        expect(created.body.split('\n')[0]).toBe('佐藤が承認し、ストーミング「返品」を作ってジャーニーに加えました（ゴール：ビッグピクチャー）。');
        const revised = journeyNote({ journey: 'es:Returns', decided: { kind: 'revised', changed: ['goal'] }, language: 'Ja', approvedBy: '佐藤' });
        expect(revised.body.split('\n')[0]).toBe('佐藤が承認し、ブリーフを見直しました（ゴールが変わりました）。');
    });

    test('a modeling journey: its name, pattern and goal', async () => {
        const ws = await workspace({ 'a.dtes': await stages() }, file({}, [modelEntry()]));
        const ja = journeyNote({
            journey: 'issuance',
            decided: { kind: 'modelAdded', name: '交付のモデル', pattern: 'FromStorming', goal: 'invariants' },
            language: 'Ja',
            workspace: ws,
        });
        expect(ja.body.split('\n')[0]).toBe('ジャーニーに「交付のモデル」を加えました（ES から → 不変条件）。');
        const en = journeyNote({
            journey: 'issuance',
            decided: { kind: 'modelAdded', name: 'Issuance', pattern: 'Whole', goal: 'contextMap' },
            language: 'En',
            workspace: ws,
        });
        expect(en.body.split('\n')[0]).toBe('Added “Issuance” to the journeys (From the whole → Context map).');
    });
});

describe('line 2: where the journey is, and the next step', () => {
    test('ES at the exceptions: the stage without one, and /es:exceptions', async () => {
        const ws = await workspace({ 'a.dtes': await stages() }, file({ ConvenienceStoreIssuance: esEntry() }));
        const ja = journeyNext({ journey: ES_KEY, language: 'Ja', workspace: ws });
        expect(ja).toEqual({ text: 'いまは「例外」の段階です。次は「依頼・準備」の例外を出しましょう。', command: 'EsExceptions', targets: [] });
        expect(journeyNext({ journey: ES_KEY, language: 'En', workspace: ws }).text).toBe('You are at “Exceptions”. Next, the exceptions of “依頼・準備”.');
        // the note keeps the command for its button
        const note = journeyNote({ journey: ES_KEY, decided: { kind: 'esAdded', label: LABEL, level: 'BigPicture' }, language: 'Ja', workspace: ws });
        expect(note.note.command).toBe('EsExceptions');
    });

    test('ES with a few events: more events; a storming with none: first the events', async () => {
        const few = await workspace({ 'a.dtes': 'storming Returns "返品" {\n  event Requested\n}' }, file({ Returns: esEntry() }));
        expect(journeyNext({ journey: 'es:Returns', language: 'Ja', workspace: few })).toEqual({
            text: 'いまは「出来事」の段階です。起きたことをもっと話してください。',
            targets: [],
        });
        const none = await workspace({ 'a.dtes': 'storming Returns "返品" {\n}' }, file({ Returns: esEntry() }));
        expect(journeyNext({ journey: 'es:Returns', language: 'Ja', workspace: none }).text).toBe('まず出来事を出します。起きたことを話してください。');
    });

    test('ES at its goal: /model:start when it leads into modeling, else /es:recap', async () => {
        const src = await stages();
        const marks = ['exceptions', 'questions'];
        const toModel = await workspace({ 'a.dtes': src }, file({ ConvenienceStoreIssuance: esEntry({ use: 'modeling', marks }) }));
        expect(journeyNext({ journey: ES_KEY, language: 'Ja', workspace: toModel })).toEqual({
            text: 'ゴールに着いています。次はモデリングを始めましょう。',
            command: 'ModelStart',
            targets: [],
        });
        const align = await workspace({ 'a.dtes': src }, file({ ConvenienceStoreIssuance: esEntry({ marks }) }));
        expect(journeyNext({ journey: ES_KEY, language: 'En', workspace: align })).toEqual({
            text: 'The goal is reached. Recap what you have.',
            command: 'EsRecap',
            targets: [],
        });
    });

    test('modeling from a storming: review it, then carve the BCs, each with the source storming to show', async () => {
        const ws = await workspace({ 'a.dtes': await stages() }, file({ ConvenienceStoreIssuance: esEntry() }, [modelEntry()]));
        const storming = [{ kind: 'DtesStorming', storming: 'ConvenienceStoreIssuance' }] as unknown as Collaboration.ModelTarget[];
        expect(journeyNext({ journey: 'issuance', language: 'Ja', workspace: ws })).toEqual({
            text: 'いまは「ES を見直す」の段階です。次はもとのストーミングを見直しましょう。',
            targets: storming,
        });
        const reviewed = await workspace(
            { 'a.dtes': await stages() },
            file({ ConvenienceStoreIssuance: esEntry() }, [modelEntry({ marks: { steps: ['review'], contexts: {} } })]),
        );
        expect(journeyNext({ journey: 'issuance', language: 'Ja', workspace: reviewed })).toEqual({
            text: 'いまは「BC を切り出す」の段階です。次はストーミングから BC を切り出しましょう。',
            targets: storming,
        });
        expect(journeyNext({ journey: 'issuance', language: 'En', workspace: reviewed }).text).toBe(
            'You are at “Carve the BCs”. Next, carve the BCs from the storming.',
        );
    });

    test('modeling one BC in depth: the step here, no button', async () => {
        const ws = await workspace(
            { 'a.dt': 'context Billing {\n}' },
            file({}, [modelEntry({ pattern: 'OneContext', from: { context: 'Billing' }, goal: 'commands' })]),
        );
        expect(journeyNext({ journey: 'issuance', language: 'Ja', workspace: ws })).toEqual({
            text: 'いまは「用語」の段階です。次は用語を出しましょう。',
            targets: [],
        });
        expect(journeyNext({ journey: 'issuance', language: 'En', workspace: ws }).text).toBe('You are at “Terms”. Next, list the terms.');
    });
});

describe('what a confirmed brief decided', () => {
    const brief = (more: Partial<Collaboration.InterviewBrief> = {}): Collaboration.InterviewBrief =>
        ({ name: 'Returns', isNew: false, replaces: false, text: '目的: x', ...more }) as Collaboration.InterviewBrief;

    test('added (existing or new storming), revised with the fields that changed, a modeling journey', () => {
        const after = file({ Returns: esEntry() });
        expect(decidedOf({ brief: brief(), key: 'es:Returns', before: file(), after, label: '返品' })).toEqual({
            kind: 'esAdded',
            label: '返品',
            level: 'BigPicture',
        });
        expect(decidedOf({ brief: brief({ isNew: true, label: '返品' as Collaboration.BriefLabel }), key: 'es:Returns', before: undefined, after })).toEqual({
            kind: 'esCreated',
            label: '返品',
            level: 'BigPicture',
        });
        const revised = file({ Returns: esEntry({ purpose: '別の目的', level: 'DesignLevel' }) });
        expect(decidedOf({ brief: brief(), key: 'es:Returns', before: after, after: revised })).toEqual({ kind: 'revised', changed: ['purpose', 'level'] });
        expect(decidedOf({ brief: brief(), key: 'issuance', before: file(), after: file({}, [modelEntry()]) })).toEqual({
            kind: 'modelAdded',
            name: '交付のモデル',
            pattern: 'FromStorming',
            goal: 'invariants',
        });
    });

    test('the modeling fields: name, goal, pattern, source', () => {
        const [a] = journeySummaries(file({}, [modelEntry()]));
        const [b] = journeySummaries(file({}, [modelEntry({ name: '別名', goal: 'commands', from: { stormings: ['Other'] }, constraints: '半日' })]));
        if (!a || !b) throw new Error('two summaries');
        expect(changedBriefFields(a, b)).toEqual(['name', 'constraints', 'goal', 'source']);
    });
});
