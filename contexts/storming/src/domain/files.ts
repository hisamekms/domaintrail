/** Whether a source is an Event Storming file (`.dtes`, ADR 0024); every other source is a `.dt` file. */
export function isStormingFile(file: string): boolean {
    return file.endsWith('.dtes');
}
