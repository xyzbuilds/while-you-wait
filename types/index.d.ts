export type Review = { url: string; repo: string; number: number; title: string; author: string; isDraft: boolean; additions: number; deletions: number; files: number; updatedAt: string }
export type MineState = 'changes' | 'failing' | 'ready' | 'waiting' | 'draft'
export type Mine = { url: string; repo: string; number: number; title: string; state: MineState; talk: number; updatedAt: string }
export type Assigned = { url: string; repo: string; number: number; title: string; updatedAt: string }
export type Queue = { reviews: Review[]; mine: Mine[]; issues: Assigned[]; fetchedAt: number; problem?: string }
export type DiffFile = { path: string; added: number; removed: number; hunks: string; isCut: boolean }
export type Detail = { url: string; title: string; meta: string; files: DiffFile[]; more: number; summary?: string; busy?: 'diff' | 'summary'; problem?: string }

declare module 'claude-code' {
  interface PluginState {
    'while-you-wait': { queue: Queue; detail: Detail | null; seen: Record<string, number> }
  }
}
