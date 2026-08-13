export type AppMode = 'compress' | 'extract' | 'inspect' | 'queue'

export interface SelectedItem {
  path: string
  name: string
  isDirectory: boolean
  size: number
}

export interface ActiveJob {
  id: string
  type: 'compress' | 'extract'
  sourceName?: string
  itemCount: number
  format: string
  outputPath?: string
  status: 'pending' | 'running' | 'completed' | 'error'
  phase: 'initializing' | 'compressing' | 'extracting' | 'processing' | 'complete'
  processedBytes: number
  totalBytes: number
  percent: number
  currentFile?: string
  errorCode?: string
  errorDetail?: string
  startTime: number
  durationMs?: number
  compressedSize?: number
  originalSize?: number
}
