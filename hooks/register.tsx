import { atom, read } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Detail, Queue } from '../types'
import { agoText, graphqlArgs, hintOf, newTalk, parseQueue, PRE_REVIEW, preReviewPrompt, splitDiff, STATE_TEXT } from './github'

const EMPTY: Queue = { reviews: [], mine: [], issues: [], fetchedAt: 0 }
const queueAtom = atom({ plugin: 'while-you-wait', key: 'queue' } as const, EMPTY)
const detailAtom = atom({ plugin: 'while-you-wait', key: 'detail' } as const, null)
const seenAtom = atom({ plugin: 'while-you-wait', key: 'seen' } as const, {})

const PANE = 'while-you-wait'
const REFRESH_MS = 10 * 60_000
const STALE_MS = 5 * 60_000

let isActive = false
let login = ''
let repo: string | undefined
let isWorking = false
let isHinting = false
let hintTimer: { cancel: () => void } | undefined
let ticker: { cancel: () => void } | undefined
let lastDiff = { url: '', text: '' }
let config = { nudgeMs: 2 * 60_000, openPanel: false, onlyThisRepo: false }

type Chosen = { url: string; title: string; meta: string }

// ---- GitHub ------------------------------------------------------------

async function gh($: EngineInterface, args: string[], timeoutMs = 30_000) {
  return $.process.run(['gh', ...args], { timeoutMs, cwd: await $.session.root() }).catch(() => undefined)
}

async function setQueue($: EngineInterface, queue: Queue): Promise<void> {
  await $.state.set({ plugin: 'while-you-wait', key: 'queue' }, queue)
}

async function getSeen($: EngineInterface): Promise<Record<string, number>> {
  return (await $.state.get({ plugin: 'while-you-wait', key: 'seen' })).value ?? {}
}

async function setSeen($: EngineInterface, seen: Record<string, number>): Promise<void> {
  await $.state.set({ plugin: 'while-you-wait', key: 'seen' }, seen)
  await $.store.set('seen', seen)
}

async function refresh($: EngineInterface): Promise<void> {
  if (!isActive) return
  const now = await $.clock.now()
  if (!login) {
    const who = await gh($, ['api', 'user', '--jq', '.login'], 15_000)
    if (!who) return setQueue($, { ...EMPTY, fetchedAt: now, problem: 'Needs the GitHub CLI: install gh, then run gh auth login.' })
    if (who.exitCode !== 0) return setQueue($, { ...EMPTY, fetchedAt: now, problem: 'Sign in to GitHub first: gh auth login' })
    login = who.stdout.trim()
  }
  if (config.onlyThisRepo && repo === undefined) {
    const here = await gh($, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], 15_000)
    repo = here?.exitCode === 0 ? here.stdout.trim() : ''
  }
  const found = await $.process.run(graphqlArgs(login, now, repo || undefined), { timeoutMs: 30_000 }).catch(() => undefined)
  if (!found || found.exitCode !== 0) {
    const held = (await $.state.get({ plugin: 'while-you-wait', key: 'queue' })).value ?? EMPTY
    return setQueue($, { ...held, problem: `GitHub didn't answer: ${(found?.stderr ?? 'no reply').trim().split('\n')[0]}` })
  }
  const queue = parseQueue(found.stdout, now)
  const seen = await getSeen($)
  const fresh = queue.mine.filter(pr => seen[pr.url] === undefined)
  if (fresh.length) await setSeen($, { ...seen, ...Object.fromEntries(fresh.map(pr => [pr.url, pr.talk])) })
  await setQueue($, queue)
  if (isHinting) await showHint($)
}

async function refreshIfStale($: EngineInterface): Promise<void> {
  const queue = (await $.state.get({ plugin: 'while-you-wait', key: 'queue' })).value ?? EMPTY
  if ((await $.clock.now()) - queue.fetchedAt > STALE_MS) await refresh($)
}

// ---- the hint ----------------------------------------------------------

async function showHint($: EngineInterface): Promise<void> {
  const queue = (await $.state.get({ plugin: 'while-you-wait', key: 'queue' })).value ?? EMPTY
  const hint = hintOf(queue, await getSeen($))
  $.ui.status(hint)
  if (hint && config.openPanel) await openPane($)
}

async function whileWorking($: EngineInterface): Promise<void> {
  if (!isWorking) return
  isHinting = true
  await refreshIfStale($)
  if (isHinting) await showHint($)
}

// ---- actions -----------------------------------------------------------

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'While you wait' })
}

async function openUrl($: EngineInterface, url: string): Promise<void> {
  const queue = (await $.state.get({ plugin: 'while-you-wait', key: 'queue' })).value ?? EMPTY
  const pr = queue.mine.find(p => p.url === url)
  if (pr) await setSeen($, { ...(await getSeen($)), [url]: pr.talk })
  // macOS, then Linux, then Windows
  for (const argv of [['open', url], ['xdg-open', url], ['cmd', '/c', 'start', '', url]]) {
    const opened = await $.process.run(argv).catch(() => undefined)
    if (opened?.exitCode === 0) break
  }
  if (isHinting) await showHint($)
}

async function setDetail($: EngineInterface, detail: Detail | null): Promise<void> {
  await $.state.set({ plugin: 'while-you-wait', key: 'detail' }, detail)
}

async function diffText($: EngineInterface, url: string): Promise<string | undefined> {
  if (lastDiff.url === url) return lastDiff.text
  const ran = await gh($, ['pr', 'diff', url], 60_000)
  if (!ran || ran.exitCode !== 0) return undefined
  lastDiff = { url, text: ran.stdout }
  return ran.stdout
}

async function showDiff($: EngineInterface, pick: Chosen): Promise<void> {
  await setDetail($, { ...pick, files: [], more: 0, busy: 'diff' })
  const text = await diffText($, pick.url)
  if (text === undefined) return setDetail($, { ...pick, files: [], more: 0, problem: "Couldn't load the diff. Open it on GitHub instead." })
  await setDetail($, { ...pick, ...splitDiff(text) })
}

async function preReview($: EngineInterface): Promise<void> {
  const detail = (await $.state.get({ plugin: 'while-you-wait', key: 'detail' })).value
  if (!detail) return
  await setDetail($, { ...detail, busy: 'summary' })
  const text = await diffText($, detail.url)
  const result = text === undefined ? undefined : await $.model.complete({ model: 'haiku', system: PRE_REVIEW, prompt: preReviewPrompt(detail.title, text), maxTokens: 700, timeoutMs: 60_000 }).catch(() => undefined)
  const summary = result?.isAnswered ? result.text.trim() : "The pre-review didn't come back. Try again in a minute."
  const now = (await $.state.get({ plugin: 'while-you-wait', key: 'detail' })).value
  if (now?.url === detail.url) await setDetail($, { ...now, busy: undefined, summary })
}

// ---- drawing -----------------------------------------------------------

type View = Parameters<EngineInterface['ui']['resolve']>[0]

function cardView($: EngineInterface, e: View, key: string, title: string, meta: string, url: string, extra: { label: string; run: () => Promise<void> }[]) {
  const { Box, Text, Button, Link } = $.ui.resolve(e)
  const isPhone = e.surface === 'mobile'
  return (
    <Box key={key} flexDirection="column" marginBottom={1} paddingLeft={2}>
      <Text bold wrap="wrap">
        {title}
      </Text>
      <Box paddingLeft={2}>
        <Text dimColor wrap="wrap">
          {meta}
        </Text>
      </Box>
      <Box flexDirection="row" gap={1} paddingLeft={2} flexWrap="wrap">
        {extra.map(action => (
          <Button key={`${key}-${action.label}`} label={action.label} onPress={() => action.run()} />
        ))}
        {isPhone ? <Link href={url} label="Open on GitHub" /> : <Button key={`${key}-open`} label="Open" onPress={() => openUrl($, url)} />}
      </Box>
    </Box>
  )
}

function heading($: EngineInterface, e: View, title: string, count: number, color: string, isFirst: boolean, rule: string) {
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box key={`h-${title}`} flexDirection="column">
      {!isFirst && <Text dimColor>{rule}</Text>}
      <Box flexDirection="row" gap={1} marginBottom={1} marginTop={isFirst ? 0 : 1}>
        <Text bold color={color}>
          {title}
        </Text>
        <Text dimColor>{count}</Text>
      </Box>
    </Box>
  )
}

function detailView($: EngineInterface, e: View, detail: Detail, rule: string) {
  const { Box, Text, Button, Code, Link } = $.ui.resolve(e)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" gap={1}>
        <Button key="back" label="← Back" onPress={() => setDetail($, null)} />
        {e.surface === 'mobile' ? <Link href={detail.url} label="Open on GitHub" /> : <Button key="detail-open" label="Open" onPress={() => openUrl($, detail.url)} />}
        {!detail.summary && !detail.busy && !detail.problem && <Button key="pre-review" label="Pre-review" variant="primary" onPress={() => preReview($)} />}
      </Box>
      <Text dimColor>{rule}</Text>
      <Text bold wrap="wrap">
        {detail.title}
      </Text>
      <Text dimColor wrap="wrap">
        {detail.meta}
      </Text>
      {detail.busy === 'diff' && <Text dimColor>Loading the diff…</Text>}
      {detail.busy === 'summary' && <Text dimColor>Reading the diff for a pre-review…</Text>}
      {detail.problem && <Text color="red">{detail.problem}</Text>}
      {detail.summary && (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" gap={1}>
            <Text bold color="magenta">PRE-REVIEW</Text>
            <Text dimColor>Haiku, first pass</Text>
          </Box>
          <Text wrap="wrap">{detail.summary}</Text>
        </Box>
      )}
      {detail.files.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{rule}</Text>
          <Box flexDirection="row" gap={1} marginBottom={1}>
            <Text bold color="blue">FILES</Text>
            <Text dimColor>{detail.files.length + detail.more}</Text>
          </Box>
          {detail.files.map((file, i) => (
            <Box key={`f-${i}`} flexDirection="column" marginBottom={1}>
              <Box flexDirection="row" gap={1}>
                <Text bold wrap="truncate-middle">
                  {file.path}
                </Text>
                <Text color="green">+{file.added}</Text>
                <Text color="red">−{file.removed}</Text>
              </Box>
              {file.hunks ? <Code source={file.hunks} format="diff" path={file.path} /> : <Text dimColor>No text changes (binary or renamed).</Text>}
              {file.isCut && <Text dimColor>The rest of this file is on GitHub.</Text>}
            </Box>
          ))}
          {detail.more > 0 && <Text dimColor>{detail.more} more files on GitHub.</Text>}
        </Box>
      )}
    </Box>
  )
}

// ---- the mod -----------------------------------------------------------

export const register: Register = (on, options) => {
  config = {
    nudgeMs: (typeof options.nudgeAfterMinutes === 'number' && options.nudgeAfterMinutes >= 0 ? options.nudgeAfterMinutes : 2) * 60_000,
    openPanel: options.openPanel === true,
    onlyThisRepo: options.onlyThisRepo === true,
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    isActive = e.isInteractive
    if (!isActive) return started
    const seen = (await $.store.get('seen')) as Record<string, number> | undefined
    if (seen) await $.state.set({ plugin: 'while-you-wait', key: 'seen' }, seen)
    await $.command.register({ name: 'wait', description: 'While you wait: pull requests to review, yours that need you, issues assigned (/wait refresh)', argumentHint: '[refresh]', immediate: true })
    ticker?.cancel()
    ticker = $.clock.every(REFRESH_MS, () => void refresh($).catch(() => undefined))
    $.clock.after(3_000, () => void refresh($).catch(() => undefined))
    return started
  })

  on('turn.start', async ($, e, next) => {
    if (isActive) {
      isWorking = true
      hintTimer?.cancel()
      hintTimer = $.clock.after(config.nudgeMs, () => void whileWorking($).catch(() => undefined))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (isActive && e.agentId === undefined) {
      isWorking = false
      isHinting = false
      hintTimer?.cancel()
      $.ui.status(undefined)
    }
    return done
  })

  on('command.run', { command: 'wait' }, async ($, e) => {
    if (e.args.trim() === 'refresh' || (await $.clock.now()) - ((await $.state.get({ plugin: 'while-you-wait', key: 'queue' })).value?.fetchedAt ?? 0) > STALE_MS) await refresh($)
    await openPane($)
    return { text: 'While you wait opened in the side panel.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const queue = await read($, queueAtom)
    const detail = await read($, detailAtom)
    const seen = await read($, seenAtom)
    const now = await $.clock.now()
    const rule = '─'.repeat(Math.max(20, e.props.bodyColumns - 2))
    if (detail) return detailView($, e, detail, rule)

    const { Box, Text, Button } = $.ui.resolve(e)
    const hint = hintOf(queue, seen)
    const sections: ReturnType<typeof cardView>[] = []
    if (queue.reviews.length) {
      sections.push(heading($, e, 'REVIEW REQUESTED', queue.reviews.length, 'yellow', sections.length === 0, rule))
      for (const pr of queue.reviews) {
        const meta = `${pr.repo}#${pr.number} · by ${pr.author} · +${pr.additions} −${pr.deletions} in ${pr.files} files · ${agoText(pr.updatedAt, now)}${pr.isDraft ? ' · draft' : ''}`
        const pick = { url: pr.url, title: pr.title, meta }
        sections.push(cardView($, e, `r-${pr.url}`, pr.title, meta, pr.url, [{ label: 'Diff', run: () => showDiff($, pick) }]))
      }
    }
    if (queue.mine.length) {
      sections.push(heading($, e, 'YOUR PULL REQUESTS', queue.mine.length, 'magenta', sections.length === 0, rule))
      for (const pr of queue.mine) {
        const fresh = newTalk(pr, seen)
        const meta = `${pr.repo}#${pr.number} · ${STATE_TEXT[pr.state]}${fresh ? ` · ${fresh} new comment${fresh === 1 ? '' : 's'}` : ''} · ${agoText(pr.updatedAt, now)}`
        sections.push(cardView($, e, `m-${pr.url}`, pr.title, meta, pr.url, []))
      }
    }
    if (queue.issues.length) {
      sections.push(heading($, e, 'ASSIGNED ISSUES', queue.issues.length, 'blue', sections.length === 0, rule))
      for (const issue of queue.issues) {
        sections.push(cardView($, e, `i-${issue.url}`, issue.title, `${issue.repo}#${issue.number} · ${agoText(issue.updatedAt, now)}`, issue.url, []))
      }
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>👀 While you wait</Text>
          <Text dimColor>{queue.fetchedAt ? `updated ${agoText(new Date(queue.fetchedAt).toISOString(), now)}` : 'loading…'}</Text>
        </Box>
        <Text dimColor>{rule}</Text>
        {queue.problem && <Text color="red">{queue.problem}</Text>}
        {!hint && !queue.problem && queue.fetchedAt > 0 && (
          <Box flexDirection="column" alignItems="center" marginY={1}>
            <Text dimColor>Nothing waiting for you on GitHub.</Text>
          </Box>
        )}
        {sections}
        <Text dimColor>{rule}</Text>
        <Box flexDirection="row" gap={1}>
          <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
          <Text dimColor>{config.onlyThisRepo ? `this repository only${repo ? ` (${repo})` : ''}` : 'all your repositories'}</Text>
        </Box>
      </Box>
    )
  })
}
