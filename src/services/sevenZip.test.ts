import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import {
  buildSevenZipArguments,
  classifySevenZipExit,
  isWrongSevenZipPasswordText,
  parseSevenZipProgressLine,
  runSevenZip,
  SevenZipError,
  sevenZipPasswordPromptCount,
  splitSevenZipChunks
} from './sevenZip'
import { resetSevenZipBinaryCache, resolveSevenZipBinaryPath, SEVEN_ZIP_PATH_ENV } from './sevenZipBinary'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libera-sevenzip-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  delete process.env[SEVEN_ZIP_PATH_ENV]
  resetSevenZipBinaryCache()
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('splitSevenZipChunks', () => {
  it('treats carriage returns and backspaces as separators', () => {
    // 7-Zip redraws progress in place rather than emitting whole lines.
    expect(splitSevenZipChunks('  0M Scan\b\b\b\b\r 12% 3\r 40% 7')).toEqual([
      '  0M Scan',
      ' 12% 3',
      ' 40% 7'
    ])
  })
})

describe('parseSevenZipProgressLine', () => {
  it('reads the percentage out of a redraw fragment', () => {
    expect(parseSevenZipProgressLine(' 93% 2')).toEqual({ percent: 93 })
    expect(parseSevenZipProgressLine('  0%')).toEqual({ percent: 0 })
  })

  it('reads the current file from a -bb1 log line', () => {
    expect(parseSevenZipProgressLine('- big/rand.bin')).toEqual({ percent: -1, currentFile: 'big/rand.bin' })
    expect(parseSevenZipProgressLine('+ docs/readme.txt')).toEqual({ percent: -1, currentFile: 'docs/readme.txt' })
  })

  it('ignores banner and scan chatter', () => {
    expect(parseSevenZipProgressLine('7-Zip (a) [64] 17.03 : Copyright (c) 1999-2020')).toBeNull()
    expect(parseSevenZipProgressLine('Scanning the drive for archives:')).toBeNull()
    expect(parseSevenZipProgressLine('')).toBeNull()
  })
})

describe('classifySevenZipExit', () => {
  it('accepts success and the warning status', () => {
    expect(classifySevenZipExit(0, '', false)).toBeNull()
    // Exit 1 means a warning such as an unreadable input, not a failure.
    expect(classifySevenZipExit(1, 'WARNING: cannot open file', false)).toBeNull()
  })

  it('tells a missing password from a wrong one by what the caller supplied', () => {
    // A header-encrypted archive reports both cases with identical text.
    const message = 'ERROR: enc.7z : Can not open encrypted archive. Wrong password?'
    expect(classifySevenZipExit(2, message, false)?.code).toBe('SEVEN_ZIP_PASSWORD_REQUIRED')
    expect(classifySevenZipExit(2, message, true)?.code).toBe('SEVEN_ZIP_WRONG_PASSWORD')
  })

  it('maps the user-stop status to cancellation', () => {
    expect(classifySevenZipExit(255, '', false)?.code).toBe('SEVEN_ZIP_CANCELLED')
  })

  it('surfaces the stderr tail for an unclassified failure', () => {
    const failure = classifySevenZipExit(2, 'ERROR: Unsupported method\n', false)
    expect(failure?.code).toBe('SEVEN_ZIP_FAILED')
    expect(failure?.message).toContain('Unsupported method')
  })

  it('reports a command-line error as a failure rather than a password problem', () => {
    expect(classifySevenZipExit(7, 'Incorrect command line', false)?.code).toBe('SEVEN_ZIP_FAILED')
  })
})

describe('isWrongSevenZipPasswordText', () => {
  it('matches every shape 7-Zip uses for a bad password', () => {
    expect(isWrongSevenZipPasswordText('Wrong password?')).toBe(true)
    expect(isWrongSevenZipPasswordText('Can not open encrypted archive. Wrong password?')).toBe(true)
    expect(isWrongSevenZipPasswordText('Data Error in encrypted file. Wrong password?')).toBe(true)
    expect(isWrongSevenZipPasswordText('ERROR: Unsupported method')).toBe(false)
  })
})

describe('buildSevenZipArguments', () => {
  it('never puts the password on the command line, where the process list would expose it', () => {
    expect(buildSevenZipArguments(['l', 'enc.7z'], 'hunter2')).toEqual(['-y', 'l', 'enc.7z'])
    expect(buildSevenZipArguments(['a', 'out.7z', 'src'], 'hunter2')).toEqual(['-y', '-p', 'a', 'out.7z', 'src'])
    expect(buildSevenZipArguments(['a', 'out.7z', 'src'], 'hunter2').join(' ')).not.toContain('hunter2')
  })

  it('adds an empty -p only for `a`, which otherwise never prompts', () => {
    // Read commands are the opposite: supplying -p reads as "empty password"
    // and suppresses the prompt we need.
    expect(buildSevenZipArguments(['a', 'out.7z'], undefined)).toEqual(['-y', 'a', 'out.7z'])
    expect(buildSevenZipArguments(['x', 'enc.7z'], undefined)).toEqual(['-y', 'x', 'enc.7z'])
  })
})

describe('sevenZipPasswordPromptCount', () => {
  it('answers the confirmation prompt that only `a` asks', () => {
    expect(sevenZipPasswordPromptCount(['a', 'out.7z'])).toBe(2)
    expect(sevenZipPasswordPromptCount(['x', 'enc.7z'])).toBe(1)
    expect(sevenZipPasswordPromptCount(['l', 'enc.7z'])).toBe(1)
  })
})

describe('resolveSevenZipBinaryPath', () => {
  it('honours the environment override', async () => {
    const directory = await createTemporaryDirectory()
    const stub = path.join(directory, process.platform === 'win32' ? '7za.exe' : '7za')
    await fs.writeFile(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    process.env[SEVEN_ZIP_PATH_ENV] = stub
    resetSevenZipBinaryCache()

    await expect(resolveSevenZipBinaryPath()).resolves.toBe(stub)
  })

  it.skipIf(process.platform === 'win32')('repairs a binary that npm unpacked without the executable bit', async () => {
    const directory = await createTemporaryDirectory()
    const stub = path.join(directory, '7za')
    await fs.writeFile(stub, '#!/bin/sh\nexit 0\n', { mode: 0o644 })
    process.env[SEVEN_ZIP_PATH_ENV] = stub
    resetSevenZipBinaryCache()

    await expect(resolveSevenZipBinaryPath()).resolves.toBe(stub)
    expect((await fs.stat(stub)).mode & 0o111).not.toBe(0)
  })

  it('finds the binary shipped in node_modules without any override', async () => {
    resetSevenZipBinaryCache()
    await expect(resolveSevenZipBinaryPath()).resolves.toContain('7za')
  })
})

describe('runSevenZip', () => {
  it('reports the bundled 7-Zip version, proving the binary is usable', async () => {
    const { stdout } = await runSevenZip(['i'], undefined)
    expect(stdout).toMatch(/7-Zip/)
  })

  it('raises a cancellation error when the signal aborts', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runSevenZip(['i'], undefined, { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'SEVEN_ZIP_CANCELLED' })
  })

  it('classifies a failure against a missing archive', async () => {
    const directory = await createTemporaryDirectory()
    await expect(runSevenZip(['l', path.join(directory, 'missing.7z')], undefined))
      .rejects.toBeInstanceOf(SevenZipError)
  })
})

describe('password handling over stdin', () => {
  const password = 'ab cd 한글!'

  async function createEncryptedArchive(): Promise<{ directory: string; archivePath: string }> {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'src')
    await fs.mkdir(sourceDir)
    await fs.writeFile(path.join(sourceDir, 'a.txt'), 'secret contents')
    const archivePath = path.join(directory, 'enc.7z')
    await runSevenZip(['a', '-mhe=on', archivePath, sourceDir], password)
    return { directory, archivePath }
  }

  it('round trips an encrypted archive with a password carrying spaces and non-ASCII', async () => {
    const { directory, archivePath } = await createEncryptedArchive()
    const targetDir = path.join(directory, 'out')

    await runSevenZip(['x', `-o${targetDir}`, archivePath], password)

    const extracted = await fs.readFile(path.join(targetDir, 'src', 'a.txt'), 'utf8')
    expect(extracted).toBe('secret contents')
  }, 30_000)

  it('rejects a wrong password rather than producing an empty extraction', async () => {
    const { directory, archivePath } = await createEncryptedArchive()

    await expect(runSevenZip(['x', `-o${path.join(directory, 'bad')}`, archivePath], 'wrong-password'))
      .rejects.toMatchObject({ code: 'SEVEN_ZIP_WRONG_PASSWORD' })
  }, 30_000)

  it('reports a header-encrypted archive as needing a password instead of hanging on the prompt', async () => {
    const { archivePath } = await createEncryptedArchive()

    // No password means stdin closes immediately; 7-Zip must error, not wait.
    await expect(runSevenZip(['l', archivePath], undefined))
      .rejects.toMatchObject({ code: 'SEVEN_ZIP_PASSWORD_REQUIRED' })
  }, 30_000)

  it('ignores a password handed to an archive that does not need one', async () => {
    const directory = await createTemporaryDirectory()
    const sourceDir = path.join(directory, 'src')
    await fs.mkdir(sourceDir)
    await fs.writeFile(path.join(sourceDir, 'a.txt'), 'plain contents')
    const archivePath = path.join(directory, 'plain.7z')
    await runSevenZip(['a', archivePath, sourceDir], undefined)

    await expect(runSevenZip(['l', archivePath], password)).resolves.toMatchObject({ exitCode: 0 })
  }, 30_000)
})
