// The knowledge store's Worker (ADR 0031, section 5): DomainTrail ships it as a template the user deploys
// (template/README.md); dt creates nothing in Cloudflare. `fetch` serves the HTTP API (http.ts); the Cron Trigger runs
// the sweep (sweep.ts) that completes deletions.
import type { Env, ExecutionContext, ScheduledController } from './env.js';
import { handle } from './http.js';
import { sweep } from './sweep.js';

/** How long a deleted item waits for the sweep by default, in seconds: past the page's 10 s of 元に戻す. */
const SWEEP_AFTER_SECONDS = 60;

export default {
    fetch(request: Request, env: Env): Promise<Response> {
        return handle(request, env);
    },

    scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
        const after = Number(env.SWEEP_AFTER_SECONDS ?? SWEEP_AFTER_SECONDS);
        const afterMs = (Number.isFinite(after) && after >= 0 ? after : SWEEP_AFTER_SECONDS) * 1000;
        ctx.waitUntil(
            sweep(env.DB, env.IMAGES, new Date(controller.scheduledTime), { afterMs }).then((report) => {
                if (report.items > 0 || report.images > 0 || report.failed > 0) console.log(`knowledge-worker: swept ${JSON.stringify(report)}`);
            }),
        );
    },
};
