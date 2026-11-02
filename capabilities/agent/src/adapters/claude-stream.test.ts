// What Claude Code streams (`--output-format stream-json --verbose`; ADR 0026, amendment: what a running run is doing):
// its events mapped onto the protocol's activities, and the result taken from the stream as it was from the JSON
// output. The fixture is trimmed from a real run of Claude Code 2.1.316, with a shell call and a read outside the
// workspace added.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { activityOfEvent, createStreamReader, MAX_OUTPUT, resultOf, toolActivity, workspacePath } from './claude-stream.js';

const ROOT = '/workspace/shop';
const FIXTURE = readFileSync(path.join(import.meta.dir, '../../test-fixtures/claude-stream.jsonl'), 'utf8');

const assistant = (...content: object[]): object => ({ type: 'assistant', message: { role: 'assistant', content } });
const tool = (name: string, input: object): object => ({ type: 'tool_use', id: 't', name, input });

describe("Claude Code's events as activities", () => {
    test('reading, editing and checking with their file or command; finishing with the reply and the result', () => {
        expect(activityOfEvent(assistant(tool('Read', { file_path: `${ROOT}/model/order.dt` })), [ROOT])).toEqual({
            phase: 'reading',
            subject: 'model/order.dt',
        });
        expect(activityOfEvent(assistant(tool('Grep', { pattern: 'Order', path: `${ROOT}/model` })), [ROOT])).toEqual({ phase: 'reading', subject: 'model' });
        expect(activityOfEvent(assistant(tool('Glob', { pattern: '**/*.dt' })), [ROOT])).toEqual({ phase: 'reading' });
        expect(activityOfEvent(assistant(tool('Edit', { file_path: `${ROOT}/order.dt`, old_string: 'a', new_string: 'b' })), [ROOT])).toEqual({
            phase: 'editing',
            subject: 'order.dt',
        });
        expect(activityOfEvent(assistant(tool('Write', { file_path: 'returns.dtes', content: '' })), [ROOT])).toEqual({
            phase: 'editing',
            subject: 'returns.dtes',
        });
        expect(activityOfEvent(assistant(tool('MultiEdit', { file_path: `${ROOT}/a.dt`, edits: [] })), [ROOT])).toEqual({ phase: 'editing', subject: 'a.dt' });
        expect(activityOfEvent(assistant(tool('Bash', { command: 'dt check' })), [ROOT])).toEqual({ phase: 'checking', subject: 'dt check' });
        expect(activityOfEvent(assistant(tool('Bash', { command: 'dt fmt order.dt' })), [ROOT])).toEqual({ phase: 'checking', subject: 'dt fmt' });
        expect(activityOfEvent(assistant(tool('StructuredOutput', { summary: 'Done.' })), [ROOT])).toEqual({ phase: 'finishing' });
        expect(activityOfEvent({ type: 'result', subtype: 'success', result: '{}' }, [ROOT])).toEqual({ phase: 'finishing' });
        // the last tool call of a message that maps
        expect(activityOfEvent(assistant(tool('Read', { file_path: `${ROOT}/a.dt` }), tool('Edit', { file_path: `${ROOT}/b.dt` })), [ROOT])).toEqual({
            phase: 'editing',
            subject: 'b.dt',
        });
    });

    test('unknown events, text, tool results and other commands change nothing', () => {
        for (const event of [
            { type: 'system', subtype: 'init', cwd: ROOT },
            { type: 'rate_limit_event' },
            { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } },
            assistant({ type: 'text', text: 'Let me read the file.' }),
            assistant(tool('Bash', { command: 'ls -la' })),
            assistant(tool('Bash', { command: 'rm -rf dt' })),
            assistant(tool('Bash', { command: 'dtx check' })),
            assistant(tool('WebFetch', { url: 'https://example.com' })),
            { type: 'assistant', message: 'not a message' },
            { type: 'something-new', payload: {} },
            'text',
            null,
        ])
            expect(activityOfEvent(event, [ROOT])).toBeUndefined();
    });

    test('a path outside the workspace is never told: the phase without its subject', () => {
        expect(toolActivity('Read', { file_path: '/etc/hosts' }, [ROOT])).toEqual({ phase: 'reading' });
        expect(toolActivity('Read', { file_path: `${ROOT}/../secret.dt` }, [ROOT])).toEqual({ phase: 'reading' });
        expect(toolActivity('Edit', { file_path: '../other/a.dt' }, [ROOT])).toEqual({ phase: 'editing' });
        expect(toolActivity('Grep', { path: ROOT }, [ROOT])).toEqual({ phase: 'reading' });
        expect(workspacePath(`${ROOT}shop2/a.dt`, [ROOT])).toBeUndefined();
        // a name that only starts with two dots is inside
        expect(workspacePath(`${ROOT}/..notes.dt`, [ROOT])).toBe('..notes.dt');
        // the workspace's real path counts as the workspace
        expect(workspacePath('/private/workspace/shop/a.dt', [ROOT, '/private/workspace/shop'])).toBe('a.dt');
        // nor a path no page should show
        expect(toolActivity('Read', { file_path: `${ROOT}/a\nb.dt` }, [ROOT])).toEqual({ phase: 'reading' });
        expect(toolActivity('Read', { file_path: `${ROOT}/${'x'.repeat(300)}.dt` }, [ROOT])).toEqual({ phase: 'reading' });
    });
});

describe("Claude Code's stream", () => {
    test("a real run's events, in chunks of any size: the activities as they come, the result from the result event", () => {
        for (const size of [1, 7, 64, FIXTURE.length]) {
            const told: unknown[] = [];
            const reader = createStreamReader((event) => {
                const activity = activityOfEvent(event, [ROOT]);
                if (activity) told.push(activity);
            });
            for (let i = 0; i < FIXTURE.length; i += size) reader.push(FIXTURE.slice(i, i + size));
            const result = reader.end();
            expect(told).toEqual([
                { phase: 'reading' },
                { phase: 'reading', subject: 'shop.dt' },
                { phase: 'reading' },
                { phase: 'editing', subject: 'shop.dt' },
                { phase: 'checking', subject: 'dt check' },
                { phase: 'finishing' },
                { phase: 'finishing' },
            ]);
            expect(result.structured).toMatchObject({ outcome: 'done', summary: 'Renamed the context.' });
            expect(JSON.parse(result.text)).toEqual(result.structured);
        }
    });

    test('output that is not a stream is read as before: one JSON result, or text', () => {
        const read = (stdout: string): ReturnType<ReturnType<typeof createStreamReader>['end']> => {
            const reader = createStreamReader(() => {});
            reader.push(stdout);
            return reader.end();
        };
        expect(read('{"type":"result","subtype":"success","is_error":false,"result":"a\\nb"}\n')).toEqual({ text: 'a\nb' });
        expect(read('{"type":"result","result":"{}","structured_output":{"outcome":"done"}}')).toEqual({ text: '{}', structured: { outcome: 'done' } });
        expect(read('I made the changes.\n\nDT-OUTCOME: {"outcome":"done","summary":"x"}\n')).toEqual({
            text: 'I made the changes.\n\nDT-OUTCOME: {"outcome":"done","summary":"x"}',
        });
        expect(read('{\n  "result": "pretty"\n}\n')).toEqual({ text: 'pretty' });
        expect(read('plain text')).toEqual({ text: 'plain text' });
        expect(read('')).toEqual({ text: '' });
    });

    test('a line past the limit is dropped up to its end; the stream goes on', () => {
        const reader = createStreamReader(() => {});
        reader.push('x'.repeat(MAX_OUTPUT + 1));
        reader.push('still the same line\n');
        reader.push('{"type":"result","result":"after"}\n');
        expect(reader.end()).toEqual({ text: 'after' });
    });

    test('resultOf: the JSON result, else the raw output', () => {
        expect(resultOf('noise\n{"type":"result","result":"r"}')).toEqual({ text: 'r' });
        expect(resultOf('plain text')).toEqual({ text: 'plain text' });
    });
});
