import { describe, expect, test } from 'claude-code/testing'

import { agoText, cutHunk, graphqlArgs, hintOf, needsYou, newTalk, parseQueue, searchTerms, splitDiff } from '../hooks/github'
import { DIFF, QUEUE_JSON } from './fixtures'

const NOW = Date.parse('2026-10-03T12:00:00Z')

describe('the queue', () => {
  test('search terms name the person, skip old and archived work, and can keep to one repo', () => {
    const terms = searchTerms('dana', NOW, 'acme/api')
    expect(terms.review).toContain('review-requested:dana')
    expect(terms.mine).toContain('author:dana')
    expect(terms.issues).toContain('assignee:dana')
    expect(terms.review).toContain('updated:>=2026-07-05')
    expect(terms.review).toContain('repo:acme/api')
    expect(searchTerms('dana', NOW).review).not.toContain('repo:')
    expect(graphqlArgs('dana', NOW).slice(0, 3)).toEqual(['gh', 'api', 'graphql'])
  })

  test('reads reviews, your pull requests most urgent first, and issues', () => {
    const queue = parseQueue(QUEUE_JSON, NOW)
    expect(queue.reviews.map(r => [r.repo, r.number, r.author, r.files])).toEqual([['acme/api', 41, 'dana', 4]])
    expect(queue.mine.map(p => [p.number, p.state])).toEqual([[7, 'failing'], [3, 'draft']])
    expect(queue.issues.map(i => i.number)).toEqual([12])
  })

  test('new comments count from the first time a pull request was seen', () => {
    const [failing, draft] = parseQueue(QUEUE_JSON, NOW).mine
    expect(newTalk(failing!, {})).toBe(0)
    expect(newTalk(failing!, { [failing!.url]: 1 })).toBe(1)
    expect(needsYou(failing!, {})).toBe(true)
    expect(needsYou(draft!, {})).toBe(false)
    expect(needsYou(draft!, { [draft!.url]: 0 })).toBe(true)
  })

  test('the hint counts what you could do', () => {
    const queue = parseQueue(QUEUE_JSON, NOW)
    expect(hintOf(queue, {})).toBe('👀 While you wait: 1 to review · 1 of your PRs needs you · 1 assigned · /wait')
    expect(hintOf({ reviews: [], mine: [], issues: [], fetchedAt: NOW }, {})).toBeUndefined()
    expect(agoText('2026-10-03T09:00:00Z', NOW)).toBe('3h ago')
  })
})

describe('diffs', () => {
  test('one block of hunks per file; a binary file has none', () => {
    const { files, more } = splitDiff(DIFF)
    expect(more).toBe(0)
    expect(files.map(f => [f.path, f.added, f.removed])).toEqual([['src/upload.ts', 3, 1], ['assets/logo.png', 0, 0]])
    expect(files[0]!.hunks.startsWith('@@ -10,3 +10,5 @@')).toBe(true)
    expect(files[0]!.hunks).not.toContain('index 1111111')
    expect(files[1]!.hunks).toBe('')
  })

  test('a hunk cut short gets its line counts rewritten', () => {
    const hunk = ['@@ -1,4 +1,4 @@ top', ' a', '-b', '+c', ' d'].join('\n')
    expect(cutHunk(hunk, 30)).toBe(['@@ -1,2 +1,2 @@ top', ' a', '-b', '+c'].join('\n'))
  })

  test('a very long file is cut to fit', () => {
    const long = `diff --git a/x.txt b/x.txt\n@@ -0,0 +1,3000 @@\n${Array.from({ length: 3000 }, (_, i) => `+line ${i}`).join('\n')}\n`
    const [file] = splitDiff(long).files
    expect(file!.isCut).toBe(true)
    expect(file!.hunks.length).toBeLessThanOrEqual(9000)
    expect(file!.hunks.startsWith('@@ -0,0 +1,')).toBe(true)
  })
})
