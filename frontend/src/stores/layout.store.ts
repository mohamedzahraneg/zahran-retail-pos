import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface LayoutState {
  /** Sidebar collapsed (icons-only) on desktop. */
  collapsed: boolean;
  /** Sidebar drawer open on mobile. */
  mobileOpen: boolean;
  /** POS: products panel visible. */
  posProductsOpen: boolean;
  toggleCollapsed: () => void;
  openMobile: () => void;
  closeMobile: () => void;
  togglePosProducts: () => void;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      collapsed: false,
      mobileOpen: false,
      posProductsOpen: true,
      toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
      openMobile: () => set({ mobileOpen: true }),
      closeMobile: () => set({ mobileOpen: false }),
      togglePosProducts: () =>
        set((s) => ({ posProductsOpen: !s.posProductsOpen })),
    }),
    {
      name: 'zahran-layout',
      partialize: (s) => ({
        collapsed: s.collapsed,
        posProductsOpen: s.posProductsOpen,
      }),
    },
  ),
);
