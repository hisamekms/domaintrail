// Markdown imported as text (`with { type: 'text' }`), inlined by Bun when bundling.
declare module '*.md' {
    const text: string;
    export default text;
}
