import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tool, type Tool } from 'ai'
import { z } from 'zod'
import { dataPath } from '@/core/paths.js'

const DEFAULT_REMOTE_URL = 'https://github.com/TraderAlice/Auto-Quant.git'
const DEFAULT_REPO_DIR = dataPath('auto-quant')
const OUTPUT_TAIL_BYTES = 64 * 1024
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_PREPARE_TIMEOUT_MS = 20 * 60 * 1000
const MAX_TIMEOUT_MS = 30 * 60 * 1000

type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs: number },
) => Promise<CommandResult>

export interface CommandResult {
  command: readonly string[]
  cwd: string | null
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  durationMs: number
  stdoutTail: string
  stderrTail: string
}

export interface AutoQuantToolOptions {
  repoDir?: string
  remoteUrl?: string
  runCommand?: CommandRunner
}

export function createAutoQuantTools(options: AutoQuantToolOptions = {}): Record<string, Tool> {
  const repoDir = options.repoDir ?? DEFAULT_REPO_DIR
  const remoteUrl = options.remoteUrl ?? DEFAULT_REMOTE_URL
  const runCommand = options.runCommand ?? runLocalCommand

  return {
    autoQuantSync: tool({
      description: `Clone, update, or inspect the local Auto-Quant checkout used by OpenAlice.

This tool is intentionally fixed to OpenAlice's local data checkout and does not accept arbitrary paths.
Use action="clone" once, action="update" to fast-forward the checkout, and action="status" before running backtests.`,
      inputSchema: z.object({
        action: z.enum(['status', 'clone', 'update']).default('status')
          .describe('status = inspect checkout, clone = clone if missing, update = git pull --ff-only'),
      }),
      execute: async ({ action }) => {
        const effectiveAction = action ?? 'status'
        if (effectiveAction === 'status') return await buildCheckoutStatus(repoDir, runCommand)

        if (effectiveAction === 'clone') {
          const existing = await getCheckoutShape(repoDir)
          if (existing.isGitRepo) {
            return {
              ok: true,
              message: 'Auto-Quant checkout already exists; use action="update" to refresh it.',
              checkout: await buildCheckoutStatus(repoDir, runCommand),
            }
          }
          if (existing.exists) {
            return {
              ok: false,
              error: 'target_exists_not_git_repo',
              message: `Refusing to clone into an existing non-git path: ${repoDir}`,
              repoDir,
            }
          }
          await mkdir(join(repoDir, '..'), { recursive: true })
          const clone = await runCommand('git', ['clone', '--depth', '1', remoteUrl, repoDir], {
            timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
          })
          return {
            ok: clone.exitCode === 0 && !clone.timedOut,
            action: effectiveAction,
            repoDir,
            remoteUrl,
            command: clone,
            checkout: await buildCheckoutStatus(repoDir, runCommand),
          }
        }

        const shape = await getCheckoutShape(repoDir)
        if (!shape.isGitRepo) {
          return {
            ok: false,
            error: 'checkout_missing',
            message: `Auto-Quant is not cloned at ${repoDir}. Run autoQuantSync with action="clone" first.`,
            repoDir,
          }
        }

        const remote = await runCommand('git', ['-C', repoDir, 'remote', 'get-url', 'origin'], {
          timeoutMs: 30_000,
        })
        const origin = remote.stdoutTail.trim()
        if (remote.exitCode !== 0 || !isAutoQuantRemote(origin, remoteUrl)) {
          return {
            ok: false,
            error: 'unexpected_remote',
            message: `Refusing to update checkout with unexpected origin: ${origin || '(unreadable)'}`,
            repoDir,
            remote,
          }
        }

        const pull = await runCommand('git', ['-C', repoDir, 'pull', '--ff-only'], {
          timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        })
        return {
          ok: pull.exitCode === 0 && !pull.timedOut,
          action: effectiveAction,
          repoDir,
          command: pull,
          checkout: await buildCheckoutStatus(repoDir, runCommand),
        }
      },
    }),

    autoQuantRunBacktest: tool({
      description: `Run the fixed Auto-Quant backtest harness from OpenAlice's local checkout.

This runs only allowlisted commands: optionally \`uv run prepare.py\`, then \`uv run run.py\`.
It does not edit strategies, commit changes, or execute arbitrary shell. Use autoQuantSync first if the checkout is missing.`,
      inputSchema: z.object({
        prepare: z.boolean().default(false)
          .describe('Run uv run prepare.py before the backtest. This downloads/refreshes OHLCV and can take several minutes.'),
        timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional()
          .describe('Timeout for the backtest command. Default: 10 minutes; max: 30 minutes.'),
      }),
      execute: async ({ prepare, timeoutMs }) => {
        const shouldPrepare = prepare ?? false
        const validation = await validateAutoQuantCheckout(repoDir)
        if (!validation.ok) return validation

        const prepareResult = shouldPrepare
          ? await runCommand('uv', ['run', 'prepare.py'], {
            cwd: repoDir,
            timeoutMs: DEFAULT_PREPARE_TIMEOUT_MS,
          })
          : null

        if (prepareResult && (prepareResult.exitCode !== 0 || prepareResult.timedOut)) {
          return {
            ok: false,
            error: 'prepare_failed',
            repoDir,
            prepare: prepareResult,
            checkout: await buildCheckoutStatus(repoDir, runCommand),
          }
        }

        const backtest = await runCommand('uv', ['run', 'run.py'], {
          cwd: repoDir,
          timeoutMs: timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        })
        const summary = await readAutoQuantSummary(repoDir)

        return {
          ok: backtest.exitCode === 0 && !backtest.timedOut,
          repoDir,
          prepare: prepareResult,
          backtest,
          ...summary,
          message: backtest.exitCode === 2
            ? 'Backtest harness exited 2. Auto-Quant uses this for some non-success states, including an empty strategy directory.'
            : undefined,
        }
      },
    }),

    autoQuantReadResults: tool({
      description: `Read Auto-Quant's local results without running commands.

Returns checkout status, strategy files, recent results.tsv rows, and recent FreqTrade backtest artifacts.`,
      inputSchema: z.object({
        limit: z.number().int().positive().max(100).default(20)
          .describe('Max results.tsv rows and artifact entries to return.'),
      }),
      execute: async ({ limit }) => {
        const checkout = await buildCheckoutStatus(repoDir, runCommand)
        const summary = await readAutoQuantSummary(repoDir, limit ?? 20)
        return { repoDir, checkout, ...summary }
      },
    }),
  }
}

async function validateAutoQuantCheckout(repoDir: string): Promise<{ ok: true } | Record<string, unknown>> {
  const shape = await getCheckoutShape(repoDir)
  if (!shape.isGitRepo) {
    return {
      ok: false,
      error: 'checkout_missing',
      message: `Auto-Quant is not cloned at ${repoDir}. Run autoQuantSync with action="clone" first.`,
      repoDir,
    }
  }

  const required = ['config.json', 'prepare.py', 'run.py']
  const missing: string[] = []
  for (const file of required) {
    if (!await exists(join(repoDir, file))) missing.push(file)
  }
  if (missing.length > 0) {
    return {
      ok: false,
      error: 'invalid_checkout',
      message: `Auto-Quant checkout is missing required harness files: ${missing.join(', ')}`,
      repoDir,
      missing,
    }
  }
  return { ok: true }
}

async function buildCheckoutStatus(repoDir: string, runCommand: CommandRunner) {
  const shape = await getCheckoutShape(repoDir)
  if (!shape.isGitRepo) {
    return {
      installed: false,
      repoDir,
      exists: shape.exists,
      isGitRepo: false,
    }
  }

  const [origin, branch, commit, status] = await Promise.all([
    runCommand('git', ['-C', repoDir, 'remote', 'get-url', 'origin'], { timeoutMs: 30_000 }),
    runCommand('git', ['-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 30_000 }),
    runCommand('git', ['-C', repoDir, 'rev-parse', '--short', 'HEAD'], { timeoutMs: 30_000 }),
    runCommand('git', ['-C', repoDir, 'status', '--short'], { timeoutMs: 30_000 }),
  ])

  return {
    installed: true,
    repoDir,
    exists: true,
    isGitRepo: true,
    origin: origin.exitCode === 0 ? origin.stdoutTail.trim() : null,
    branch: branch.exitCode === 0 ? branch.stdoutTail.trim() : null,
    commit: commit.exitCode === 0 ? commit.stdoutTail.trim() : null,
    dirty: status.exitCode === 0 ? status.stdoutTail.trim().length > 0 : null,
    status: status.exitCode === 0 ? status.stdoutTail.trim().split('\n').filter(Boolean).slice(0, 50) : [],
  }
}

async function readAutoQuantSummary(repoDir: string, limit = 20) {
  const [strategies, results, artifacts] = await Promise.all([
    listStrategyFiles(repoDir),
    readResultsTsv(repoDir, limit),
    listBacktestArtifacts(repoDir, limit),
  ])
  return { strategies, results, artifacts }
}

async function getCheckoutShape(repoDir: string): Promise<{ exists: boolean; isGitRepo: boolean }> {
  const targetExists = await exists(repoDir)
  return {
    exists: targetExists,
    isGitRepo: targetExists && await exists(join(repoDir, '.git')),
  }
}

async function listStrategyFiles(repoDir: string) {
  const dir = join(repoDir, 'user_data', 'strategies')
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const out = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.py') || entry.name.startsWith('_')) continue
      const path = join(dir, entry.name)
      const s = await stat(path)
      out.push({ name: entry.name, sizeBytes: s.size, lastModified: s.mtime.toISOString() })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

async function readResultsTsv(repoDir: string, limit: number) {
  const path = join(repoDir, 'results.tsv')
  try {
    const raw = await readFile(path, 'utf8')
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0)
    if (lines.length === 0) return { path, rows: [] }
    const header = lines[0].split('\t')
    const rows = lines.slice(1).map((line) => {
      const cols = line.split('\t')
      const row: Record<string, string> = {}
      for (let i = 0; i < header.length; i++) row[header[i] || `col${i}`] = cols[i] ?? ''
      return row
    })
    return { path, rows: rows.slice(-limit) }
  } catch {
    return { path, rows: [], missing: true }
  }
}

async function listBacktestArtifacts(repoDir: string, limit: number) {
  const dir = join(repoDir, 'user_data', 'backtest_results')
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const files = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const path = join(dir, entry.name)
      const s = await stat(path)
      files.push({ name: entry.name, sizeBytes: s.size, lastModified: s.mtime.toISOString() })
    }
    return files.sort((a, b) => b.lastModified.localeCompare(a.lastModified)).slice(0, limit)
  } catch {
    return []
  }
}

function isAutoQuantRemote(url: string, configuredRemoteUrl = DEFAULT_REMOTE_URL): boolean {
  return [
    DEFAULT_REMOTE_URL,
    configuredRemoteUrl,
    'https://github.com/TraderAlice/Auto-Quant',
    'git@github.com:TraderAlice/Auto-Quant.git',
  ].includes(url)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function runLocalCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<CommandResult> {
  const start = Date.now()
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let spawnError: Error | null = null

  const child = spawn(command, [...args], {
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  })

  const trim = (value: string) => value.length > OUTPUT_TAIL_BYTES ? value.slice(-OUTPUT_TAIL_BYTES) : value
  child.stdout.on('data', (chunk) => { stdout = trim(stdout + chunk.toString('utf8')) })
  child.stderr.on('data', (chunk) => { stderr = trim(stderr + chunk.toString('utf8')) })

  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
  }, options.timeoutMs)
  timer.unref()
  const hardKillTimer = setTimeout(() => {
    if (timedOut) child.kill('SIGKILL')
  }, options.timeoutMs + 500)
  hardKillTimer.unref()

  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('error', (err) => {
      spawnError = err
      stderr = trim(`${stderr}${stderr ? '\n' : ''}${err.message}`)
    })
    child.on('close', (code, signal) => resolve({ code, signal }))
  }).finally(() => {
    clearTimeout(timer)
    clearTimeout(hardKillTimer)
  })

  return {
    command: [command, ...args],
    cwd: options.cwd ?? null,
    exitCode: spawnError ? null : code,
    signal,
    timedOut,
    durationMs: Date.now() - start,
    stdoutTail: stdout,
    stderrTail: stderr,
  }
}
