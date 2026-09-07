// The glob syntax both sides of the app share. Extraction filters the entries
// an archive already holds; compression filters the files that would go into
// one. Neither needs the other's machinery, so the matcher lives on its own
// rather than in extractionSafety.ts, which pulls in the whole safety layer.

function globExpression(pattern: string): RegExp {
  let expression = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        expression += '.*'
        index += 1
      } else {
        expression += '[^/]*'
      }
    } else if (character === '?') {
      expression += '[^/]'
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
    }
  }
  return new RegExp(`${expression}$`, process.platform === 'win32' ? 'i' : '')
}

/**
 * Builds a matcher from a comma, semicolon, or newline separated pattern list.
 * A leading `!` excludes; a pattern holding a slash is matched against the
 * whole path, and one without it against the entry's own name. With no
 * include patterns everything is included, so a list of exclusions alone
 * subtracts from the full set rather than matching nothing.
 */
export function createArchiveEntryFilter(patternText?: string): (entryPath: string) => boolean {
  const tokens = (patternText ?? '')
    .split(/[,;\n]/)
    .map(pattern => pattern.trim())
    .filter(Boolean)
    .slice(0, 100)
    .map(pattern => ({ exclude: pattern.startsWith('!'), pattern: pattern.replace(/^!/, '').slice(0, 256) }))
    .filter(item => item.pattern.length > 0)
    .map(item => ({
      exclude: item.exclude,
      hasSlash: item.pattern.includes('/'),
      expression: globExpression(item.pattern.replace(/\\/g, '/'))
    }))
  const includes = tokens.filter(token => !token.exclude)
  const excludes = tokens.filter(token => token.exclude)
  return entryPath => {
    const normalized = entryPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    const name = normalized.split('/').pop() || normalized
    const matches = (token: typeof tokens[number]) => token.expression.test(token.hasSlash ? normalized : name)
    return (includes.length === 0 || includes.some(matches)) && !excludes.some(matches)
  }
}
