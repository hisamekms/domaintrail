// A clamped text in the chat (bubble.tsx): the last line of the AI's Markdown fades out only when it is cut (taller than
// the clamp), not for every message there when the page loaded.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clampedClass } from './bubble';

const styles = readFileSync(join(import.meta.dir, '..', 'styles.css'), 'utf8');

describe("a clamped AI message's fade", () => {
    test('only when it is cut (taller than the clamp): a short one in the history shows whole, unfaded', () => {
        expect(clampedClass({ blocks: true, open: false, cut: false })).toBe('chat-text chat-markdown clamped');
        expect(clampedClass({ blocks: true, open: false, cut: true })).toBe('chat-text chat-markdown clamped cut');
        expect(clampedClass({ blocks: true, open: true, cut: true })).toBe('chat-text chat-markdown');
        expect(clampedClass({ blocks: false, className: 'reply-answer', open: false, cut: false })).toBe('chat-text reply-answer clamped');
        // the mask is the cut one's only
        expect(styles).toMatch(/\.chat-text\.chat-markdown\.clamped\.cut \{\s+mask-image:/);
        expect(styles).not.toMatch(/\.chat-text\.chat-markdown\.clamped \{[^}]*mask-image/);
    });
});
