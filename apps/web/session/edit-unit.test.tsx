// A person's edit in AI の作業 (ADR 0033, session/edit-unit.tsx): 「◯◯が直しました」 with old → new, 打ち消す for the
// facilitator, the note of a re-application, and a conflict with a run's wording offered as a choice; and the edit
// window's impact of a rename (stickies/forms.tsx).
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { analyzeStormings } from '@domaintrail/storming';
import { MESSAGES } from '../i18n';
import { actKinds } from '../test-helpers';
import { EditForm } from '../stickies/forms';
import { stickyOf } from '../stickies/registry';
import { ChatProvider, type ChatContextValue } from './chat-context';
import { EditUnit } from './edit-unit';
import { changeUnits } from './history';

const at = '2026-11-06T10:00:00.000Z';
const wording = {
    kind: 'Wording',
    storming: 'Returns',
    path: 'stormings/returns.dtes',
    nameBefore: 'Received',
    nameAfter: 'Arrived',
    labelBefore: '返品が届いた',
    labelAfter: '荷物が戻った',
    references: 2,
} as const;

const edited = (extra: object = {}) => ({
    id: 'e1',
    session: 's',
    state: 'Edited',
    input: { requests: [{ request: 'm1', author: 'bob', targets: [], body: '「返品が届いた」を「荷物が戻った」に直す', edit: wording }] },
    queuedBy: 'bob',
    queuedAt: at,
    baseRevision: 'r1',
    resultRevision: 'r2',
    finishedAt: at,
    ...extra,
});

function render(run: object, control: boolean, runs: object[] = [run]): string {
    const state = { runs, revisions: [] };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a test's partial state
    const units = changeUnits(state as never);
    const chat = {
        tx: MESSAGES.ja.session,
        session: { state },
        control,
        nameOf: (id: string) => (id === 'bob' ? 'Bob' : id),
    } as unknown as ChatContextValue;
    return renderToStaticMarkup(
        <ChatProvider value={chat}>
            <ol>
                <EditUnit unit={units.find((u) => u.outcome === 'edited') ?? units[0]} />
            </ol>
        </ChatProvider>,
    );
}

describe("a person's edit in AI の作業", () => {
    test('who and when, old struck through → new, the references a rename rewrote, and 打ち消す for the facilitator', () => {
        const html = render(edited(), true);
        expect(html).toContain('Bobが直しました');
        expect(html).toContain('<del>返品が届いた</del> → <span>荷物が戻った</span>');
        expect(html).toContain('<del class="mono">Received</del> → <span class="mono">Arrived</span>');
        expect(html).toContain('参照 2 件も書き換え');
        expect(actKinds(html)).toEqual(['danger']);
        // a participant reads it, without 打ち消す
        expect(actKinds(render(edited(), false))).toEqual([]);
    });

    test('a re-application says so; a conflict shows both wordings and the choice, one decide', () => {
        expect(render(edited({ reapplies: 'run1' }), false)).toContain('AI の作業が落としたので、その作業のあとに当て直しました');
        const html = render(edited({ conflict: { run: 'run1', runLabel: '返品を受け取った', settled: false } }), false);
        expect(html).toContain('AI の作業が同じ付箋を別の文言にしました');
        expect(html).toContain('荷物が戻った');
        expect(html).toContain('返品を受け取った');
        expect(actKinds(html)).toEqual(['decide-sub', 'decide']);
        expect(render(edited({ conflict: { run: 'run1', runLabel: '返品を受け取った', settled: true } }), false)).toContain('決めました');
    });

    test('reverted: struck through, without 打ち消す', () => {
        const revert = {
            id: 'v1',
            session: 's',
            state: 'Reverted',
            input: { requests: [{ request: 'm2', author: 'facilitator', targets: [], body: 'x', reverts: 'e1' }] },
            queuedBy: 'facilitator',
            queuedAt: at,
            baseRevision: 'r2',
            resultRevision: 'r3',
            changed: true,
            finishedAt: '2026-11-06T10:01:00.000Z',
        };
        const html = render(edited(), true, [edited(), revert]).replace(/\n/g, '');
        expect(html).toContain('edit-unit outcome-edited reverted');
        expect(html).toContain('打ち消し済み');
        expect(actKinds(html)).toEqual([]);
    });
});

describe('the edit window', () => {
    test('it opens with the label and the name as they are, and nothing to save yet', async () => {
        const file = path.join(import.meta.dir, '..', '..', '..', 'examples', 'shop', 'stormings', 'order-to-cash.dtes');
        const parsed = await analyzeStormings([{ path: 'a.dtes', text: await readFile(file, 'utf8') }], undefined);
        const storming = parsed.stormings[0];
        const sticky = stickyOf([{ id: storming.id, storming }], 'es/OrderToCash/OrderConfirmed');
        if (!sticky) throw new Error('no sticky');
        const html = renderToStaticMarkup(
            <EditForm
                sticky={sticky}
                storming={storming}
                anchor={{ x: 0, y: 0, w: 100, h: 60, width: 800, height: 600 }}
                onSave={async () => undefined}
                onClose={() => {}}
            />,
        );
        expect(html).toContain('role="dialog"');
        expect(html).toContain('value="注文が確定した"');
        expect(html).toContain('value="OrderConfirmed"');
        // nothing changed yet: the decision is disabled
        expect(html).toMatch(/<button disabled=""[^>]*class="act act-decide">保存/);
    });
});
