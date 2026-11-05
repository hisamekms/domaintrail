// Whether a session extracts its knowledge (ADR 0031, section 3: off unless enabled): the config gives the default
// (`knowledge.extraction.enabled`), and the session's facilitator may switch it — the server's route checks the role;
// this keeps the choice, in the session database, so that a server started again keeps it.
//
// Switched off, nothing more is extracted (the scheduler idles; what is held still settles, and what was decided is
// still sent). Switched on again, the extraction picks up from its checkpoint, but not further back than its usual
// window (`SessionExtraction.resume`).

/** The session database's side: the facilitator's last choice per session, none when never switched. */
export interface ExtractionSwitches {
    load(session: string): Promise<boolean | undefined>;
    save(session: string, enabled: boolean, at: Date): Promise<void>;
}

export interface ExtractionSwitch {
    /** Whether the session extracts now. */
    enabled(): boolean;
    /** Switches it (the facilitator's), kept for a restart: whether that changed it. */
    set(enabled: boolean): Promise<boolean>;
}

/** The session's switch: as last switched, else the config's default. */
export async function loadExtractionSwitch(deps: {
    readonly session: string;
    readonly switches: ExtractionSwitches;
    /** `knowledge.extraction.enabled`. */
    readonly byDefault: boolean;
    readonly now: () => Date;
}): Promise<ExtractionSwitch> {
    let on = (await deps.switches.load(deps.session)) ?? deps.byDefault;
    return {
        enabled: () => on,
        async set(enabled) {
            if (enabled === on) return false;
            await deps.switches.save(deps.session, enabled, deps.now());
            on = enabled;
            return true;
        },
    };
}
