import { afterEach, describe, expect, test } from 'bun:test';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { runCli } from '../src/cli/main.js';
import type { Analysis } from '../src/core/analyze.js';
import { formatStorming } from '../src/dtes/format.js';
import type { ViewOptions } from '../src/visualization/domain/storming/ir.js';
import { projectView } from '../src/visualization/domain/storming/render.js';
import { EXAMPLES, check, tempCopyOfExamples } from './helpers.js';

/**
 * The two use cases of the Event Storming DSL end to end (spec §1.1, §15, appendix), through `analyze`, the projection
 * and the CLI: UC1 grows a storming from events alone to a Design Level with refs into a new `.dt` model, UC2 storms
 * from the existing model of examples/shop and finds what it lacks without touching it.
 */

const dirs: string[] = [];
afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out, err };
}

/** Every stage is formatted and checks without any diagnostic, as an agent leaves it after `dt fmt` and `dt check`. */
async function clean(files: Record<string, string>): Promise<Analysis> {
    for (const [name, text] of Object.entries(files)) if (name.endsWith('.dtes')) expect(formatStorming(text)).toBe(text);
    const a = await check(files);
    expect(a.diagnostics).toEqual([]);
    expect(a.ok).toBe(true);
    return a;
}

/** The node IDs of one view of the workspace's only storming. */
const view = (a: Analysis, options: ViewOptions): string[] => projectView(a.stormings.stormings[0]!, options).nodes.map((n) => n.id);
const BIG_PICTURE: ViewOptions = { level: 'big-picture' };
const DESIGN_LEVEL: ViewOptions = { level: 'design-level' };

// ---- UC1 ----

/** Stage 1, Big Picture: events, timelines and a question, before any model. */
const BIG = `storming Rental "自転車レンタル" {
  event BikeReserved "自転車が予約された"
  event BikePickedUp "自転車が貸し出された"
  event BikeReturned "自転車が返却された"
  event LateFeeCharged "延滞料が課金された"
  event ReservationExpired "予約が期限切れになった"

  timeline Normal "通常" {
    BikeReserved
    BikePickedUp
    BikeReturned
  }
  timeline Late "延滞" {
    BikeReserved
    BikePickedUp
    group LateReturn "延滞した返却" {
      BikeReturned
      LateFeeCharged
    }
  }
  timeline NoShow "来店なし" {
    BikeReserved
    ReservationExpired
  }

  hotspot ExpiryTime "予約は何分で期限切れになる？" {
    on ReservationExpired
  }
}
`;

/** Stage 2, Design Level: who does what, from which information, on which aggregate; the late fee crosses into Billing. */
const DESIGN = `storming Rental "自転車レンタル" {
  event BikeReserved "自転車が予約された"
  event BikePickedUp "自転車が貸し出された"
  event BikeReturned "自転車が返却された"
  event LateFeeCharged "延滞料が課金された"
  event ReservationExpired "予約が期限切れになった"

  actor Member "会員"
  external Clock "時計"
  readmodel Availability "空き状況"

  aggregate Reservation "予約"
  aggregate Loan "貸出"
  aggregate LateFee "延滞料"

  command Reserve "予約する" {
    actor Member
    reads Availability
    target Reservation
    emits BikeReserved
  }
  command Expire "期限切れにする" {
    actor Clock
    target Reservation
    emits ReservationExpired
  }
  command PickUp "借りる" {
    actor Member
    target Loan
    emits BikePickedUp
  }
  command GiveBack "返す" {
    actor Member
    target Loan
    emits BikeReturned
  }
  command ChargeLateFee "延滞料を課金する" {
    target LateFee
    emits LateFeeCharged
  }

  policy ChargeLateReturn "延滞した返却に課金する" {
    on BikeReturned
    issues ChargeLateFee
  }

  timeline Normal "通常" {
    BikeReserved
    BikePickedUp
    BikeReturned
  }
  timeline Late "延滞" {
    BikeReserved
    BikePickedUp
    group LateReturn "延滞した返却" {
      BikeReturned
      LateFeeCharged
    }
  }
  timeline NoShow "来店なし" {
    BikeReserved
    ReservationExpired
  }

  hotspot ExpiryTime "予約は何分で期限切れになる？" {
    on ReservationExpired
    status resolved
    resolution "30 分"
  }
}
`;

/** The `.dt` model proposed from the Design Level storming. */
const MODEL = {
    'fleet/reservation.dt': `context Fleet {
  id ReservationId: UUID
  id BikeId: UUID

  aggregate Reservation "予約" {
    id: ReservationId
    bike: BikeId

    state Reserved
    state Expired

    create command reserve(id: ReservationId, bike: BikeId)
      -> Reserved
      emits BikeReserved
    command expire()
      Reserved -> Expired
      emits ReservationExpired
  }

  event BikeReserved {
    reservationId: ReservationId
    bike: BikeId
  }
  event ReservationExpired {
    reservationId: ReservationId
  }
}
`,
    'fleet/loan.dt': `context Fleet {
  id LoanId: UUID

  aggregate Loan "貸出" {
    id: LoanId
    bike: BikeId

    state Lent
    state Returned

    create command pickUp(id: LoanId, bike: BikeId)
      -> Lent
      emits BikePickedUp
    command giveBack()
      Lent -> Returned
      emits BikeReturned
  }

  event BikePickedUp {
    loanId: LoanId
  }
  event BikeReturned {
    loanId: LoanId
  }
}
`,
    'billing/late-fee.dt': `context Billing {
  id LateFeeId: UUID

  aggregate LateFee "延滞料" {
    id: LateFeeId
    loan: Fleet.LoanId

    create command charge(id: LateFeeId, loan: Fleet.LoanId) emits LateFeeCharged
  }

  event LateFeeCharged {
    lateFeeId: LateFeeId
    loan: Fleet.LoanId
  }
}
`,
};

/** The `ref`s added once the model has the symbols, in the order an agent adds them. */
const EVENT_REFS: Record<string, string> = {
    BikeReserved: 'Fleet.BikeReserved',
    BikePickedUp: 'Fleet.BikePickedUp',
    BikeReturned: 'Fleet.BikeReturned',
    LateFeeCharged: 'Billing.LateFeeCharged',
    ReservationExpired: 'Fleet.ReservationExpired',
};
const AGGREGATE_REFS: Record<string, string> = { Reservation: 'Fleet.Reservation', Loan: 'Fleet.Loan', LateFee: 'Billing.LateFee' };
const COMMAND_REFS: Record<string, string> = {
    Reserve: 'Fleet.Reservation.reserve',
    Expire: 'Fleet.Reservation.expire',
    PickUp: 'Fleet.Loan.pickUp',
    GiveBack: 'Fleet.Loan.giveBack',
    ChargeLateFee: 'Billing.LateFee.charge',
};

/** Adds `ref <path>` to the declaration of `id` in a formatted storming, as its first clause. */
function addRef(text: string, kind: string, id: string, refPath: string): string {
    const declaration = new RegExp(`^  ${kind} ${id}( "[^"]*")?( \\{)?$`, 'm');
    const match = declaration.exec(text);
    expect(match).not.toBeNull();
    const [line, label = '', body] = match!;
    const replaced = body ? `${line}\n    ref ${refPath}` : `  ${kind} ${id}${label} {\n    ref ${refPath}\n  }`;
    return text.replace(line, replaced);
}

describe('UC1: from events to a Design Level storming, then to a .dt model', () => {
    test('each stage checks clean: events only, then the Design Level, then the model, then the refs one by one', async () => {
        const big = await clean({ 'stormings/rental.dtes': BIG });
        const events = view(big, BIG_PICTURE);
        expect(events.filter((id) => id.startsWith('n:'))).toEqual(['n:ExpiryTime']);

        const design = await clean({ 'stormings/rental.dtes': DESIGN });
        // the same file goes back to Big Picture: the events and the hotspot, as before the Design Level was added
        expect(view(design, BIG_PICTURE)).toEqual(events);
        expect(view(design, DESIGN_LEVEL)).toEqual(expect.arrayContaining(['n:Member', 'n:Clock', 'n:Availability', 'n:ChargeLateReturn', 'n:LateFee']));

        // the model, proposed from the storming: the storming has no refs yet, and needs none
        await clean({ ...MODEL, 'stormings/rental.dtes': DESIGN });

        let storming = DESIGN;
        const stages = [
            ...Object.entries(EVENT_REFS).map(([id, ref]) => ['event', id, ref]),
            ...Object.entries(AGGREGATE_REFS).map(([id, ref]) => ['aggregate', id, ref]),
            ...Object.entries(COMMAND_REFS).map(([id, ref]) => ['command', id, ref]),
        ];
        for (const [kind, id, ref] of stages) {
            storming = addRef(storming, kind!, id!, ref!);
            await clean({ ...MODEL, 'stormings/rental.dtes': storming });
        }
        expect(storming.match(/^\s+ref /gm)).toHaveLength(13);
        // the refs change no view
        const final = await check({ ...MODEL, 'stormings/rental.dtes': storming });
        expect(view(final, DESIGN_LEVEL)).toEqual(view(design, DESIGN_LEVEL));
        expect(view(final, BIG_PICTURE)).toEqual(events);
    });

    test('a ref is added only once the .dt symbol exists: before, it is an error', async () => {
        const early = addRef(BIG, 'event', 'BikeReserved', 'Fleet.BikeReserved');
        const a = await check({ 'stormings/rental.dtes': early, 'fleet/other.dt': 'context Fleet {}\n' });
        expect(a.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual(["S010 The event ref 'Fleet.BikeReserved' names nothing in the .dt model."]);
    });
});

// ---- UC2 ----

const SHOP_STORMING = 'stormings/order-to-cash.dtes';

/** The `.dt` files of a workspace with their bytes. */
async function dtFiles(dir: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const entry of await readdir(dir, { recursive: true })) {
        if (entry.endsWith('.dt')) files[entry] = await readFile(path.join(dir, entry), 'utf8');
    }
    return files;
}

describe('UC2: storming from the existing model of examples/shop', () => {
    test('the example storms refer to the model, and every ref resolves', async () => {
        const text = await readFile(path.join(EXAMPLES, SHOP_STORMING), 'utf8');
        expect(text.match(/^\s+ref /gm)!.length).toBeGreaterThanOrEqual(10);
        const r = await run('-r', EXAMPLES, 'check', '--format', 'json');
        expect(r.code).toBe(0);
        expect(JSON.parse(r.out.join('\n'))).toMatchObject({ diagnostics: [], summary: { errors: 0, warnings: 0 } });
    });

    test('adding exceptions and hotspots to the storming checks clean and leaves every .dt file byte-identical', async () => {
        const dir = await tempCopyOfExamples();
        dirs.push(dir);
        const before = await dtFiles(dir);
        expect(Object.keys(before).length).toBe(6);

        // an exception found while storming, written loosely; `dt fmt` formats the storming only
        const file = path.join(dir, SHOP_STORMING);
        const original = await readFile(file, 'utf8');
        const edited = original.replace('  event PaymentFailed', '  event InvoiceVoided "請求書が無効になった"\n    event PaymentFailed').replace(
            /\n}\n$/,
            `
  command VoidInvoice "請求書を無効にする" { target Invoice
    emits InvoiceVoided }
  policy VoidInvoiceOfCancelledOrder { on RefundRequested
  issues VoidInvoice }
  timeline CancelAfterInvoice "請求後の取消" { OrderPlaced ItemAdded OrderConfirmed InvoiceIssued
    group CancelledAfterInvoice { RefundRequested OrderCancelled } InvoiceVoided }
  hotspot VoidOrCredit "請求書を無効にする？ 赤伝を発行する？" { on InvoiceVoided }
}
`,
        );
        await writeFile(file, edited);
        const fmt = await run('-r', dir, 'fmt');
        expect(fmt).toEqual({ code: 0, out: [SHOP_STORMING, '8 file(s): 1 formatted.'], err: [] });
        const formatted = await readFile(file, 'utf8');
        expect(formatted).toContain('  command VoidInvoice "請求書を無効にする" {\n    target Invoice\n    emits InvoiceVoided\n  }\n');

        const checked = await run('-r', dir, 'check');
        expect(checked).toEqual({ code: 0, out: ['8 file(s) checked: 0 error(s), 0 warning(s).'], err: [] });
        // a ref the model lacks is reported in the storming, never fixed in the model
        await writeFile(file, addRef(formatted, 'event', 'InvoiceVoided', 'Billing.InvoiceVoided'));
        const missing = await run('-r', dir, 'check');
        expect(missing.code).toBe(1);
        expect(missing.err[0]).toMatch(
            /^stormings\/order-to-cash\.dtes:\d+:5 - error S010: The event ref 'Billing\.InvoiceVoided' names nothing in the \.dt model\.$/,
        );
        expect(await run('-r', dir, 'generate', 'ts', '--out', 'gen')).toMatchObject({ code: 0 });

        expect(await dtFiles(dir)).toEqual(before);
    });

    test('the timeline filter of the example shows a timeline with its one-hop causal paths, at both levels', async () => {
        const a = await check(Object.fromEntries(await Promise.all([SHOP_STORMING].map(async (f) => [f, await readFile(path.join(EXAMPLES, f), 'utf8')]))));
        const normal = view(a, { level: 'design-level', timelineId: 'Normal' });
        // OrderConfirmed → BillConfirmedOrder → IssueInvoice → InvoiceIssued: both ends are in Normal
        expect(normal).toEqual(expect.arrayContaining(['n:BillConfirmedOrder', 'n:IssueInvoice', 'n:OrderTotal', 'n:Invoice']));
        expect(normal).not.toContain('n:CancelOrder');
        const cancel = view(a, { level: 'big-picture', timelineId: 'CancelAfterConfirm' });
        expect(cancel.filter((id) => id.startsWith('n:'))).toEqual(['n:InvoiceOfCancelledOrder', 'n:MixedCurrencies']);
    });
});
