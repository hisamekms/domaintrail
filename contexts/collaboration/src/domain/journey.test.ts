// The journey file (journey.ts): read against its schema (what is valid kept, each problem with its path), written
// with a stable key order (a round trip changes nothing), the acts that change it, a confirmed brief written into it,
// the current journey's default, and `dt check`'s findings on it (J001–J003, with where they are). The schema
// (schema/journey.schema.json) and the guide's engine share one vocabulary.
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Collaboration as C, type Result } from '../generated/index.js';
import { ES_LEVELS, ES_MARKABLE, GUIDE_PATTERNS, MODEL_PATTERNS, patternMarkable } from './guide-paths.js';
import {
    agentJourneys,
    applyBrief,
    applyJourneyAct,
    defaultJourney,
    EMPTY_JOURNEYS,
    journeyDiagnostics,
    journeyIdFor,
    journeyNames,
    JOURNEY_SCHEMA_REF,
    readJourney,
    writeJourney,
    type JourneyFile,
} from './journey.js';

const value = <T, E>(r: Result<T, E>): T => {
    if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
    return r.value;
};

const FILE: JourneyFile = {
    version: 1,
    stormings: {
        Issue: {
            purpose: '交付の流れをつかむ',
            scope: '申請から交付まで',
            participants: ['窓口担当'],
            use: 'modeling',
            level: 'BigPicture',
            state: 'active',
            marks: [],
        },
    },
    modeling: [
        {
            id: 'from-issue',
            name: '証明書発行の作り直し',
            purpose: '発行を作り直す',
            constraints: '住基はそのまま',
            participants: ['窓口担当', 'システム担当'],
            pattern: 'FromStorming',
            from: { stormings: ['Issue'] },
            goal: 'invariants',
            state: 'active',
            marks: { steps: ['review'], contexts: { Issuance: ['bcCarved'] } },
        },
    ],
};

describe('reading and writing', () => {
    test('a round trip changes nothing; the keys in a stable order, two-space indent, a final line break', () => {
        const text = writeJourney(FILE);
        expect(text.startsWith(`{\n  "$schema": "${JOURNEY_SCHEMA_REF}",\n  "version": 1,\n  "stormings": {\n    "Issue": {\n      "purpose"`)).toBe(true);
        expect(text.endsWith('}\n')).toBe(true);
        const read = readJourney(text);
        expect(read.problems).toEqual([]);
        expect(read.file).toEqual({ $schema: JOURNEY_SCHEMA_REF, ...FILE });
        expect(writeJourney(read.file)).toBe(text);
        // the keys as written by hand in any order come out in the schema's
        const shuffled = JSON.stringify({
            modeling: [{ ...FILE.modeling[0], marks: FILE.modeling[0]?.marks, id: 'from-issue' }],
            version: 1,
            stormings: FILE.stormings,
        });
        expect(writeJourney(readJourney(shuffled).file)).toBe(text);
    });

    test('what is valid is kept; each problem with its path (a journey with one is left out)', () => {
        const text = JSON.stringify({
            version: 1,
            stormings: { Issue: FILE.stormings.Issue, Bad: { ...FILE.stormings.Issue, level: 'Somewhere' }, '1st': FILE.stormings.Issue },
            modeling: [
                FILE.modeling[0],
                { ...FILE.modeling[0], id: 'Not A Slug' },
                { ...FILE.modeling[0], id: 'c', pattern: 'OneContext', from: { stormings: ['Issue'] }, marks: { steps: [], contexts: {} } },
                { ...FILE.modeling[0], id: 'g', goal: 'policies' },
                { ...FILE.modeling[0], id: 'm', marks: { steps: ['bcSplit'], contexts: {} } },
                FILE.modeling[0],
            ],
            extra: true,
        });
        const read = readJourney(text);
        expect(Object.keys(read.file.stormings)).toEqual(['Issue']);
        expect(read.file.modeling.map((m) => m.id)).toEqual(['from-issue']);
        expect(read.problems.map((p) => p.path)).toEqual([
            'extra',
            'stormings.Bad.level',
            'stormings["1st"]',
            'modeling[1].id',
            'modeling[2].from.stormings',
            'modeling[3].goal',
            'modeling[4].marks.steps[0]',
            'modeling[5].id',
        ]);
        // no JSON at all: no journeys, one problem
        expect(readJourney('{ "version": 1, ').problems).toHaveLength(1);
        expect(readJourney('{ "version": 1, ').file).toEqual(EMPTY_JOURNEYS);
    });
});

describe('the acts', () => {
    test('a goal changed (an ES level, a goal the pattern allows), a state set, a mark set and cleared', () => {
        const es = value(applyJourneyAct(FILE, { kind: 'goal', journey: 'es:Issue', goal: 'DesignLevel' }));
        expect(es.stormings.Issue?.level).toBe('DesignLevel');
        expect(value(applyJourneyAct(FILE, { kind: 'goal', journey: 'from-issue', goal: 'commands' })).modeling[0]?.goal).toBe('commands');
        expect(applyJourneyAct(FILE, { kind: 'goal', journey: 'from-issue', goal: 'contextMap' })).toEqual({
            ok: false,
            error: { type: 'NotAJourneyGoal', goal: 'contextMap' },
        });
        expect(value(applyJourneyAct(FILE, { kind: 'state', journey: 'es:Issue', state: 'done' })).stormings.Issue?.state).toBe('done');
        const marked = value(applyJourneyAct(FILE, { kind: 'mark', journey: 'es:Issue', step: 'questions', done: true }));
        expect(value(applyJourneyAct(marked, { kind: 'mark', journey: 'es:Issue', step: 'exceptions', done: true })).stormings.Issue?.marks).toEqual([
            'exceptions',
            'questions',
        ]);
        expect(applyJourneyAct(FILE, { kind: 'mark', journey: 'es:Issue', step: 'events', done: true })).toMatchObject({
            ok: false,
            error: { type: 'NotAJourneyMark' },
        });
        // a BC row: by the context's name, under the pattern's rows step; cleared, the context's key goes
        const row = value(applyJourneyAct(FILE, { kind: 'mark', journey: 'from-issue', step: 'bcCarved', context: 'Billing', done: true }));
        expect(row.modeling[0]?.marks.contexts).toEqual({ Issuance: ['bcCarved'], Billing: ['bcCarved'] });
        expect(
            value(applyJourneyAct(row, { kind: 'mark', journey: 'from-issue', step: 'bcCarved', context: 'Issuance', done: false })).modeling[0]?.marks
                .contexts,
        ).toEqual({
            Billing: ['bcCarved'],
        });
        expect(applyJourneyAct(FILE, { kind: 'state', journey: 'nope', state: 'done' })).toEqual({
            ok: false,
            error: { type: 'JourneyNotFound', journey: 'nope' },
        });
    });

    test('a confirmed brief: an ES journey created or revised (where it stands kept), a modeling journey new or continued', () => {
        const j = (over: Partial<C.JourneyBrief>): C.JourneyBrief =>
            ({ purpose: '目的', participants: [], stormings: [], continues: false, ...over }) as unknown as C.JourneyBrief;
        const brief = (name: string, journey: C.JourneyBrief, isNew = true): C.InterviewBrief =>
            ({ name, isNew, replaces: !isNew, text: '目的: 目的', journey }) as unknown as C.InterviewBrief;
        const marked = value(applyJourneyAct(FILE, { kind: 'mark', journey: 'es:Issue', step: 'questions', done: true }));
        const revised = value(applyBrief(marked, 'Es', brief('Issue', j({ use: 'Align', level: 'DesignLevel' }), false)));
        expect(revised.key).toBe('es:Issue');
        expect(revised.file.stormings.Issue).toEqual({
            purpose: '目的',
            participants: [],
            use: 'align',
            level: 'DesignLevel',
            state: 'active',
            marks: ['questions'],
        });
        const created = value(applyBrief(FILE, 'Es', brief('Returns', j({ use: 'Modeling', level: 'BigPicture' }))));
        expect(Object.keys(created.file.stormings)).toEqual(['Issue', 'Returns']);
        // modeling: new (a taken ID gets the next), continued (its marks kept while its pattern is)
        const fresh = value(applyBrief(FILE, 'Model', brief('from-issue', j({ pattern: 'Review', journeyName: 'From Issue' as C.JourneyName }))));
        expect(fresh.file.modeling.map((m) => m.id)).toEqual(['from-issue', 'from-issue-2']);
        const cont = value(
            applyBrief(
                FILE,
                'Model',
                brief(
                    'from-issue',
                    j({ pattern: 'FromStorming', stormings: ['Issue'] as C.StormingName[], goal: 'commands' as C.GuideStepKey, continues: true }),
                    false,
                ),
            ),
        );
        expect(cont.file.modeling[0]).toMatchObject({ id: 'from-issue', name: '証明書発行の作り直し', goal: 'commands', marks: FILE.modeling[0]?.marks });
        expect(applyBrief(FILE, 'Model', brief('gone', j({ pattern: 'Review', continues: true }), false))).toEqual({
            ok: false,
            error: { type: 'JourneyNotFound', journey: 'gone' },
        });
        expect(applyBrief(FILE, 'Model', brief('x', j({ pattern: 'OneContext' })))).toMatchObject({ ok: false, error: { type: 'NotAJourneyBrief' } });
    });

    test('a new journey ID from its name; the current journey when none is chosen: the most recent active', () => {
        expect(journeyIdFor('Billing の深掘り', [])).toBe('billing');
        expect(journeyIdFor('Billing の深掘り', ['billing', 'billing-2'])).toBe('billing-3');
        expect(journeyIdFor('全体の見直し', [], 'review')).toBe('review');
        expect(defaultJourney(FILE)).toBe('from-issue');
        expect(defaultJourney(FILE, 'es:Issue')).toBe('es:Issue');
        const archived = value(applyJourneyAct(FILE, { kind: 'state', journey: 'from-issue', state: 'archived' }));
        expect(defaultJourney(archived, 'from-issue')).toBe('es:Issue');
        expect(defaultJourney(EMPTY_JOURNEYS)).toBeUndefined();
        expect(agentJourneys(archived).journeys.map((x) => x.key)).toEqual(['es:Issue']);
    });
});

describe('dt check on the file', () => {
    const names = journeyNames(['Issuance'], ['Issue']);

    test('J001 for each problem, where it is; J002 / J003 for a storming or context that does not exist', () => {
        const text = writeJourney({
            ...FILE,
            stormings: { ...FILE.stormings, Gone: FILE.stormings.Issue! },
            modeling: [
                ...FILE.modeling,
                { ...FILE.modeling[0]!, id: 'c', pattern: 'OneContext', from: { context: 'Billing' }, goal: 'commands', marks: { steps: [], contexts: {} } },
            ],
        });
        const found = journeyDiagnostics(text, names);
        expect(found.map((d) => [d.code, d.severity, d.start.line])).toEqual([
            ['J002', 'warning', text.split('\n').findIndex((l) => l.includes('"Gone"')) + 1],
            ['J003', 'warning', text.split('\n').findIndex((l) => l.includes('"context": "Billing"')) + 1],
        ]);
        expect(found[0]?.message).toContain("storming 'Gone'");
        const broken = text.replace('"level": "BigPicture"', '"level": "Somewhere"');
        const errors = journeyDiagnostics(broken, names).filter((d) => d.code === 'J001');
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ severity: 'error', start: { line: broken.split('\n').findIndex((l) => l.includes('Somewhere')) + 1 } });
        // not JSON: one error at the place
        expect(journeyDiagnostics('{\n  "version": 1,\n  oops\n}', names)).toMatchObject([{ code: 'J001', start: { line: 3, column: 3 } }]);
        expect(journeyDiagnostics(writeJourney(FILE), names)).toEqual([]);
    });
});

describe('the schema', () => {
    test('schema/journey.schema.json has the vocabulary of the guide: the patterns, their goals and marks, the levels', async () => {
        const schema = JSON.parse(await readFile(path.join(import.meta.dir, '../../../../schema/journey.schema.json'), 'utf8'));
        const defs = schema.definitions;
        expect(defs.esJourney.properties.level.enum).toEqual([...ES_LEVELS]);
        expect(defs.esJourney.properties.marks.items.enum).toEqual([...ES_MARKABLE]);
        expect(defs.modelJourney.properties.pattern.enum).toEqual([...GUIDE_PATTERNS]);
        for (const branch of defs.modelJourney.allOf) {
            const pattern = branch.if.properties.pattern.const as C.GuidePattern;
            const then = branch.then.properties;
            expect(then.goal.enum).toEqual([...MODEL_PATTERNS[pattern].goals]);
            const marks = patternMarkable(pattern);
            expect(marks.length ? then.marks.properties.steps.items.enum : []).toEqual([...marks]);
            expect(then.marks.properties.contexts.additionalProperties.items.const).toBe(MODEL_PATTERNS[pattern].rowsAt);
        }
        expect(defs.modelJourney.allOf.map((b: { if: { properties: { pattern: { const: string } } } }) => b.if.properties.pattern.const)).toEqual([
            ...GUIDE_PATTERNS,
        ]);
        // the file dt writes names this schema
        expect(writeJourney(FILE)).toContain(JOURNEY_SCHEMA_REF);
    });
});
