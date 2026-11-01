// How the session routes answer the use cases' errors (over HTTP: test/session-authorization.test.ts and the baseline
// test/session-errors-contract.test.ts).
import { describe, expect, test } from 'bun:test';
import { errorAnswer } from './routes.js';

const FACILITATOR_ONLY = { error: { type: 'FacilitatorOnly', message: 'Only the facilitator may do this.' } };

describe("the domain's refusals over HTTP", () => {
    test('read as the routes always answered them: 403, and FacilitatorOnly with the routes’ message', () => {
        expect(errorAnswer({ type: 'FacilitatorOnly' })).toEqual({ status: 403, body: FACILITATOR_ONLY });
        expect(errorAnswer({ type: 'FacilitatorOnly', message: 'Only the facilitator applies messages.' })).toEqual({
            status: 403,
            body: { error: { type: 'FacilitatorOnly', message: 'Only the facilitator applies messages.' } },
        });
        expect(errorAnswer({ type: 'NotYourRequest' })).toEqual({ status: 403, body: { error: { type: 'NotYourRequest' } } });
        expect(errorAnswer({ type: 'FacilitatorDoesNotVote' })).toEqual({ status: 403, body: { error: { type: 'FacilitatorDoesNotVote' } } });
        const notAParticipant = { type: 'NotAParticipant', participant: 'p' };
        expect(errorAnswer(notAParticipant)).toEqual({
            status: 403,
            body: { error: { type: 'NotAParticipant', participant: 'p' } },
        });
        const notAllowed = { type: 'NotAllowed', command: 'close', state: 'Closed' };
        expect(errorAnswer(notAllowed)).toEqual({
            status: 409,
            body: { error: { type: 'NotAllowed', command: 'close', state: 'Closed' } },
        });
    });
});
