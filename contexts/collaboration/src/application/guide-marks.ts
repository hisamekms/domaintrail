// The guide's marks kept in the session for now (the plan's "The journey file": they move to `domaintrail.journey.json`
// in a later phase): the `GuideMarkStore` over the session's marks — done (✓) on a step of a journey, or on a BC row
// by its context's name — read from the marks placed, set and cleared through `setMark` (the facilitator's).
import { Collaboration, err, ok, type Result } from '../generated/index.js';
import type { GuideMarkKey, GuideMarkStore } from '../domain/guide.js';
import { DONE, guideMarksOf, type MarkFacts } from '../domain/marks.js';
import type { Actor } from './actor.js';

/** A mark's key as a mark's target; undefined when a part is not one (a journey too long, a step of no map). */
export function guideMarkTarget(key: GuideMarkKey): Collaboration.MarkTarget | undefined {
    const journey = Collaboration.makeGuideJourneyKey(key.journey);
    const step = Collaboration.makeGuideStepKey(key.step);
    const context = key.context === undefined ? undefined : Collaboration.makeContextName(key.context);
    if (!journey.ok || !step.ok || (context && !context.ok)) return undefined;
    return { kind: 'GuideStep', journey: journey.value, step: step.value, ...(context?.ok && { context: context.value }) };
}

/** A key that names no mark target. */
export interface NotAGuideMark {
    readonly type: 'NotAGuideMark';
}

/**
 * The session's guide marks: the ones placed (`placed`, the session's marks), set and cleared by `setMark` as `actor`
 * (refused for anyone but the facilitator, by the mark's command).
 */
export function sessionGuideMarks<E>(input: {
    readonly placed: readonly MarkFacts[];
    readonly actor: Actor;
    readonly setMark: (input: {
        readonly actor: Actor;
        readonly target: Collaboration.MarkTarget;
        readonly sign: Collaboration.MarkSign;
        readonly placed: boolean;
    }) => Promise<Result<unknown, E>>;
}): GuideMarkStore<E | NotAGuideMark> {
    const write = async (key: GuideMarkKey, placed: boolean): Promise<Result<void, E | NotAGuideMark>> => {
        const target = guideMarkTarget(key);
        if (!target) return err({ type: 'NotAGuideMark' });
        const done = await input.setMark({ actor: input.actor, target, sign: DONE, placed });
        return done.ok ? ok(undefined) : done;
    };
    return {
        read: () => guideMarksOf(input.placed),
        set: (key) => write(key, true),
        clear: (key) => write(key, false),
    };
}
