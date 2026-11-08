import { expect, test } from 'bun:test';
import { changesWorkingContext, journeyContext } from './journey-boundary.js';
import type { AgentJourneysBody } from '@domaintrail/collaboration/protocol';

test('warm context resets on current journey change or BP→DL, not on view or unrelated goal changes', () => {
    const bp = { current: 'es:Order', goals: { 'es:Order': 'BigPicture' } };
    expect(changesWorkingContext(undefined, bp)).toBe(false);
    expect(changesWorkingContext(bp, bp)).toBe(false);
    expect(changesWorkingContext(bp, { current: 'es:Order', goals: { 'es:Order': 'DesignLevel' } })).toBe(true);
    expect(changesWorkingContext(bp, { current: 'es:Other', goals: { 'es:Order': 'BigPicture' } })).toBe(true);
    expect(changesWorkingContext({ current: 'model', goals: { 'es:Order': 'BigPicture' } }, { current: 'model', goals: { 'es:Order': 'DesignLevel' } })).toBe(
        true,
    );
    expect(changesWorkingContext({ current: 'model', goals: {} }, { current: 'model', goals: {} })).toBe(false);
    const journeys: AgentJourneysBody = {
        current: 'es:Order',
        journeys: [{ key: 'es:Order', kind: 'es', name: 'Order', state: 'active', goal: 'DesignLevel', purpose: 'Explore', participants: [] }],
    };
    expect(journeyContext(journeys)).toEqual({ current: 'es:Order', goals: { 'es:Order': 'DesignLevel' } });
});
