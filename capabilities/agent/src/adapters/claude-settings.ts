// The user's own model and effort for Claude Code (`~/.claude/settings.json`'s `model` and `effortLevel`): the agent
// starts `claude` without loading any settings file (`claudeArguments`, ADR 0030 as built in M4: the user's allow rules
// could let it read outside the workspace), so a role without a model or effort of its own is given the user's here,
// as plan decision 14 wants ("unset: Claude Code's settings apply"). Nothing else of the file is read; a file that is
// missing or not JSON gives nothing.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { AGENT_EFFORTS } from './config.js';

const MODEL = /^[A-Za-z0-9][\w.:@[\]/-]*$/;

/** The user's `model` and `effortLevel`, when set and fit to pass to `claude`. */
export function userClaudeDefaults(home: string = homedir()): { readonly model?: string; readonly effort?: string } {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    } catch {
        return {};
    }
    if (typeof raw !== 'object' || raw === null) return {};
    const model: unknown = 'model' in raw ? raw.model : undefined;
    const effortLevel: unknown = 'effortLevel' in raw ? raw.effortLevel : undefined;
    return {
        ...(typeof model === 'string' && MODEL.test(model) && { model }),
        ...(typeof effortLevel === 'string' && (AGENT_EFFORTS as readonly string[]).includes(effortLevel) && { effort: effortLevel }),
    };
}
