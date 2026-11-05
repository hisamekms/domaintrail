// `dt check` on the knowledge kept as files (ADR 0031, sections 1 and 5): knowledge is checked only for its references —
// that the stickies an item is `about` exist in the workspace's `.dtes` — and, kept as files that a person may edit,
// for reading at all. Pure: the app reads the files and names the stickies.
import type { Diagnostic } from '@domaintrail/kernel';
import { idOfFileName, readItemFile } from './item-file.js';

/**
 * Knowledge's rule IDs: K001 (error) an item's file does not read, and the store skips it; K002 (warning) an item is
 * about a sticky that no storming of the workspace has.
 */
export type KnowledgeRuleId = 'K001' | 'K002';

/** An item's file: its path as diagnostics name it (relative to the workspace root), and its text. */
export interface KnowledgeFile {
    readonly path: string;
    readonly text: string;
}

/** The stickies of the workspace (`<Storming>.<LocalId>`), and whether every `.dtes` file was read. */
export interface KnowledgeNames {
    readonly stickies: ReadonlySet<string>;
    /** The stormings read. */
    readonly stormings: ReadonlySet<string>;
    /**
     * False when a `.dtes` file did not parse: a sticky of a storming not read may exist, so only the stickies missing
     * from the stormings read are reported.
     */
    readonly complete: boolean;
}

const baseName = (p: string): string => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);

/** The findings on the items' files: K001 for a file that does not read, K002 for each `about` naming no sticky. */
export function knowledgeDiagnostics(files: readonly KnowledgeFile[], names: KnowledgeNames): Diagnostic[] {
    const out: Diagnostic[] = [];
    const at = (line: number): Pick<Diagnostic, 'start' | 'end'> => ({ start: { line, column: 1 }, end: { line, column: 2 } });
    for (const file of files) {
        const name = baseName(file.path);
        if (idOfFileName(name) === undefined) continue;
        const read = readItemFile(file.text, name);
        if (!read.ok) {
            out.push({
                file: file.path,
                ...at(read.error.line),
                severity: 'error',
                code: 'K001' satisfies KnowledgeRuleId,
                message: `The knowledge item does not read: ${read.error.message}`,
                hint: 'The knowledge store skips this file until it is fixed (dt writes these files; see an item it wrote for the format).',
            });
            continue;
        }
        const { item, aboutLines } = read.value;
        item.content.about.forEach((sticky, i) => {
            if (names.stickies.has(sticky)) return;
            const storming = sticky.slice(0, sticky.indexOf('.'));
            if (!names.complete && !names.stormings.has(storming)) return;
            out.push({
                file: file.path,
                ...at(aboutLines[i]),
                severity: 'warning',
                code: 'K002' satisfies KnowledgeRuleId,
                message: names.stormings.has(storming)
                    ? `The knowledge item '${item.id}' is about '${sticky}', which storming '${storming}' does not have.`
                    : `The knowledge item '${item.id}' is about '${sticky}', but there is no storming '${storming}'.`,
                hint: "A sticky renamed or moved: change the item's `about`; one removed: remove it from `about` (or delete the item).",
            });
        });
    }
    return out;
}
