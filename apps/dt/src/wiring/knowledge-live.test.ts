// The pages are told when an extraction applied something, never for a replay or an extraction that changed nothing.
import { describe, expect, test } from 'bun:test';
import type { AppliedExtraction, Knowledge, KnowledgeStore } from '@domaintrail/knowledge';
import { tellingExtractions } from './knowledge-live.js';

describe('tellingExtractions', () => {
    test('calls back after an extraction applied items, not after a replay or nothing applied', async () => {
        const answers: AppliedExtraction[] = [
            { items: [{ id: 'kn_00000001' } as unknown as Knowledge.LiveKnowledgeItem], dropped: [], replayed: false },
            { items: [{ id: 'kn_00000001' } as unknown as Knowledge.LiveKnowledgeItem], dropped: [], replayed: true },
            { items: [], dropped: [], replayed: false },
        ];
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stand-in with the one call used
        const store = { applyExtraction: async () => answers.shift() } as unknown as KnowledgeStore;
        let told = 0;
        const telling = tellingExtractions(store, () => told++);
        const extraction = {} as Knowledge.Extraction;
        const project = 'shop' as Knowledge.ProjectName;
        for (let i = 0; i < 3; i++) await telling.applyExtraction(project, extraction);
        expect(told).toBe(1);
    });
});
