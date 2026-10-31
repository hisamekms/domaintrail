import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { LaidOutGraph } from '../domain/graph/ir.js';
import type { LayoutCache, LayoutStore } from '../application/ports.js';

export const LAYOUT_FILE = path.join('.domaintrail', 'layout.json');

interface LayoutFile {
    version: 1;
    engine: string;
    engineVersion: number;
    graphs: Record<string, Pick<LaidOutGraph, 'signature' | 'nodeLayout' | 'edgeLayout'>>;
}

/** The `LayoutStore` of a workspace: `LAYOUT_FILE` below `root`, never written through a symlink. */
export function createFileLayoutStore(root: string): LayoutStore {
    let warnedUnsafeLayoutDir = false;
    return {
        async load(engine) {
            const layouts: LayoutCache = new Map();
            try {
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- our own file; its version and engine are checked below, a broken one is ignored
                const file = JSON.parse(await readFile(path.join(root, LAYOUT_FILE), 'utf8')) as LayoutFile;
                if (file.version !== 1 || file.engine !== engine.name || file.engineVersion !== engine.version) return layouts;
                for (const [id, g] of Object.entries(file.graphs)) {
                    layouts.set(id, { id, nodes: [], edges: [], ...g });
                }
            } catch {
                // No layout yet, or unreadable: lay out from scratch.
            }
            return layouts;
        },

        async save(engine, layouts) {
            const file: LayoutFile = { version: 1, engine: engine.name, engineVersion: engine.version, graphs: {} };
            for (const [id, g] of [...layouts].sort(([a], [b]) => a.localeCompare(b))) {
                file.graphs[id] = { signature: g.signature, nodeLayout: g.nodeLayout, edgeLayout: g.edgeLayout };
            }
            const target = path.join(root, LAYOUT_FILE);
            const dir = path.dirname(target);
            // A checked-out repository may contain `.domaintrail` (or the layout file) as a symlink; never write through it.
            const existing = await lstat(dir).catch(() => undefined);
            if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
                if (!warnedUnsafeLayoutDir) console.warn(`Not saving layouts: ${dir} is not a plain directory.`);
                warnedUnsafeLayoutDir = true;
                return;
            }
            await mkdir(dir, { recursive: true });
            // write a new file and rename it into place: rename replaces a symlinked layout.json instead of following it
            const temp = path.join(dir, `.layout-${process.pid}-${Date.now()}.tmp`);
            await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { flag: 'wx' });
            await rename(temp, target);
        },
    };
}
