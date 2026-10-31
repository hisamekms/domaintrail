import { describe, expect, test } from 'bun:test';
import { buildFileTree, filesIn, type FileTreeNode } from '@domaintrail/web/file-tree';

/** `name/` for a directory with its children indented below, `name` for a file. */
const outline = (nodes: FileTreeNode[], indent = ''): string[] =>
    nodes.flatMap((n) => (n.kind === 'dir' ? [`${indent}${n.name}/`, ...outline(n.children, `${indent}  `)] : [`${indent}${n.name}`]));

describe('file tree', () => {
    test('nests files in directories, directories first, each level sorted', () => {
        const tree = buildFileTree(['order.dt', 'billing/invoice.dt', 'billing/a/x.dt', 'billing/b/y.dt', 'common.dt']);
        expect(outline(tree)).toEqual(['billing/', '  a/', '    x.dt', '  b/', '    y.dt', '  invoice.dt', 'common.dt', 'order.dt']);
    });

    test('merges directories that only hold one directory', () => {
        const tree = buildFileTree(['src/domain/order/order.dt', 'src/domain/order/line.dt', 'src/domain/billing.dt', 'common.dt']);
        expect(outline(tree)).toEqual(['src/domain/', '  order/', '    line.dt', '    order.dt', '  billing.dt', 'common.dt']);
        const dir = tree[0];
        expect(dir.kind === 'dir' && dir.path).toBe('src/domain');
    });

    test('a directory with a single file is not merged', () => {
        expect(outline(buildFileTree(['a/b/c.dt']))).toEqual(['a/b/', '  c.dt']);
    });

    test('lists the files below a node', () => {
        const tree = buildFileTree(['x/y/1.dt', 'x/2.dt']);
        expect(filesIn(tree[0]).sort()).toEqual(['x/2.dt', 'x/y/1.dt']);
    });
});
