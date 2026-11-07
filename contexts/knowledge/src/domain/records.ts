// What an item leaves behind (ADR 0031, sections 7 and 8): the audit log's record of each change, the redaction log's
// entry when the store's sweep removes a deleted item, the past version kept when a new one is made, and the images
// its text refers to (which the sweep removes with it).
import { Knowledge } from '../generated/index.js';

/** The audit log's record of a change: who, which item and version, what, why and when. */
export function auditOf(event: Knowledge.KnowledgeItemEvent): Knowledge.AuditEntry {
    const at = event.at;
    const record = (operation: Knowledge.AuditOperation, actor: Knowledge.Actor, reason?: Knowledge.Reason): Knowledge.AuditEntry => ({
        item: event.itemId,
        version: event.version,
        operation,
        actor,
        ...(reason && { reason }),
        at,
    });
    const extractor = (extraction: Knowledge.ExtractionRef): Knowledge.Actor => ({ kind: 'Extractor', extraction });
    const person = (user: Knowledge.UserName): Knowledge.Actor => ({ kind: 'Person', user });
    switch (event.type) {
        case 'KnowledgeItemAdded':
            return record('add', extractor(event.by), event.reason);
        case 'KnowledgeSourceAdded':
            return record('addSource', extractor(event.by), event.reason);
        case 'KnowledgeItemRewritten':
            return record('rewrite', extractor(event.by), event.reason);
        case 'KnowledgeItemRevised':
            return record('revise', extractor(event.by), event.reason);
        case 'KnowledgeConflictLinked':
            return record('linkConflict', extractor(event.by), event.reason);
        case 'KnowledgeConflictUnlinked':
            return record('unlinkConflict', person(event.by));
        case 'KnowledgeHandedOverToHotspot':
            return record('handOverToHotspot', person(event.by), hotspotReason(event.hotspot));
        case 'KnowledgeItemCorrected':
            return record('correct', person(event.by));
        case 'KnowledgeItemDeleted':
            return record('delete', person(event.by));
        case 'KnowledgeItemRestored':
            return record('restore', person(event.by));
        case 'KnowledgeItemRetired':
            return record('retire', person(event.by), retirementReason(event));
        case 'KnowledgeItemUnretired':
            return record('unretire', person(event.by), event.proposal && reasonOf(`proposal ${event.proposal}`));
    }
}

/** A reason made of dt's own words (an ID, a reason's name): always one. */
function reasonOf(text: string): Knowledge.Reason {
    const made = Knowledge.makeReason(text);
    if (!made.ok) throw new Error(`Not a reason: ${text}`);
    return made.value;
}

/** The reason a retirement is recorded with: its reason and replacement, and the proposal approved (none: no reason). */
function retirementReason(event: Knowledge.KnowledgeItemRetired): Knowledge.Reason | undefined {
    const parts = [
        event.reason && (event.replacedBy ? `${event.reason} by ${event.replacedBy}` : event.reason),
        event.proposal && `proposal ${event.proposal}`,
    ].filter((p) => p !== undefined);
    return parts.length > 0 ? reasonOf(parts.join(', ')) : undefined;
}

/** Who proposed, as the audit log's actor. */
export const proposerActor = (p: Knowledge.Proposer): Knowledge.Actor =>
    p.kind === 'Extraction' ? { kind: 'Extractor', extraction: p.extraction } : { kind: 'Review', review: p.review };

/**
 * The audit log's record of a proposal made or dismissed, on the item it is about at its version then (an approval is
 * recorded by the item's retirement or unretirement, which names the proposal). The reason holds the action and the
 * proposal's ID only: its explanation and evidence may quote someone, and stay in the proposal, which the sweep
 * removes with the item (`proposalsToForget`).
 */
export function auditOfProposal(
    event: Knowledge.RetirementProposed | Knowledge.RetirementProposalDismissed,
    version: Knowledge.ItemVersion,
): Knowledge.AuditEntry {
    if (event.type === 'RetirementProposed')
        return {
            item: event.item,
            version,
            operation: 'propose',
            actor: proposerActor(event.proposedBy),
            reason: reasonOf(`${event.action} (${event.proposalId})`),
            at: event.proposedAt,
        };
    return {
        item: event.item,
        version,
        operation: 'dismiss',
        actor: { kind: 'Person', user: event.by },
        reason: reasonOf(`${event.action} (${event.proposalId})`),
        at: event.at,
    };
}

/** The reason a hand-over is recorded with: the hotspot the conflict went to. */
export function hotspotReason(hotspot: Knowledge.StickyRef): Knowledge.Reason {
    const made = Knowledge.makeReason(`hotspot ${hotspot}`);
    if (!made.ok) throw new Error(`No reason for ${hotspot}`);
    return made.value;
}

/** The audit record without its reason: what the sweep keeps of a deleted item's records (a reason may quote someone). */
export function withoutReason(entry: Knowledge.AuditEntry): Knowledge.AuditEntry {
    const { reason: _, ...rest } = entry;
    return rest;
}

/** The messages an item came from, once each: what a deletion returns and the redaction log records. */
export function sourceMessages(item: Knowledge.KnowledgeItemCommon): readonly Knowledge.MessageKey[] {
    const seen = new Set<string>();
    const keys: Knowledge.MessageKey[] = [];
    for (const { session, message } of item.sources) {
        const key = JSON.stringify([session, message]);
        if (seen.has(key)) continue;
        seen.add(key);
        keys.push({ session, message });
    }
    return keys;
}

/** The redaction log's entry for a deleted item the sweep removes: IDs only, kept for good. */
export const redactionOf = (item: Knowledge.DeletedKnowledgeItem): Knowledge.Redaction => ({ item: item.id, messages: sourceMessages(item) });

/** A past version: the content of an item before a new version replaced it, and when it was replaced. */
export interface PastVersion {
    readonly version: Knowledge.ItemVersion;
    readonly content: Knowledge.ItemContent;
    readonly replacedAt: Date;
}

/** The past version an item leaves when `next` replaces it. */
export const pastVersionOf = (item: Knowledge.LiveKnowledgeItem, next: Knowledge.KnowledgeItemCommon): PastVersion => ({
    version: item.version,
    content: item.content,
    replacedAt: next.updatedAt,
});

/** The images a text refers to (`image:img_…`), once each in order of appearance. */
export function imagesIn(text: string): readonly Knowledge.ImageId[] {
    const ids = [...new Set([...text.matchAll(/\bimage:(img_[0-9a-z]+)/g)].map((m) => m[1]))];
    return ids.flatMap((id) => {
        const made = Knowledge.makeImageId(id);
        return made.ok ? [made.value] : [];
    });
}
