// The canvas library stays behind the canvas port (view/diagram.ts, docs/plans/react-flow.md): only its adapter and
// the shapes it draws import it, so that replacing it touches those files alone.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const WEB = import.meta.dir;

/** The files that may import tldraw: the adapter, its shapes, and the entry (tldraw's stylesheet, before the page's). */
const ALLOWED = ['main.tsx', 'shapes.tsx', 'view/tldraw-canvas.tsx'];

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === 'node_modules') return [];
        const file = join(dir, entry.name);
        if (entry.isDirectory()) return sources(file);
        return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [relative(WEB, file)] : [];
    });
}

describe('the canvas library', () => {
    test('is imported only by the canvas adapter and its shapes', () => {
        const importing = sources(WEB).filter((f) => /(?:from|import)\s*['"](?:tldraw|@tldraw\/)/.test(readFileSync(join(WEB, f), 'utf8')));
        expect(importing.filter((f) => !ALLOWED.includes(f))).toEqual([]);
        // the check sees the imports it is about
        expect(importing).toContain('view/tldraw-canvas.tsx');
    });
});
