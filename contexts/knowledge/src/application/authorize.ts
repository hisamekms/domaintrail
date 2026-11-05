// Who may do what with a project's knowledge (ADR 0031, section 6): one seam, prepared and not yet built. Today every
// project is open to whoever passes Access, so it allows everyone. When a project's `visibility` becomes `members`,
// this is where membership (users and groups attached to the project) is checked; joining the project's sessions must
// be narrowed the same way, since the AI reads knowledge to every participant.
import type { Knowledge } from '../generated/index.js';

/** What a user does with a project's knowledge. */
/** `publish`: replace a storming's published form (`dt publish`), which only a writing service token may. */
export type KnowledgeAction = 'read' | 'extract' | 'correct' | 'delete' | 'publish';

/** Whether a user may act on a project's knowledge: today, always. */
export function authorize(_user: Knowledge.UserName, _project: Knowledge.ProjectName, _action: KnowledgeAction): boolean {
    return true;
}
