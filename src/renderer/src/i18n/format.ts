import type { AppLanguage } from './language'

export function formatBytes(bytes: number, language: AppLanguage): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, unitIndex)
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(value)} ${units[unitIndex]}`
}

export function formatDuration(milliseconds: number | undefined, language: AppLanguage): string {
  const value = milliseconds ?? 0
  if (value < 1000) return `${new Intl.NumberFormat(language).format(value)} ms`
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value / 1000)} s`
}
