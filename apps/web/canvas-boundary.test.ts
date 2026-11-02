// The canvas library stays behind the canvas port (view/diagram.ts, docs/plans/react-flow.md): only its adapter
// imports it, so that replacing it touches that file alone; tldraw, which it replaced, is gone for good (ADR 0029).
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const WEB = import.meta.dir;

/** The files that may import React Flow: the adapter, and the entry (React Flow's stylesheet, before the page's). */
const ALLOWED = ['main.tsx', 'view/flow-canvas.tsx'];

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === 'node_modules') return [];
        const file = join(dir, entry.name);
        if (entry.isDirectory()) return sources(file);
        return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [relative(WEB, file)] : [];
    });
}

const importing = (pattern: RegExp): string[] => sources(WEB).filter((f) => pattern.test(readFileSync(join(WEB, f), 'utf8')));

describe('the canvas library', () => {
    test('is imported only by the canvas adapter', () => {
        const files = importing(/(?:from|import)\s*['"]@xyflow\//);
        expect(files.filter((f) => !ALLOWED.includes(f))).toEqual([]);
        // the check sees the imports it is about
        expect(files).toContain('view/flow-canvas.tsx');
    });

    test('is no longer tldraw', () => {
        expect(importing(/(?:from|import)\s*['"](?:tldraw|@tldraw\/)/)).toEqual([]);
        expect(readFileSync(join(WEB, 'package.json'), 'utf8')).not.toContain('tldraw');
    });
});
