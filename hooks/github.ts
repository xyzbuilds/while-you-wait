import type { Assigned, DiffFile, Mine, MineState, Queue, Review } from '../types'

export const DAYS = 90
export const MAX_FILES = 25
export const MAX_FILE_CHARS = 9000

export const QUERY = `query($review: String!, $mine: String!, $issues: String!) {
  review: search(query: $review, type: ISSUE, first: 20) { nodes { ... on PullRequest { number title url isDraft updatedAt additions deletions changedFiles author { login } repository { nameWithOwner } } } }
  mine: search(query: $mine, type: ISSUE, first: 20) { nodes { ... on PullRequest { number title url isDraft updatedAt reviewDecision comments { totalCount } reviews { totalCount } repository { nameWithOwner } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } }
  issues: search(query: $issues, type: ISSUE, first: 20) { nodes { ... on Issue { number title url updatedAt repository { nameWithOwner } } } }
}`

export function searchTerms(login: string, now: number, repo?: string): { review: string; mine: string; issues: string } {
  const since = new Date(now - DAYS * 86_400_000).toISOString().slice(0, 10)
  const scope = `archived:false updated:>=${since}${repo ? ` repo:${repo}` : ''} sort:updated-desc`
  return {
    review: `is:pr is:open review-requested:${login} ${scope}`,
    mine: `is:pr is:open author:${login} ${scope}`,
    issues: `is:issue is:open assignee:${login} ${scope}`,
  }
}

export function graphqlArgs(login: string, now: number, repo?: string): string[] {
  const terms = searchTerms(login, now, repo)
  return ['gh', 'api', 'graphql', '-f', `query=${QUERY}`, '-f', `review=${terms.review}`, '-f', `mine=${terms.mine}`, '-f', `issues=${terms.issues}`]
}

type Node = Record<string, any>

const RANK: Record<MineState, number> = { changes: 0, failing: 1, ready: 2, waiting: 3, draft: 4 }

function stateOf(pr: Node): MineState {
  const checks = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state as string | undefined
  if (pr.isDraft) return 'draft'
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes'
  if (checks === 'FAILURE' || checks === 'ERROR') return 'failing'
  if (pr.reviewDecision === 'APPROVED' && (checks === undefined || checks === 'SUCCESS')) return 'ready'
  return 'waiting'
}

export function parseQueue(text: string, now: number): Queue {
  const data = (JSON.parse(text) as { data?: Record<string, { nodes?: Node[] }> }).data ?? {}
  const nodes = (key: string) => (data[key]?.nodes ?? []).filter(n => n && typeof n.url === 'string')
  const reviews: Review[] = nodes('review').map(n => ({
    url: n.url, repo: n.repository?.nameWithOwner ?? '', number: n.number, title: n.title,
    author: n.author?.login ?? 'someone', isDraft: Boolean(n.isDraft),
    additions: n.additions ?? 0, deletions: n.deletions ?? 0, files: n.changedFiles ?? 0, updatedAt: n.updatedAt,
  }))
  const mine: Mine[] = nodes('mine')
    .map(n => ({
      url: n.url, repo: n.repository?.nameWithOwner ?? '', number: n.number, title: n.title,
      state: stateOf(n), talk: (n.comments?.totalCount ?? 0) + (n.reviews?.totalCount ?? 0), updatedAt: n.updatedAt,
    }))
    .sort((a, b) => RANK[a.state] - RANK[b.state])
  const issues: Assigned[] = nodes('issues').map(n => ({ url: n.url, repo: n.repository?.nameWithOwner ?? '', number: n.number, title: n.title, updatedAt: n.updatedAt }))
  return { reviews, mine, issues, fetchedAt: now }
}

export const STATE_TEXT: Record<MineState, string> = {
  changes: 'changes requested',
  failing: 'checks failing',
  ready: 'approved, ready to merge',
  waiting: 'waiting on reviewers',
  draft: 'draft',
}

// Comments and reviews since the owner last opened it. A pull request seen for the first
// time sets the baseline instead of counting everything as new.
export function newTalk(pr: Mine, seen: Record<string, number>): number {
  const was = seen[pr.url]
  return was === undefined ? 0 : Math.max(0, pr.talk - was)
}

export function needsYou(pr: Mine, seen: Record<string, number>): boolean {
  return pr.state === 'changes' || pr.state === 'failing' || pr.state === 'ready' || newTalk(pr, seen) > 0
}

export function hintOf(queue: Queue, seen: Record<string, number>): string | undefined {
  const parts: string[] = []
  if (queue.reviews.length) parts.push(`${queue.reviews.length} to review`)
  const mine = queue.mine.filter(pr => needsYou(pr, seen)).length
  if (mine) parts.push(`${mine} of your PRs need${mine === 1 ? 's' : ''} you`)
  if (queue.issues.length) parts.push(`${queue.issues.length} assigned`)
  return parts.length ? `👀 While you wait: ${parts.join(' · ')} · /wait` : undefined
}

export function agoText(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`
  return `${Math.round(minutes / 1440)}d ago`
}

// ---- diffs -------------------------------------------------------------

const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g

function counted(lines: readonly string[]): { old: number; fresh: number } {
  let old = 0
  let fresh = 0
  for (const line of lines) {
    if (line.startsWith('+')) fresh += 1
    else if (line.startsWith('-')) old += 1
    else if (line.startsWith(' ') || line === '') {
      old += 1
      fresh += 1
    }
  }
  return { old, fresh }
}

// A hunk cut short gets its header's line counts rewritten, or the drawing refuses it.
export function cutHunk(hunk: string, room: number): string | undefined {
  const [header, ...body] = hunk.split('\n')
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(header ?? '')
  if (!match) return undefined
  const kept: string[] = []
  let size = header!.length + 1
  for (const line of body) {
    if (size + line.length + 1 > room) break
    kept.push(line)
    size += line.length + 1
  }
  if (kept.length === 0) return undefined
  const { old, fresh } = counted(kept)
  return [`@@ -${match[1]},${old} +${match[2]},${fresh} @@${match[3]}`, ...kept].join('\n')
}

function hunksOf(lines: readonly string[]): string[] {
  const hunks: string[] = []
  let current: string[] = []
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (current.length) hunks.push(current.join('\n'))
      current = [line]
    } else if (current.length && !line.startsWith('\\')) {
      current.push(line)
    }
  }
  if (current.length) hunks.push(current.join('\n'))
  return hunks.map(h => h.replace(/\n+$/, ''))
}

export function splitDiff(text: string): { files: DiffFile[]; more: number } {
  const chunks = text.replace(/\r/g, '').replace(CONTROL, '').split(/^diff --git /m).slice(1)
  const files = chunks.map(chunk => {
    const [first, ...lines] = chunk.split('\n')
    const path = / b\/(.+)$/.exec(first ?? '')?.[1] ?? first ?? 'file'
    const hunks = hunksOf(lines)
    const body = hunks.flatMap(h => h.split('\n').slice(1))
    const added = body.filter(l => l.startsWith('+')).length
    const removed = body.filter(l => l.startsWith('-')).length
    const kept: string[] = []
    let size = 0
    let isCut = false
    for (const hunk of hunks) {
      if (size + hunk.length + 1 <= MAX_FILE_CHARS) {
        kept.push(hunk)
        size += hunk.length + 1
        continue
      }
      isCut = true
      const piece = cutHunk(hunk, MAX_FILE_CHARS - size)
      if (piece) kept.push(piece)
      break
    }
    return { path, added, removed, hunks: kept.join('\n'), isCut }
  })
  return { files: files.slice(0, MAX_FILES), more: Math.max(0, files.length - MAX_FILES) }
}

export const PRE_REVIEW = `You help an engineer review a pull request in a couple of minutes.
From the title and diff, write:
- one line saying what the change does;
- then up to five lines, each starting "• ", naming a file and something worth a closer look: a likely bug, a risky edit, a missing test, a security or data concern.
If nothing stands out, say so in one line. Plain text, no preamble, no headings.`

export function preReviewPrompt(title: string, diff: string): string {
  const cut = diff.length > 40_000 ? `${diff.slice(0, 40_000)}\n[diff cut at 40,000 characters]` : diff
  return `Title: ${title}\n\n${cut}`
}
