/** A source handed to the analysis: a `.dt` or `.dtes` file and its text. */
export interface SourceFile {
    /** Path used in diagnostics (typically relative to the workspace root). */
    path: string;
    text: string;
}

/** Where a declaration is in its source. */
export interface Location {
    file: string;
    /** 1-based first line of the declaration. */
    line: number;
    /** 1-based last line of the declaration. */
    endLine: number;
}
