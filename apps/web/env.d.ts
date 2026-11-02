declare module '*.css';
// an image file imported by a module: Bun's bundler copies it into dist/web and gives its URL
declare module '*.svg' {
    const url: string;
    export default url;
}
