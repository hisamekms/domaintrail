import { describe, expect, test } from 'bun:test';
import type { SessionStateBody } from '@domaintrail/collaboration/protocol';
import type { ElementChange } from './changes';
import { beginMessage, elementActivity, targetsElement } from './element-activity';
import { EMPTY_COMPOSER } from './mentions';
import type { TargetDraft } from './targets';
import { MESSAGES } from '../i18n';

type RunJson = SessionStateBody['runs'][number];
type RequestJson = SessionStateBody['requests'][number];

const at = (minute: number): string => `2026-11-03T09:${String(minute).padStart(2, '0')}:00.000Z`;
const el = { storming: 'S', local: 'PinForgotten' };
const snapshot = (target: object): RequestJson['targets'][number] =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a target as the server sends it
    ({ target, sourceRevision: 'r0' }) as unknown as RequestJson['targets'][number];
const element = (local: string) => snapshot({ kind: 'DtesElement', storming: 'S', local });
const request = (id: string, minute: number, targets: RequestJson['targets'], body: string): RequestJson =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fields the activity reads
    ({ id, session: 's', author: 'dev:a', targets, body, sentAt: at(minute), mentions: [], state: 'Sent' }) as unknown as RequestJson;
const run = (id: string, minute: number, requests: RequestJson[], state: object = { state: 'Queued' }): RunJson =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fields the activity reads
    ({
        id,
        session: 's',
        input: { requests: requests.map((r) => ({ request: r.id, author: r.author, targets: r.targets, body: r.body })) },
        queuedBy: 'dev:a',
        queuedAt: at(minute),
        ...state,
    }) as unknown as RunJson;
const change = (local: string, kind: ElementChange['change']): ElementChange => ({
    language: 'Dtes',
    storming: 'S',
    local,
    kind: 'event',
    name: local,
    change: kind,
});

describe('what the session did about a storming element', () => {
    const asked = request('q1', 1, [element('PinForgotten')], 'Is #PinForgotten[1] a real case?');
    const other = request('q2', 2, [element('PinEntered')], 'Rename #PinEntered[1]');
    const occurrence = request(
        'q3',
        3,
        [snapshot({ kind: 'DtesOccurrence', storming: 'S', timeline: 'Main', eventName: 'PinForgotten', occurrence: '2' })],
        'Here\n  too',
    );
    const addIt = request('q4', 4, [snapshot({ kind: 'Workspace' })], 'Add the case of a forgotten PIN');

    test('a target names the element itself or an occurrence of it', () => {
        expect(targetsElement({ kind: 'DtesElement', storming: 'S', local: 'PinForgotten' }, el)).toBe(true);
        expect(targetsElement({ kind: 'DtesElement', storming: 'T', local: 'PinForgotten' }, el)).toBe(false);
        expect(targetsElement({ kind: 'DtesOccurrence', storming: 'S', timeline: 'Main', eventName: 'PinForgotten', occurrence: '2' }, el)).toBe(true);
        expect(targetsElement({ kind: 'DtElement', element: 'PinForgotten' }, el)).toBe(false);
    });

    test('the talk: the messages that target it, and the latest on one line with its mentions named', () => {
        const activity = elementActivity({ requests: [asked, other, occurrence], runs: [] }, new Map(), el);
        expect(activity.talk).toEqual({ count: 2, latest: { request: 'q3', text: 'Here too' } });
        expect(elementActivity({ requests: [asked], runs: [] }, new Map(), el).talk?.latest.text).toBe('Is #PinForgotten a real case?');
        expect(elementActivity({ requests: [other], runs: [] }, new Map(), el)).toEqual({});
    });

    test('the runs: those whose messages target it or whose changes touched it; the change: the run that added it', () => {
        const runs = [
            run('run1', 5, [addIt], { state: 'Completed', baseRevision: 'r0', resultRevision: 'r1', changed: true }),
            run('run2', 6, [asked], { state: 'Completed', baseRevision: 'r1', resultRevision: 'r2', changed: true }),
            run('run3', 7, [other]),
        ];
        const changes = new Map([
            ['run1', [change('PinForgotten', 'added')]],
            ['run2', [change('PinForgotten', 'changed')]],
        ]);
        const activity = elementActivity({ requests: [asked, other, addIt], runs }, changes, el);
        expect(activity.runs).toEqual({ count: 2, latest: 'run2' });
        expect(activity.change).toEqual({ change: 'added', run: 'run1', request: 'Add the case of a forgotten PIN' });
        // not added in this session: the latest run that changed it
        const later = elementActivity({ requests: [asked], runs }, new Map([['run2', [change('PinForgotten', 'changed')]]]), el);
        expect(later.change).toEqual({ change: 'changed', run: 'run2', request: 'Is #PinForgotten a real case?' });
        // the changes not loaded yet: the runs by their messages only, and no change
        expect(elementActivity({ requests: [asked], runs }, new Map(), el)).toMatchObject({ runs: { count: 1, latest: 'run2' } });
        expect(elementActivity({ requests: [asked], runs }, new Map(), el).change).toBeUndefined();
    });
});

describe('the beginning of a message about an element', () => {
    const target: TargetDraft = { target: { kind: 'DtesElement', storming: 'S', local: 'PinForgotten' }, label: '暗証番号を忘れた' };
    const ja = MESSAGES.ja.esDetail.begin;

    test('puts the beginning in the composer with the element as a `#` target', () => {
        expect(beginMessage(EMPTY_COMPOSER, target, '暗証番号を忘れた', ja.ask)).toEqual({
            text: '#暗証番号を忘れた[1] について、',
            chips: [{ target, mentioned: true }],
            people: [],
        });
        expect(beginMessage(EMPTY_COMPOSER, target, '暗証番号を忘れた', ja.question).text).toBe('#暗証番号を忘れた[1] に問いを足して: ');
        expect(beginMessage(EMPTY_COMPOSER, target, '暗証番号を忘れた', ja.resolve).text).toBe('#暗証番号を忘れた[1] の結論: ');
        expect(beginMessage(EMPTY_COMPOSER, target, '暗証番号を忘れた', (t) => ja.fix(t, '戻り先が本流にない')).text).toBe(
            '#暗証番号を忘れた[1] の問題を直して（戻り先が本流にない）',
        );
        expect(beginMessage(EMPTY_COMPOSER, target, 'PinForgotten', MESSAGES.en.esDetail.begin.ask).text).toBe('About #PinForgotten[1], ');
    });

    test('keeps what is written: an element already a target keeps its number, the beginning goes on a line of its own', () => {
        const other: TargetDraft = { target: { kind: 'DtesElement', storming: 'S', local: 'PinEntered' } };
        const written = { text: 'First #PinEntered[1] ', chips: [{ target: other, mentioned: true }], people: [] };
        expect(beginMessage(written, target, '暗証番号を忘れた', ja.ask)).toEqual({
            text: 'First #PinEntered[1]\n#暗証番号を忘れた[2] について、',
            chips: [
                { target: other, mentioned: true },
                { target, mentioned: true },
            ],
            people: [],
        });
        const already = { text: '', chips: [{ target, mentioned: false }], people: [] };
        expect(beginMessage(already, target, '暗証番号を忘れた', ja.ask)).toEqual({
            text: '#暗証番号を忘れた[1] について、',
            chips: [{ target, mentioned: true }],
            people: [],
        });
    });
});
