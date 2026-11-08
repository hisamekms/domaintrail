import { readFile, writeFile } from 'node:fs/promises';

const log = process.argv[2];
const args = process.argv.slice(3);
if (args.includes('--version')) {
    process.stdout.write('codex-cli 0.test\n');
} else if (args.includes('--help')) {
    process.stdout.write('--output-schema --output-last-message --ignore-user-config --ignore-rules --dangerously-bypass-hook-trust --sandbox --json\n');
} else {
    const option = (name) => args[args.indexOf(name) + 1];
    const prompt = await new Promise((resolve) => {
        let text = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
            text += chunk;
        });
        process.stdin.on('end', () => resolve(text));
    });
    const schema = JSON.parse(await readFile(option('--output-schema'), 'utf8'));
    await writeFile(log, JSON.stringify({ args, prompt, schema }));
    await writeFile(option('--output-last-message'), JSON.stringify({ kind: 'answer', answer: 'Codex answered', proposal: null, reason: null }));
    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4 } }) + '\n');
}
