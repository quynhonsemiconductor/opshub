/**
 * CommandPalette state — Zustand store.
 *
 * Lives outside React component tree so any component can open the palette
 * (e.g. AppShell keyboard listener, toolbar button, nav shortcuts).
 */
import { create } from 'zustand';

interface CommandPaletteStore {
  open: boolean;
  /** Seed the search input with a prefix (e.g. '>' for action mode). */
  initialQuery: string;
  show: (initialQuery?: string) => void;
  hide: () => void;
  toggle: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteStore>()((set, get) => ({
  open: false,
  initialQuery: '',
  show: (initialQuery = '') => set({ open: true, initialQuery }),
  hide: () => set({ open: false, initialQuery: '' }),
  toggle: () => (get().open ? get().hide() : get().show()),
}));
