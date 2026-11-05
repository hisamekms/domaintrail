import { ChevronDown } from 'lucide-react';
import { useT } from './i18n';

/**
 * The tree's fold over the detail (app/panes.ts): folded by the reader only, to its head line, which then names what is
 * selected (`label`, e.g. 「イベントストーミング › 配達を完了した」) in place of the filter.
 */
export interface TreeFold {
    readonly folded: boolean;
    readonly label: string;
    readonly onToggle: () => void;
}

/** The selection's name in the folded head line, in place of the filter (none while the tree is open). */
export function FoldedLabel({ fold }: { fold: TreeFold | undefined }) {
    if (!fold?.folded) return null;
    return (
        <span className="tree-fold-label" data-tooltip={fold.label}>
            {fold.label}
        </span>
    );
}

/** ▾ in the tree's head line: folds the tree (the detail takes the column) and unfolds it; it turns while folded. */
export function FoldButton({ fold }: { fold: TreeFold | undefined }) {
    const t = useT();
    if (!fold) return null;
    const label = fold.folded ? t.unfoldTree : t.foldTree;
    return (
        <button
            className={`icon-button tree-fold${fold.folded ? ' folded' : ''}`}
            aria-expanded={!fold.folded}
            onClick={fold.onToggle}
            data-tooltip={label}
            aria-label={label}
        >
            <ChevronDown size={16} aria-hidden />
        </button>
    );
}
