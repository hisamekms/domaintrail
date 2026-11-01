// Helpers of Collaboration's unit tests: models and stormings analyzed from inline sources, through the entry of
// Modeling and Storming (their analyses, as the app's validator runs them).
import { analyzeDomain, analyzeStormings, isStormingFile, type DomainModel, type Storming } from '@domaintrail/modeling';

/** What the validator gives for inline sources (keys are file names): the model and the stormings. */
export async function check(files: Record<string, string>): Promise<{ model: DomainModel | undefined; stormings: Storming[]; stormingsComplete: boolean }> {
    const sources = Object.entries(files).map(([p, text]) => ({ path: p, text }));
    const domain = await analyzeDomain(sources.filter((s) => !isStormingFile(s.path)));
    const stormings = await analyzeStormings(
        sources.filter((s) => isStormingFile(s.path)),
        domain.model,
    );
    return { model: domain.model, stormings: stormings.stormings, stormingsComplete: stormings.syntaxOk };
}
