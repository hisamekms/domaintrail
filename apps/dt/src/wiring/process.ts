/** Whether a process with this ID exists (the writer of a session file, e.g.). */
export function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        // EPERM: it exists, owned by someone else
        return e instanceof Error && 'code' in e && e.code === 'EPERM';
    }
}
