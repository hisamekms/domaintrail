// How the session's views name targets: the page's name display setting (ラベル / 名前 / 両方), its model and its
// stormings, given once by the session page to the chat and the facilitator's panel.
import { createContext, useContext } from 'react';
import type { NamingContext } from './targets';

const TargetNaming = createContext<NamingContext | undefined>(undefined);

export const TargetNamingProvider = TargetNaming.Provider;

/** The naming of targets now; undefined outside a provider (targets then show the label they were taken with). */
export const useTargetNaming = (): NamingContext | undefined => useContext(TargetNaming);
