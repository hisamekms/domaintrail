// Time and randomness of a running subscriber.
import { randomBytes } from 'node:crypto';
import type { Clock } from '../application/ports.js';

export const systemClock: Clock = {
    sleep: (ms, signal) =>
        new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            const done = (): void => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', done);
                resolve();
            };
            const timer = setTimeout(done, ms);
            signal?.addEventListener('abort', done, { once: true });
        }),
    every(ms, tick) {
        const timer = setInterval(tick, ms);
        return () => clearInterval(timer);
    },
};

/** 16 random bytes, hex: the delimiter of a prompt's block of requests. */
export const randomNonce = (): string => randomBytes(16).toString('hex');
