/** Safe, actionable text for a CLI whose executable cannot be run. Never include arguments or stderr. */
export function executableFormatFailure(error: unknown, cli: 'claude' | 'codex', command: string, stage: string): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOEXEC') return undefined;
    const other = cli === 'claude' ? 'codex' : 'claude';
    const locate = process.platform === 'win32' ? `where.exe ${cli}` : `command -v ${cli}`;
    return `${cli} could not start (stage: ${stage}; command: ${JSON.stringify(command)}; OS: ${process.platform}; code: ENOEXEC). Check \`${locate}\` and the executable it resolves to; a broken file, script without a valid interpreter, or binary for another OS/architecture may need reinstalling. Try \`dt open --agent ${other}\` if installed, or \`dt open --no-agent\` to use the chat without an agent.`;
}
