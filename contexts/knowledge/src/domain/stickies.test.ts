// The workspace's stickies an extraction is given (ADR 0031, section 3): the stormings the session looks at (open,
// then the current journey's), else every storming (those the talk points at first), at most the cap; and the stickies
// the talk writes out by label.
import { describe, expect, test } from 'bun:test';
import { chooseStickies, mentionedStickies, type StormingStickies } from './stickies.js';

const storming = (id: string, ...locals: string[]): StormingStickies => ({
    id,
    stickies: locals.map((local) => ({ local, label: `${local} label`, kind: 'event' })),
});
const stormings = [storming('Ordering', 'Placed', 'Paid'), storming('Returns', 'Requested'), storming('Billing', 'Invoiced', 'Sent', 'Dunned')];
const refs = (c: ReturnType<typeof chooseStickies>): string[] => c.stickies.map((s) => s.ref);

describe("the workspace's stickies of an extraction", () => {
    test('the storming open on the page, then the journey’s, in that order; each sticky with its label and kind', () => {
        const chosen = chooseStickies({ stormings, open: ['Billing'], journey: ['Returns', 'Billing'] });
        expect(refs(chosen)).toEqual(['Billing.Invoiced', 'Billing.Sent', 'Billing.Dunned', 'Returns.Requested']);
        expect(chosen.stickies[0]).toEqual({ ref: 'Billing.Invoiced', label: 'Invoiced label', kind: 'event' });
        expect([chosen.basis, chosen.stormings, chosen.left]).toEqual(['focus', ['Billing', 'Returns'], 0]);
    });

    test('the journey alone when no page has a storming open; a storming the workspace does not have is passed over', () => {
        const chosen = chooseStickies({ stormings, open: ['Gone'], journey: ['Returns'] });
        expect([refs(chosen), chosen.basis]).toEqual([['Returns.Requested'], 'focus']);
    });

    test('neither known: every storming, those the talk points at first, then the workspace’s order', () => {
        const chosen = chooseStickies({ stormings, open: [], journey: [] }, ['Billing.Sent']);
        expect(chosen.basis).toBe('all');
        expect(chosen.stormings).toEqual(['Billing', 'Ordering', 'Returns']);
        expect(refs(chosen)).toHaveLength(6);
    });

    test('the cap: stormings taken whole in order, the last one cut, the rest counted as left out', () => {
        const chosen = chooseStickies({ stormings, open: [], journey: [] }, [], 4);
        expect(refs(chosen)).toEqual(['Ordering.Placed', 'Ordering.Paid', 'Returns.Requested', 'Billing.Invoiced']);
        expect([chosen.stormings, chosen.left]).toEqual([['Ordering', 'Returns', 'Billing'], 2]);
        expect(chooseStickies({ stormings, open: ['Billing'], journey: [] }, [], 2).left).toBe(1);
    });

    test('the same focus gives the same list (the prompt cache keeps it)', () => {
        const focus = { stormings, open: ['Ordering'], journey: ['Returns'] };
        expect(chooseStickies(focus, ['Billing.Sent'])).toEqual(chooseStickies(focus, []));
    });

    test('the stickies the talk writes out: by label (case aside), or by a local ID long enough; short ones are not', () => {
        const given = [
            { ref: 'Ordering.Estimate', label: '見積もり', kind: 'event' },
            { ref: 'Ordering.Rush', label: '急ぎ', kind: 'policy' },
            { ref: 'Ordering.Q', label: '可', kind: 'hotspot' },
            { ref: 'Billing.InvoiceSent', kind: 'event' },
            { ref: 'Billing.Pay', label: 'Payment Made', kind: 'event' },
        ];
        expect(mentionedStickies(given, ['急ぎの見積もりは当日中', 'invoicesent のあと payment made になる'])).toEqual([
            'Ordering.Estimate',
            'Ordering.Rush',
            'Billing.InvoiceSent',
            'Billing.Pay',
        ]);
        expect(mentionedStickies(given, [])).toEqual([]);
    });
});
