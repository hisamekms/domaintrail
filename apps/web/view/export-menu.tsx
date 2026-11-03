import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Download, LoaderCircle, Printer } from 'lucide-react';
import { useT } from '../i18n';
import { useDismiss } from '../shared/layout';
import { exportDiagram, type ExportOptions, type ExportTarget } from './export';
import type { View } from './navigation';
import { useLabelHidden, useMenuInside } from './toolbar';

/**
 * What the view toolbar offers to take the view out of the page, at its right end: a canvas view, the 書き出し menu (印刷,
 * PDF, PNG, SVG); the catalog, 印刷 (the page as it is); an empty view (no tab: `undefined`), nothing.
 */
export const toolbarOutput = (view: View['kind'] | undefined): 'export' | 'print' | null =>
    view === undefined ? null : view === 'catalog' ? 'print' : 'export';

/** What the 書き出し menu acts on: the canvas's diagram now, the viewer's options, and the print path. */
export interface ExportControl {
    /** The diagram to export, if there is one now. */
    target: () => ExportTarget | null;
    options: ExportOptions;
    setOptions: (options: ExportOptions) => void;
    /** 印刷 and PDF (the print dialog saves one), if the canvas prints (the main canvas). */
    print?: { preparing: boolean; onPrint: () => void };
}

/**
 * The 書き出し menu: 印刷 and PDF by the print dialog (if the canvas prints), PNG, SVG, then whether they include the
 * heading line (PNG and SVG; a printed sheet always has it) and the legend (printed too). The options are remembered.
 * It opens below the view toolbar's button, or above the inspector's canvas controls.
 */
export function ExportMenu({ control, onDone, up }: { control: ExportControl; onDone: () => void; up?: boolean }): ReactNode {
    const t = useT();
    const [busy, setBusy] = useState(false);
    const menu = useRef<HTMLDivElement>(null);
    useMenuInside(up !== true, menu);
    const { options, setOptions, print } = control;
    const run = (format: 'png' | 'svg'): void => {
        const target = control.target();
        if (!target || busy) return;
        setBusy(true);
        exportDiagram(format, target, options, t)
            .catch((e: unknown) => console.error('export failed', e))
            .finally(() => {
                setBusy(false);
                onDone();
            });
    };
    const printing = (): void => {
        onDone();
        print?.onPrint();
    };
    return (
        <div
            ref={menu}
            className={`toolbar-menu export-menu motion-pop${up ? ' motion-pop-up' : ''}`}
            role="menu"
            aria-label={t.exportMenu.label}
            aria-busy={busy}
        >
            {print && (
                <>
                    <button role="menuitem" disabled={busy} onClick={printing}>
                        {t.exportMenu.print}
                    </button>
                    <button role="menuitem" disabled={busy} onClick={printing}>
                        {t.exportMenu.pdf}
                    </button>
                </>
            )}
            <button role="menuitem" disabled={busy} onClick={() => run('png')}>
                {t.exportMenu.png}
            </button>
            <button role="menuitem" disabled={busy} onClick={() => run('svg')}>
                {t.exportMenu.svg}
            </button>
            <div className="export-menu-options">
                <label className="check">
                    <input type="checkbox" checked={options.heading} onChange={(e) => setOptions({ ...options, heading: e.target.checked })} />
                    {t.exportMenu.withHeading}
                </label>
                <label className="check">
                    <input type="checkbox" checked={options.legend} onChange={(e) => setOptions({ ...options, legend: e.target.checked })} />
                    {t.exportMenu.withLegend}
                </label>
            </div>
        </div>
    );
}

/** The view toolbar's 書き出し button and its menu, opening below it at the right. */
export function ExportButton({ control }: { control: ExportControl }): ReactNode {
    const t = useT();
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const close = useCallback(() => setOpen(false), []);
    useDismiss(open, root, close);
    const text = useRef<HTMLSpanElement>(null);
    const iconOnly = useLabelHidden(text);
    const preparing = control.print?.preparing === true;
    const label = preparing ? t.exportMenu.printing : t.exportMenu.label;
    return (
        <div className="export-popover" ref={root}>
            <button
                className="toolbar-button export-button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={label}
                data-tooltip={iconOnly && !open ? label : undefined}
                onClick={() => setOpen(!open)}
            >
                {preparing ? <LoaderCircle size={13} className="spin" aria-hidden /> : <Download size={13} aria-hidden />}
                <span ref={text} className="toolbar-button-text toolbar-end-label">
                    {t.exportMenu.label}
                </span>
                <span className="toolbar-caret" aria-hidden>
                    ▾
                </span>
            </button>
            {open && <ExportMenu control={control} onDone={close} />}
        </div>
    );
}

/** The catalog's 印刷 button: the page as it is (as Ctrl+P prints it). */
export function PrintButton({ onPrint }: { onPrint: () => void }): ReactNode {
    const t = useT();
    const text = useRef<HTMLSpanElement>(null);
    const iconOnly = useLabelHidden(text);
    return (
        <button
            className="toolbar-button print-button"
            aria-label={t.exportMenu.print}
            data-tooltip={iconOnly ? t.exportMenu.print : undefined}
            onClick={onPrint}
        >
            <Printer size={13} aria-hidden />
            <span ref={text} className="toolbar-button-text toolbar-end-label">
                {t.exportMenu.print}
            </span>
        </button>
    );
}
