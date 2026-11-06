// The way back after an action that leaves the storming view (ADR 0033): ドメインモデルで見る moves to the other world,
// このタイムラインで見る to another view of the storming. Each leaves a return point: the sticky it started from, what the
// page then showed (the view, the storming's choice of scope and level, the camera), and what it went to. The detail's
// back button (← the sticky) and the browser's Back both return through it while the page still shows where it went.
import type { Camera } from '../view/diagram';
import type { View } from '../view/navigation';

export interface ReturnPoint<Choice> {
    /** The sticky the action started from (selected again on return). */
    readonly from: string;
    /** What the action selected (a `.dt` element, or the same sticky in another view). */
    readonly to: string;
    readonly view: View;
    readonly choice: Choice;
    readonly camera?: Camera;
}

/** The marker of a browser history entry pushed for a return point. */
export const RETURN_STATE = 'domaintrail.return';

/** The return point that applies while `selected` is selected: the latest, if it went there. */
export const currentReturn = <C>(points: readonly ReturnPoint<C>[], selected: string | undefined): ReturnPoint<C> | undefined => {
    const last = points.at(-1);
    return last && last.to === selected ? last : undefined;
};
