// The workshop's steps, as the guide's map in the app (contexts/collaboration/src/domain/guide.ts, ES_STEPS) has them
// between 準備 and 終わりと次へ, which the map does not show. Each chapter of 「ワークショップの道のり」 is one step.

export type StepKey = 'prepare' | 'brief' | 'events' | 'flows' | 'exceptions' | 'questions' | 'design' | 'next';

export interface JourneyStep {
    readonly key: StepKey;
    readonly label: string;
    /** a lucide icon's name (src/components/Icon.astro) */
    readonly icon: string;
    /** the goal that ends here: Big Picture ends at 問い, Design Level at デザインレベル */
    readonly goal?: 'Big Picture' | 'Design Level';
    /** whether the app's guide map has this step (準備 and 終わりと次へ are the facilitator's own) */
    readonly onMap: boolean;
}

export const STEPS: readonly JourneyStep[] = [
    { key: 'prepare', label: '準備', icon: 'door-open', onMap: false },
    { key: 'brief', label: 'ブリーフ', icon: 'compass', onMap: true },
    { key: 'events', label: '出来事', icon: 'sticky-note', onMap: true },
    { key: 'flows', label: '流れ・段階', icon: 'route', onMap: true },
    { key: 'exceptions', label: '例外', icon: 'git-fork', onMap: true },
    { key: 'questions', label: '問い', icon: 'circle-question-mark', goal: 'Big Picture', onMap: true },
    { key: 'design', label: 'デザインレベル', icon: 'microscope', goal: 'Design Level', onMap: true },
    { key: 'next', label: '終わりと次へ', icon: 'arrow-right', onMap: false },
];

/** The chapter of a step, from the site's root (the base path is added by the caller). */
export const stepPath = (key: StepKey): string => `workshop/${key}/`;

/** A path under the site's base (import.meta.env.BASE_URL ends with a slash). */
export const withBase = (path: string): string => `${import.meta.env.BASE_URL.replace(/\/?$/, '/')}${path.replace(/^\//, '')}`;
