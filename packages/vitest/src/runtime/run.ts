import type { File, HookListener, ResolvedConfig, Suite, SuiteHooks, Task, TaskResult, TaskState, Test } from '../types'
import { vi } from '../integrations/vi'
import { getSnapshotClient } from '../integrations/snapshot/chai'
import { clearTimeout, getFullName, getWorkerState, hasFailed, hasTests, partitionSuiteChildren, setTimeout } from '../utils'
import { getState, setState } from '../integrations/chai/jest-expect'
import { takeCoverage } from '../integrations/coverage'
import { getFn, getHooks } from './map'
import { rpc } from './rpc'
import { collectTests } from './collect'
import { processError } from './error'

const now = Date.now

function updateSuiteHookState(suite: Task, name: keyof SuiteHooks, state: TaskState) {
  if (!suite.result)
    suite.result = { state: 'run' }
  if (!suite.result?.hooks)
    suite.result.hooks = {}
  const suiteHooks = suite.result.hooks
  if (suiteHooks) {
    suiteHooks[name] = state
    updateTask(suite)
  }
}

export async function callSuiteHook<T extends keyof SuiteHooks>(suite: Suite, currentTask: Task, name: T, args: SuiteHooks[T][0] extends HookListener<infer A> ? A : never) {
  if (name === 'beforeEach' && suite.suite)
    await callSuiteHook(suite.suite, currentTask, name, args)

  updateSuiteHookState(currentTask, name, 'run')
  await Promise.all(getHooks(suite)[name].map(fn => fn(...(args as any))))
  updateSuiteHookState(currentTask, name, 'pass')

  if (name === 'afterEach' && suite.suite)
    await callSuiteHook(suite.suite, currentTask, name, args)
}

const packs = new Map<string, TaskResult|undefined>()
let updateTimer: any
let previousUpdate: Promise<void>|undefined

function updateTask(task: Task) {
  packs.set(task.id, task.result)

  clearTimeout(updateTimer)
  updateTimer = setTimeout(() => {
    previousUpdate = sendTasksUpdate()
  }, 10)
}

async function sendTasksUpdate() {
  clearTimeout(updateTimer)
  await previousUpdate

  if (packs.size) {
    const p = rpc().onTaskUpdate(Array.from(packs))
    packs.clear()
    return p
  }
}

export async function runTest(test: Test) {
  if (test.mode !== 'run')
    return

  if (test.result?.state === 'fail') {
    updateTask(test)
    return
  }

  const start = now()

  test.result = {
    state: 'run',
    startTime: start,
  }
  updateTask(test)

  clearModuleMocks()

  await getSnapshotClient().setTest(test)

  const workerState = getWorkerState()

  workerState.current = test

  try {
    await callSuiteHook(test.suite, test, 'beforeEach', [test, test.suite])
    setState({
      assertionCalls: 0,
      isExpectingAssertions: false,
      isExpectingAssertionsError: null,
      expectedAssertionsNumber: null,
      expectedAssertionsNumberErrorGen: null,
      testPath: test.suite.file?.filepath,
      currentTestName: getFullName(test),
    })
    await getFn(test)()
    const { assertionCalls, expectedAssertionsNumber, expectedAssertionsNumberErrorGen, isExpectingAssertions, isExpectingAssertionsError } = getState()
    if (expectedAssertionsNumber !== null && assertionCalls !== expectedAssertionsNumber)
      throw expectedAssertionsNumberErrorGen!()
    if (isExpectingAssertions === true && assertionCalls === 0)
      throw isExpectingAssertionsError

    test.result.state = 'pass'
  }
  catch (e) {
    test.result.state = 'fail'
    test.result.error = processError(e)
  }

  try {
    await callSuiteHook(test.suite, test, 'afterEach', [test, test.suite])
  }
  catch (e) {
    test.result.state = 'fail'
    test.result.error = processError(e)
  }

  // if test is marked to be failed, flip the result
  if (test.fails) {
    if (test.result.state === 'pass') {
      test.result.state = 'fail'
      test.result.error = processError(new Error('Expect test to fail'))
    }
    else {
      test.result.state = 'pass'
      test.result.error = undefined
    }
  }

  getSnapshotClient().clearTest()

  test.result.duration = now() - start

  workerState.current = undefined

  updateTask(test)
}

function markTasksAsSkipped(suite: Suite) {
  suite.tasks.forEach((t) => {
    t.mode = 'skip'
    t.result = { ...t.result, state: 'skip' }
    updateTask(t)
    if (t.type === 'suite')
      markTasksAsSkipped(t)
  })
}

export async function runSuite(suite: Suite) {
  if (suite.result?.state === 'fail') {
    markTasksAsSkipped(suite)
    updateTask(suite)
    return
  }

  const start = now()

  suite.result = {
    state: 'run',
    startTime: start,
  }

  updateTask(suite)

  if (suite.mode === 'skip') {
    suite.result.state = 'skip'
  }
  else if (suite.mode === 'todo') {
    suite.result.state = 'todo'
  }
  else {
    try {
      await callSuiteHook(suite, suite, 'beforeAll', [suite])

      for (const tasksGroup of partitionSuiteChildren(suite)) {
        if (tasksGroup[0].concurrent === true) {
          await Promise.all(tasksGroup.map(c => runSuiteChild(c)))
        }
        else {
          for (const c of tasksGroup)
            await runSuiteChild(c)
        }
      }
      await callSuiteHook(suite, suite, 'afterAll', [suite])
    }
    catch (e) {
      suite.result.state = 'fail'
      suite.result.error = processError(e)
    }
  }
  suite.result.duration = now() - start

  if (suite.mode === 'run') {
    if (!hasTests(suite)) {
      suite.result.state = 'fail'
      if (!suite.result.error)
        suite.result.error = new Error(`No test found in suite ${suite.name}`)
    }
    else if (hasFailed(suite)) {
      suite.result.state = 'fail'
    }
    else {
      suite.result.state = 'pass'
    }
  }

  updateTask(suite)
}

async function runSuiteChild(c: Task) {
  return c.type === 'test'
    ? runTest(c)
    : runSuite(c)
}

export async function runFiles(files: File[], config: ResolvedConfig) {
  for (const file of files) {
    if (!file.tasks.length && !config.passWithNoTests) {
      if (!file.result?.error) {
        file.result = {
          state: 'fail',
          error: new Error(`No test suite found in file ${file.filepath}`),
        }
      }
    }

    await runSuite(file)
  }
}

export async function startTests(paths: string[], config: ResolvedConfig) {
  const files = await collectTests(paths, config)

  rpc().onCollected(files)

  await runFiles(files, config)

  takeCoverage()

  await getSnapshotClient().saveSnap()

  await sendTasksUpdate()
}

export function clearModuleMocks() {
  const { clearMocks, mockReset, restoreMocks } = getWorkerState().config

  // since each function calls another, we can just call one
  if (restoreMocks)
    vi.restoreAllMocks()
  else if (mockReset)
    vi.resetAllMocks()
  else if (clearMocks)
    vi.clearAllMocks()
}
