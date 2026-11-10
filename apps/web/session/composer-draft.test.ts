import { describe, expect, test } from 'bun:test';
import { COMPOSER_DRAFT, composerScope, createMemoryDrafts, type DraftStorage } from './drafts';
import { EMPTY_COMPOSER } from './mentions';
import { confirmSelection } from './selection';
import { WORKSPACE_TARGET } from './targets';
import { createComposerDraft } from './useSession';

const scope = composerScope({ session: 's1', participant: 'p1' });

describe('composer draft store', () => {
    test('typing changes only the text snapshot, keeps the chip snapshot stable, and saves the draft', async () => {
        const storage = createMemoryDrafts();
        const draft = createComposerDraft(storage, scope);
        const stop = draft.start();
        const chips = draft.chipsSnapshot();
        let notifications = 0;
        let pageUpdates = 0;
        let pageSnapshot = chips;
        const unsubscribe = draft.subscribe(() => notifications++);
        const unsubscribePage = draft.subscribe(() => {
            const next = draft.chipsSnapshot();
            if (next !== pageSnapshot) {
                pageSnapshot = next;
                pageUpdates++;
            }
        });

        draft.setValue({ ...draft.value, text: 'hello' });
        draft.setValue({ ...draft.value, text: 'hello world' });
        expect(draft.value.text).toBe('hello world');
        expect(draft.chipsSnapshot()).toBe(chips);
        expect(notifications).toBe(2);
        expect(pageUpdates).toBe(0);
        await Bun.sleep(350);
        expect((await storage.load(scope)).find((item) => item.id === COMPOSER_DRAFT)?.body).toBe('hello world');

        await draft.clear();
        expect(draft.value).toBe(EMPTY_COMPOSER);
        expect(await storage.load(scope)).toEqual([]);
        unsubscribe();
        unsubscribePage();
        stop();
    });

    test('an external target insertion changes the chip snapshot without losing typed text', () => {
        const draft = createComposerDraft(createMemoryDrafts(), undefined);
        draft.setValue({ ...EMPTY_COMPOSER, text: 'typed' });
        const chips = draft.chipsSnapshot();
        let pageUpdates = 0;
        draft.subscribe(() => {
            if (draft.chipsSnapshot() !== chips) pageUpdates++;
        });
        // The page's action reads `draft.value` when clicked, rather than a value captured before typing.
        const addCurrentSelection = () => draft.setValue(confirmSelection(draft.value, [WORKSPACE_TARGET]).value);
        addCurrentSelection();
        expect(draft.chipsSnapshot()).not.toBe(chips);
        expect(pageUpdates).toBe(1);
        expect(draft.value.text).toBe('typed');
    });

    test('a stored draft loaded later does not overwrite text already typed', async () => {
        let finishLoad: ((drafts: Awaited<ReturnType<DraftStorage['load']>>) => void) | undefined;
        const storage: DraftStorage = {
            load: () => new Promise((resolve) => (finishLoad = resolve)),
            save: async () => {},
            remove: async () => {},
        };
        const draft = createComposerDraft(storage, scope);
        const stop = draft.start();
        draft.setValue({ ...EMPTY_COMPOSER, text: 'new text' });
        finishLoad?.([{ id: COMPOSER_DRAFT, target: WORKSPACE_TARGET, body: 'old text', createdAt: 0, updatedAt: 0 }]);
        await Promise.resolve();
        expect(draft.value.text).toBe('new text');
        stop();
    });
});
