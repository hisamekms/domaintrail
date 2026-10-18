/** A directory of the explorer's file tree; `name` may span several levels (`src/domain`) when they hold nothing else. */
export interface DirNode {
    kind: 'dir';
    name: string;
    /** Full path of the (deepest) directory, without a trailing slash. */
    path: string;
    children: FileTreeNode[];
}

export interface FileNode {
    kind: 'file';
    name: string;
    path: string;
}

export type FileTreeNode = DirNode | FileNode;

/** Builds a tree from relative `/`-separated paths: directories first, each level sorted by name. */
export function buildFileTree(files: readonly string[]): FileTreeNode[] {
    const root: DirNode = { kind: 'dir', name: '', path: '', children: [] };
    for (const file of files) {
        const parts = file.split('/');
        let dir = root;
        for (const part of parts.slice(0, -1)) {
            const path = dir.path ? `${dir.path}/${part}` : part;
            let next = dir.children.find((c): c is DirNode => c.kind === 'dir' && c.name === part);
            if (!next) dir.children.push((next = { kind: 'dir', name: part, path, children: [] }));
            dir = next;
        }
        dir.children.push({ kind: 'file', name: parts[parts.length - 1], path: file });
    }
    return root.children.map(compact).sort(byKindAndName);
}

/** Merges a directory whose only child is a directory into it (like VS Code's compact folders). */
function compact(node: FileTreeNode): FileTreeNode {
    if (node.kind === 'file') return node;
    let dir = node;
    while (dir.children.length === 1 && dir.children[0].kind === 'dir') {
        const only: DirNode = dir.children[0];
        dir = { ...only, name: `${dir.name}/${only.name}` };
    }
    return { ...dir, children: dir.children.map(compact).sort(byKindAndName) };
}

const byKindAndName = (a: FileTreeNode, b: FileTreeNode): number => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name);

/** The files below a node (the node itself for a file). */
export function filesIn(node: FileTreeNode): string[] {
    return node.kind === 'file' ? [node.path] : node.children.flatMap(filesIn);
}
