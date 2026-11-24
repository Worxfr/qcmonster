import { createContext, useContext } from 'react';
import type { Me, Progress } from './types';

export interface AppState {
  me: Me;
  progress: Progress | null;
  setProgress: (p: Progress) => void;
  refreshProgress: () => Promise<void>;
  earnedBadges: string[];
  addBadges: (ids: string[]) => void;
}

export const AppContext = createContext<AppState | null>(null);
export function useApp(): AppState {
  const v = useContext(AppContext);
  if (!v) throw new Error('AppContext manquant');
  return v;
}
