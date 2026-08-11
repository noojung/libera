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
  name: string
  format: string
  outputPath?: string
  status: 'pending' | 'running' | 'completed' | 'error'
  processedBytes: number
  totalBytes: number
  percent: number
  currentFile: string
  error?: string
  startTime: number
  durationMs?: number
  compressedSize?: number
  originalSize?: number
}
