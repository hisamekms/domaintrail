// Markdown imported as text (`with { type: 'text' }`), inlined by Bun when bundling.
declare module '*.md' {
    const text: string;
    export default text;
}

// The Live View's stylesheet imported as text (`dt export svg` reads its colours and fonts), inlined the same way.
declare module '*.css' {
    const text: string;
    export default text;
}
