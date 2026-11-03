// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// GitHub Pages: the workflow (.github/workflows/site.yml) passes the origin and the base path that
// actions/configure-pages gives; locally the site is served from the root.
const site = process.env.SITE_ORIGIN || undefined;
const base = process.env.SITE_BASE || '/';

/** A step of the workshop in the sidebar: its number in a circle (data-n), its goal as a badge. */
const step = (n, label, en, slug, goal) => ({
    label,
    translations: { en },
    slug: `workshop/${slug}`,
    attrs: { 'data-n': String(n) },
    ...(goal && { badge: { text: goal, variant: 'success' } }),
});

export default defineConfig({
    site,
    base,
    trailingSlash: 'always',
    integrations: [
        starlight({
            title: { ja: 'DomainTrail ES ガイド', en: 'DomainTrail ES guide' },
            description: 'DomainTrail で Event Storming のワークショップを回すファシリテーターのためのガイド',
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
            sidebar: [
                {
                    label: 'はじめに',
                    translations: { en: 'Start here' },
                    items: [
                        { label: 'このガイドについて', translations: { en: 'About this guide' }, slug: 'index' },
                        { label: '人と AI の分担', translations: { en: 'People and the AI' }, slug: 'roles' },
                    ],
                },
                {
                    label: 'ワークショップの道のり',
                    translations: { en: 'The workshop, step by step' },
                    items: [
                        step(1, '準備', 'Preparing', 'prepare'),
                        step(2, 'ブリーフ', 'The brief', 'brief'),
                        step(3, '出来事', 'Events', 'events'),
                        step(4, '流れ・段階', 'Flows and stages', 'flows'),
                        step(5, '例外', 'Exceptions', 'exceptions'),
                        step(6, '問い', 'Questions', 'questions', 'BP'),
                        step(7, 'デザインレベル', 'Design Level', 'design', 'DL'),
                        step(8, '終わりと次へ', 'Wrapping up', 'next'),
                    ],
                },
                { label: '迷ったら', translations: { en: 'When unsure' }, slug: 'lost' },
                {
                    label: '付録',
                    translations: { en: 'Appendices' },
                    items: [
                        { label: '2時間のアジェンダ', translations: { en: 'A 2-hour agenda' }, slug: 'appendix/agenda' },
                        { label: '参加者向けの1枚', translations: { en: 'For participants' }, slug: 'appendix/participants' },
                        { label: 'よくあるつまずき', translations: { en: 'Common pitfalls' }, slug: 'appendix/pitfalls' },
                    ],
                },
            ],
        }),
    ],
});
