import type { AgentJourneysBody } from '@domaintrail/collaboration/protocol';

/** Only a change of the current journey or a BP→DL goal starts a new warm-agent context. */
export interface JourneyContext {
    current?: string;
    goals: Readonly<Record<string, string>>;
}

export function journeyContext(journeys: AgentJourneysBody | undefined): JourneyContext {
    const current = journeys?.current;
    const goals = Object.fromEntries(journeys?.journeys.filter((j) => j.kind === 'es').map((j) => [j.key, j.goal]) ?? []);
    return { current, goals };
}

export function changesWorkingContext(before: JourneyContext | undefined, after: JourneyContext): boolean {
    return (
        !!before &&
        (before.current !== after.current || Object.entries(after.goals).some(([key, goal]) => before.goals[key] === 'BigPicture' && goal === 'DesignLevel'))
    );
}
