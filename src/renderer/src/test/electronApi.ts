import { vi } from 'vitest'
import type { ElectronAPI } from '@preload/preload'
import { canonicalArchivePath } from '@/utils/archivePaths'

export function createElectronApiMock(overrides: Partial<ElectronAPI> = {}) {
  return {
    platform: 'windows' as const,
    minimizeWindow: vi.fn().mockResolvedValue(undefined),
    maximizeWindow: vi.fn().mockResolvedValue(undefined),
    closeWindow: vi.fn().mockResolvedValue(undefined),
    selectFiles: vi.fn().mockResolvedValue([]),
    selectSaveLocation: vi.fn().mockResolvedValue(null),
    selectExtractFolder: vi.fn().mockResolvedValue(null),
    compressArchive: vi.fn().mockResolvedValue({ success: true, result: {} }),
    extractArchive: vi.fn().mockResolvedValue({ success: true, result: {} }),
    cancelJob: vi.fn().mockResolvedValue(true),
    inspectArchive: vi.fn().mockResolvedValue({ success: true, result: {} }),
    previewArchiveEntry: vi.fn().mockResolvedValue({ success: true, result: { kind: 'text', text: '', encoding: 'utf-8', truncated: false, previewedBytes: 0, totalBytes: 0 } }),
    cancelArchivePreview: vi.fn().mockResolvedValue(true),
    openFolder: vi.fn().mockResolvedValue(undefined),
    openExternalLink: vi.fn().mockResolvedValue(undefined),
    getDefaultOutputDir: vi.fn().mockResolvedValue(''),
    getItemStat: vi.fn().mockResolvedValue([]),
    resolveExtractionInputs: vi.fn(async (itemPaths: string[]) => ({
      items: itemPaths.map(itemPath => {
        const archivePath = canonicalArchivePath(itemPath)
        return {
          path: archivePath,
          name: archivePath.split(/[/\\]/).pop() || archivePath,
          isDirectory: false as const,
          size: 100
        }
      }),
      errors: []
    })),
    getPathForFile: vi.fn((file: File) => file.name),
    onProgress: vi.fn(() => vi.fn()),
    ...overrides
  } satisfies ElectronAPI
}

export function installElectronApi(overrides: Partial<ElectronAPI> = {}) {
  const api = createElectronApiMock(overrides)
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: api
  })
  return api
}
