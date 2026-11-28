// The arm guides of the Phase 2 AI trial render from docs/guide.md (scripts/trial-guides.ts): a change to the guide that
// breaks a parameter, or an example that no longer checks under its arm, fails here rather than at the trial.
import { expect, test } from 'bun:test';
import { renderArmGuides } from '../scripts/trial-guides.js';

test('every arm guide renders from the guide, differs only on its parameters, and its examples check', async () => {
    const { guides } = await renderArmGuides();
    expect(guides.map((g) => [g.arm, g.changedLines.length > 0])).toEqual([
        ['A0', false],
        ['M2', true],
        ['M3', true],
        ['Q2', true],
    ]);
    const m3 = guides.find((g) => g.arm === 'M3')!.text;
    expect(m3).toContain('.exhaustive()');
    expect(m3).not.toContain('COMPANY { billingEmail } =>');
    expect(guides.find((g) => g.arm === 'Q2')!.text).not.toContain('.every(');
});
