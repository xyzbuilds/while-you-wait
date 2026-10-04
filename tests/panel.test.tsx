import { expect, mock, test } from 'claude-code/testing'

import { DIFF, QUEUE_JSON } from './fixtures'

const PANE = { plugin: 'while-you-wait', surface: 'terminal', component: 'Pane', requestId: 'while-you-wait', props: { title: 'While you wait', isFocused: false, bodyColumns: 70, placement: 'dock' } }

test('after two minutes of work the status line points to the queue; the panel shows it, a diff and a pre-review', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-03T12:00:00Z') })
  const status: (string | undefined)[] = []
  const ran: string[][] = []
  const opened: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('session.root', () => ({ value: '/r' }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('command.register', ($, e) => ({ value: { command: (e as { name: string }).name } }) as never)
  on('ui.open', ($, e) => {
    opened.push((e as { id: string }).id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.status', ($, e) => {
    status.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    const [, a, b] = e.argv
    const stdout = a === 'api' && b === 'user' ? 'dana\n' : a === 'api' && b === 'graphql' ? QUEUE_JSON : a === 'pr' && b === 'diff' ? DIFF : ''
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  on('model.complete', () => ({ value: { isAnswered: true, text: 'Adds three retries to upload.\n• src/upload.ts: the empty catch hides every error.', usage: {} } }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'refactor the parser', turnId: 't1' } as never)
  await clock.advance(60_000)
  expect(status.filter(Boolean)).toEqual([])
  await clock.advance(61_000)
  expect(status.at(-1)).toBe('👀 While you wait: 1 to review · 1 of your PRs needs you · 1 assigned · /wait')
  expect(opened).toEqual([])

  const pane = await $.ui.mount(PANE as never)
  expect(await pane.find({ type: 'Text', text: 'REVIEW REQUESTED' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Add retry to the upload client' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /acme\/web#7 · checks failing/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'ASSIGNED ISSUES' })).toBeDefined()

  await pane.press({ key: 'r-https://github.com/acme/api/pull/41-Diff' })
  expect(await pane.find({ type: 'Text', text: 'src/upload.ts' })).toBeDefined()
  expect(await pane.find({ type: 'Code' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /binary or renamed/ })).toBeDefined()

  await pane.press({ key: 'pre-review' })
  expect(await pane.find({ type: 'Text', text: /empty catch/ })).toBeDefined()
  expect(ran.filter(argv => argv[1] === 'pr' && argv[2] === 'diff').length).toBe(1)

  await pane.press({ key: 'detail-open' })
  expect(ran.at(-1)).toEqual(['open', 'https://github.com/acme/api/pull/41'])
  await pane.press({ key: 'back' })
  expect(await pane.find({ type: 'Text', text: 'REVIEW REQUESTED' })).toBeDefined()
  await pane.unmount()

  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  expect(status.at(-1)).toBeUndefined()
})

test('without the GitHub CLI signed in, the panel says how to fix it and the status line stays quiet', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const status: (string | undefined)[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('session.root', () => ({ value: '/r' }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('command.register', ($, e) => ({ value: { command: (e as { name: string }).name } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', ($, e) => {
    status.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'not logged in' } }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await clock.advance(3 * 60_000)
  expect(status.filter(Boolean)).toEqual([])
  const pane = await $.ui.mount(PANE as never)
  expect(await pane.find({ type: 'Text', text: /gh auth login/ })).toBeDefined()
  await pane.unmount()
})

test('headless runs stay inert', async ($, on) => {
  const ran: unknown[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('process.run', ($, e) => {
    ran.push(e)
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: false } as never)
  expect(ran).toEqual([])
})
