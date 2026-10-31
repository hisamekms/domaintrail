import { describe, expect, test } from 'bun:test';
import { healthOf, workspaceName } from '@domaintrail/web/app/health';
import { COLLAPSE_LEFT_BELOW, DOCK_BELOW_BELOW, effectiveLayout, keptOverrides, NO_OVERRIDES } from '@domaintrail/web/app/responsive';

describe('the layout on a narrow window', () => {
    const saved = { left: true, dock: 'right' as const, overrides: NO_OVERRIDES };

    test("the reader's choices while the conversation is closed, whatever the width", () => {
        expect(effectiveLayout({ ...saved, width: 800, conversationOpen: false })).toMatchObject({ left: true, dock: 'right' });
    });

    test('with the conversation open: the left pane collapsed below 1280px, the inspector below the canvas below 1024px', () => {
        expect(effectiveLayout({ ...saved, width: COLLAPSE_LEFT_BELOW, conversationOpen: true })).toMatchObject({ left: true, dock: 'right' });
        expect(effectiveLayout({ ...saved, width: COLLAPSE_LEFT_BELOW - 1, conversationOpen: true })).toMatchObject({
            left: false,
            dock: 'right',
            forced: { left: true, dock: false },
        });
        expect(effectiveLayout({ ...saved, width: DOCK_BELOW_BELOW - 1, conversationOpen: true })).toMatchObject({
            left: false,
            dock: 'bottom',
            forced: { left: true, dock: true },
        });
    });

    test('what the reader chooses meanwhile is shown, and forgotten once the window is wide again; the saved choices are kept', () => {
        const overrides = { left: true, dock: 'right' as const };
        expect(effectiveLayout({ ...saved, overrides, width: 900, conversationOpen: true })).toMatchObject({ left: true, dock: 'right' });
        expect(keptOverrides(overrides, { left: true, dock: false })).toEqual({ left: true });
        expect(keptOverrides(overrides, { left: false, dock: false })).toEqual({});
        expect(keptOverrides(overrides, { left: true, dock: true })).toBe(overrides);
        // a saved choice to keep the left pane collapsed stays so when the window is wide
        expect(effectiveLayout({ ...saved, left: false, width: 1600, conversationOpen: true })).toMatchObject({ left: false });
    });
});

describe('the head and the foot of the left pane', () => {
    test("the workspace's name is the last folder of its root", () => {
        expect(workspaceName('/Users/me/shop')).toBe('shop');
        expect(workspaceName('/Users/me/shop/')).toBe('shop');
        expect(workspaceName('C:\\work\\billing')).toBe('billing');
    });

    test('the health: an error when the server is gone or the model does not validate, a warning while it is uncertain', () => {
        const ok = { status: 'ok' as const, connection: 'open' as const, stale: false, warnings: 0 };
        expect(healthOf(ok)).toBe('ok');
        expect(healthOf({ ...ok, connection: 'closed' })).toBe('error');
        expect(healthOf({ ...ok, status: 'invalid' })).toBe('error');
        expect(healthOf({ ...ok, status: 'syntax-error', stale: true })).toBe('error');
        expect(healthOf({ ...ok, connection: 'connecting' })).toBe('warning');
        expect(healthOf({ ...ok, status: undefined })).toBe('warning');
        expect(healthOf({ ...ok, status: 'empty' })).toBe('warning');
        expect(healthOf({ ...ok, warnings: 2 })).toBe('warning');
    });
});

describe("the inspector's width until it is dragged", () => {
    test('about a third of the room the other panes leave, within 300–420px', async () => {
        const { autoInspectorWidth } = await import('@domaintrail/web/app/responsive');
        // 1600px with the left pane (304) and the chat (380) open
        expect(autoInspectorWidth(1600 - 304 - 380)).toBe(330);
        expect(autoInspectorWidth(2400)).toBe(420);
        expect(autoInspectorWidth(500)).toBe(300);
    });
});
