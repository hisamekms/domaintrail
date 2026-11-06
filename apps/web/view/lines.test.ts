import { describe, expect, test } from 'bun:test';
import type { LineRelation } from '@domaintrail/visualization';
import { MESSAGES } from '../i18n';
import { buildScene } from '../render';
import { viewPayloads } from '../test-helpers';
import { kindName, lineWords, stickyKind } from './lines';

const ja = MESSAGES.ja;
const en = MESSAGES.en;

describe('what a line says (the approved wording)', () => {
    const say = (kind: LineRelation, names: string[] = []): string => lineWords(ja, { kind, names }, 'A', 'B');
    test('流れ', () => {
        expect(say('issues')).toBe('「A」が「B」');
        expect(say('looksAt')).toBe('「B」は「A」を見て判断する');
        expect(say('handles')).toBe('「A」を「B」が受けて処理する');
        expect(say('decides')).toBe('「A」が処理して「B」');
        expect(say('decides', ['C1', 'C2'])).toBe('「A」が処理して「B」（「C1」「C2」から）');
        expect(say('triggers')).toBe('「A」をきっかけにポリシー「B」が働く');
        expect(say('policyIssues')).toBe('ポリシー「A」により「B」');
        expect(say('follows')).toBe('「A」がポリシー「B」に従って動く');
        expect(say('updates')).toBe('「A」で「B」が更新される');
        expect(say('arrives')).toBe('「A」から「B」が届く');
    });
    test('時間', () => {
        expect(say('branches', ['失敗'])).toBe('例外「失敗」へ分かれる');
        expect(say('returns', ['失敗'])).toBe('例外「失敗」から戻る');
        expect(say('order', ['通常'])).toBe('「通常」で「A」のあとに「B」');
        // in every timeline of the view: no timeline named
        expect(say('order')).toBe('「A」のあとに「B」');
    });
    test('問い', () => {
        expect(say('question')).toBe('「B」への問い');
        expect(say('undecidedIssuer')).toBe('「B」を誰が行うかはまだ決まっていない');
        expect(say('undecidedHandler')).toBe('「B」を誰が処理するかはまだ決まっていない');
    });
    test('every relation has its English words', () => {
        for (const kind of Object.keys(ja.lines.relations) as LineRelation[]) expect(lineWords(en, { kind, names: ['N'] }, 'A', 'B')).not.toBe('');
        expect(lineWords(en, { kind: 'handles', names: [] }, 'Place', 'Order')).toBe('“Order” takes “Place” and handles it');
    });
    test('an end’s colour box and kind name come from the note’s kind', () => {
        expect(stickyKind('esReadModel')).toBe('readmodel');
        expect(stickyKind('esExternal')).toBe('external');
        expect(stickyKind('aggregate')).toBe('');
        expect(kindName(ja, 'esCommand')).toBe('コマンド');
        expect(kindName(ja, 'esGap')).toBe('未決定');
        expect(ja.lines.goTo(kindName(ja, 'esCommand'), '配車を組む')).toBe('コマンド 配車を組む へ移る');
    });
});

describe('the lines of a storming, as the canvas says them', () => {
    test('each relation kind, from the scene’s labels', async () => {
        const [payload] = await viewPayloads([
            {
                path: 'es.dtes',
                text: `storming S {
  event Placed "受け付けた"
  event Paid "支払われた" { from Bank }
  event Done "終わった"
  actor Clerk "係"
  external Bank "銀行"
  readmodel Board "一覧" { from Placed }
  aggregate Order "注文"
  command Place "受け付ける" { by Clerk reads Board handledBy Order emits Placed }
  command Close "閉じる" { handledBy Order emits Done }
  command Ask "問い合わせる" { by Clerk emits Done }
  policy Settle "精算する" { on Paid reads Board issues Close by Clerk }
  hotspot Who "誰が処理する？" { on Ask }
  timeline T "通常" { Placed Paid Done }
}
`,
            },
        ]);
        const scene = buildScene(payload!.stormings[0]!.views['design-level|']!.graph, { diff: payload!.diff, diagnostics: [], mode: 'label', lang: 'ja' });
        const label = new Map(scene.nodes.map((n) => [n.id, n.props.label]));
        const said = new Set(
            scene.edges.flatMap((e) => (e.props.relation ? [lineWords(ja, e.props.relation, label.get(e.source) ?? '', label.get(e.target) ?? '')] : [])),
        );
        for (const words of [
            '「係」が「受け付ける」',
            '「係」は「一覧」を見て判断する',
            '「精算する」は「一覧」を見て判断する',
            '「受け付ける」を「注文」が受けて処理する',
            '「注文」が処理して「受け付けた」',
            '「受け付けた」で「一覧」が更新される',
            '「銀行」から「支払われた」が届く',
            '「支払われた」をきっかけにポリシー「精算する」が働く',
            'ポリシー「精算する」により「閉じる」',
            '「係」がポリシー「精算する」に従って動く',
            '「問い合わせる」への問い',
            '「問い合わせる」を誰が処理するかはまだ決まっていない',
        ])
            expect([...said]).toContain(words);
        // a read model goes to whoever decides, never to a command (ADR 0032 §9)
        const reads = scene.edges.filter((e) => e.props.relation?.kind === 'looksAt');
        expect(reads.map((e) => scene.nodes.find((n) => n.id === e.target)?.props.label).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
            '係',
            '精算する',
        ]);
    });
});
