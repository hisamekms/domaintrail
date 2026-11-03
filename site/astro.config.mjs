// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

// GitHub Pages: the workflow (.github/workflows/site.yml) passes the origin and the base path that
// actions/configure-pages gives; locally the site is served from the root.
const site = process.env.SITE_ORIGIN || undefined;
const base = process.env.SITE_BASE || '/';

/**
 * The sidebar: the top page, then one group per guide. A guide is a directory of src/content/docs with a `_guide.json`
 * (its label, order and items), so a new guide is a new directory: `event-storming/` now; `getting-started/`,
 * `modeling/` and `reference/` are the places kept for DomainTrail's own guides. English mirrors them under `en/`.
 */
const DOCS = new URL('./src/content/docs/', import.meta.url);

/** `{ ja, en }` as Starlight's label and its translations. */
const labelled = (label) => ({ label: label.ja, translations: { en: label.en } });

function guideGroups() {
    return readdirSync(DOCS, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== 'en' && existsSync(new URL(`${d.name}/_guide.json`, DOCS)))
        .map((d) => ({ dir: d.name, ...JSON.parse(readFileSync(new URL(`${d.name}/_guide.json`, DOCS), 'utf8')) }))
        .sort((a, b) => a.order - b.order)
        .map((g) => ({
            ...labelled(g.label),
            items: g.items.map((item) =>
                typeof item === 'string'
                    ? { slug: item === 'index' ? g.dir : `${g.dir}/${item}` }
                    : { ...labelled(item.label), items: [{ autogenerate: { directory: `${g.dir}/${item.directory}` } }] },
            ),
        }));
}

export default defineConfig({
    site,
    base,
    trailingSlash: 'always',
    integrations: [
        starlight({
            title: 'DomainTrail',
            description: 'DomainTrail のドキュメント：ガイドとリファレンス',
            logo: { light: '../assets/brand/logo-light.svg', dark: '../assets/brand/logo-dark.svg', alt: 'DomainTrail' },
            favicon: '/favicon.svg',
            defaultLocale: 'root',
            locales: {
                root: { label: '日本語', lang: 'ja' },
                // English pages are stubs for now: a page missing in English shows the Japanese one with a notice
                en: { label: 'English', lang: 'en' },
            },
            social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/hisamekms/domaintrail' }],
            customCss: ['./src/styles/site.css'],
            components: { Hero: './src/components/overrides/Hero.astro' },
            sidebar: [{ label: 'DomainTrail のドキュメント', translations: { en: 'DomainTrail docs' }, slug: 'index' }, ...guideGroups()],
        }),
    ],
});
