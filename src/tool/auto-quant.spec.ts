import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAutoQuantTools, type CommandResult } from './auto-quant.js'

const exec = (t: any, args: unknown) => (t.execute as Function)(args)

function commandResult(command: readonly string[], overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    command,
    cwd: null,
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 1,
    stdoutTail: '',
    stderrTail: '',
    ...overrides,
  }
}

async function createCheckout(root: string) {
  await mkdir(join(root, '.git'), { recursive: true })
  await mkdir(join(root, 'user_data', 'strategies'), { recursive: true })
  await mkdir(join(root, 'user_data', 'backtest_results'), { recursive: true })
  await writeFile(join(root, 'config.json'), '{}\n')
  await writeFile(join(root, 'prepare.py'), 'print("prepare")\n')
  await writeFile(join(root, 'run.py'), 'print("run")\n')
}

describe('createAutoQuantTools', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'openalice-auto-quant-'))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('reports a missing checkout without running commands', async () => {
    const runCommand = vi.fn()
    const tools = createAutoQuantTools({ repoDir: join(tmp, 'auto-quant'), runCommand })

    const result = await exec(tools.autoQuantRunBacktest, {})

    expect(result).toMatchObject({ ok: false, error: 'checkout_missing' })
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('clone action uses the fixed Auto-Quant remote and fixed repo path', async () => {
    const repoDir = join(tmp, 'auto-quant')
    const runCommand = vi.fn(async (command: string, args: readonly string[], opts: any) =>
      commandResult([command, ...args], { cwd: opts.cwd ?? null }),
    )
    const tools = createAutoQuantTools({ repoDir, runCommand })

    const result = await exec(tools.autoQuantSync, { action: 'clone' })

    expect(result.action).toBe('clone')
    expect(runCommand).toHaveBeenCalledWith(
      'git',
      ['clone', '--depth', '1', 'https://github.com/TraderAlice/Auto-Quant.git', repoDir],
      { timeoutMs: 600000 },
    )
  })

  it('runs only the prepare and backtest allowlist commands', async () => {
    const repoDir = join(tmp, 'auto-quant')
    await createCheckout(repoDir)
    await writeFile(join(repoDir, 'user_data', 'strategies', 'Momentum.py'), '# strategy\n')
    await writeFile(
      join(repoDir, 'results.tsv'),
      'commit\tevent\tstrategy_name\tsharpe\tmax_dd\tnote\nabc123\tstable\tMomentum\t1.2\t-0.1\tkept\n',
    )

    const runCommand = vi.fn(async (command: string, args: readonly string[], opts: any) =>
      commandResult([command, ...args], {
        cwd: opts.cwd ?? null,
        stdoutTail: command === 'uv' && args[1] === 'run.py' ? 'strategy summary\n' : '',
      }),
    )
    const tools = createAutoQuantTools({ repoDir, runCommand })

    const result = await exec(tools.autoQuantRunBacktest, { prepare: true, timeoutMs: 1000 })

    expect(runCommand).toHaveBeenCalledWith('uv', ['run', 'prepare.py'], {
      cwd: repoDir,
      timeoutMs: 1200000,
    })
    expect(runCommand).toHaveBeenCalledWith('uv', ['run', 'run.py'], {
      cwd: repoDir,
      timeoutMs: 1000,
    })
    expect(result.ok).toBe(true)
    expect(result.strategies).toMatchObject([{ name: 'Momentum.py' }])
    expect(result.results.rows).toEqual([
      { commit: 'abc123', event: 'stable', strategy_name: 'Momentum', sharpe: '1.2', max_dd: '-0.1', note: 'kept' },
    ])
  })

  it('read results parses results.tsv without running Auto-Quant', async () => {
    const repoDir = join(tmp, 'auto-quant')
    await createCheckout(repoDir)
    await writeFile(join(repoDir, 'results.tsv'), [
      'commit\tevent\tstrategy_name\tsharpe\tmax_dd\tnote',
      'a\tcreate\tA\t0.1\t-0.2\tfirst',
      'b\tevolve\tB\t0.3\t-0.1\tsecond',
    ].join('\n'))
    const runCommand = vi.fn(async (command: string, args: readonly string[]) => {
      if (args.includes('remote')) return commandResult([command, ...args], { stdoutTail: 'https://github.com/TraderAlice/Auto-Quant.git\n' })
      if (args.includes('--abbrev-ref')) return commandResult([command, ...args], { stdoutTail: 'master\n' })
      if (args.includes('--short')) return commandResult([command, ...args], { stdoutTail: 'abc123\n' })
      return commandResult([command, ...args])
    })
    const tools = createAutoQuantTools({ repoDir, runCommand })

    const result = await exec(tools.autoQuantReadResults, { limit: 1 })

    expect(result.checkout).toMatchObject({ installed: true, branch: 'master', commit: 'abc123' })
    expect(result.results.rows).toEqual([
      { commit: 'b', event: 'evolve', strategy_name: 'B', sharpe: '0.3', max_dd: '-0.1', note: 'second' },
    ])
    expect(runCommand).toHaveBeenCalledWith('git', ['-C', repoDir, 'status', '--short'], { timeoutMs: 30000 })
  })
})
