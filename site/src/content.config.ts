import { defineCollection, z } from 'astro:content';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';

export const collections = {
    docs: defineCollection({
        loader: docsLoader(),
        schema: docsSchema({
            extend: z.object({
                /** a guide's hero: the figure beside it (figures.json, the guide's own) */
                heroFigure: z.string().optional(),
                heroFigureAlt: z.string().optional(),
                heroFigureCaption: z.string().optional(),
                /** a guide's hero: who it is for, how long, how many (a lucide icon and a short text each) */
                heroMeta: z.array(z.object({ icon: z.string(), text: z.string() })).optional(),
            }),
        }),
    }),
    i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
