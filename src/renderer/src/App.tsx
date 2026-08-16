import React, { useState, useEffect, useRef } from 'react'
import { TitleBar } from './components/TitleBar'
import { DropZone } from './components/DropZone'
import { CompressionPanel } from './components/CompressionPanel'
import { ExtractionPanel } from './components/ExtractionPanel'
import { ArchiveInspector } from './components/ArchiveInspector'
import { QueueManager } from './components/QueueManager'
import { PasswordPromptModal } from './components/PasswordPromptModal'
import { AppMode, SelectedItem, ActiveJob } from './types'
import './styles/theme.css'
import './App.css'
import { useTranslation } from 'react-i18next'

export const App: React.FC = () => {
  const { t } = useTranslation()
  const [mode, setMode] = useState<AppMode>('compress')
  const [selectedItems, setSelectedItems] = useState<SelectedItem[]>([])
  const [extractItems, setExtractItems] = useState<SelectedItem[]>([])
  const [extractInputErrorKey, setExtractInputErrorKey] = useState<string | null>(null)
  const [jobs, setJobs] = useState<ActiveJob[]>([])
  const [passwordPromptArchive, setPasswordPromptArchive] = useState<string | null>(null)
  const [passwordPromptIncorrect, setPasswordPromptIncorrect] = useState(false)
  const passwordPromptResolver = useRef<((password: string | null) => void) | null>(null)
  const passwordPromptJobId = useRef<string | null>(null)
  const cancelledJobIds = useRef(new Set<string>())

  const isZipPasswordProtected = async (archivePath: string) => {
    if (!archivePath.toLowerCase().endsWith('.zip') || !(window as any).electronAPI) return false
    const response = await (window as any).electronAPI.inspectArchive(archivePath)
    return response.success && response.result?.passwordProtected === true
  }

  const requestZipPassword = (jobId: string, archiveName: string, incorrectPassword = false) => new Promise<string | null>((resolve) => {
    passwordPromptResolver.current = resolve
    passwordPromptJobId.current = jobId
    setPasswordPromptIncorrect(incorrectPassword)
    setPasswordPromptArchive(archiveName)
  })

  const resolvePasswordPrompt = (password: string | null) => {
    passwordPromptResolver.current?.(password)
    passwordPromptResolver.current = null
    passwordPromptJobId.current = null
    setPasswordPromptIncorrect(false)
    setPasswordPromptArchive(null)
  }

  const extractWithPasswordRetry = async (
    jobId: string,
    archiveName: string,
    passwordProtected: boolean,
    extract: (password?: string) => Promise<any>,
    initialPassword?: string
  ) => {
    let password = passwordProtected ? initialPassword || await requestZipPassword(jobId, archiveName) : undefined

    while (password || !passwordProtected) {
      const result = await extract(password || undefined)
      if (!passwordProtected || result.success || result.code !== 'WRONG_ZIP_PASSWORD') {
        return result
      }

      password = await requestZipPassword(jobId, archiveName, true)
    }

    return null
  }

  useEffect(() => {
    if ((window as any).electronAPI) {
      const unsubscribe = (window as any).electronAPI.onProgress((data: any) => {
        setJobs(prevJobs =>
          prevJobs.map(j => {
            if (j.id === data.jobId) {
              return {
                ...j,
                processedBytes: data.processedBytes,
                totalBytes: data.totalBytes,
                percent: data.percent,
                currentFile: data.currentFile,
                phase: data.phase || 'processing'
              }
            }
            return j
          })
        )
      })
      return () => {
        if (unsubscribe) unsubscribe()
      }
    }
    return undefined
  }, [])

  // Compress Tab Handlers
  const handleAddFiles = async (paths: string[]) => {
    let newItems: SelectedItem[] = []
    if ((window as any).electronAPI?.getItemStat) {
      const stats = await (window as any).electronAPI.getItemStat(paths)
      newItems = stats.map((s: { path: string; name: string; isDirectory: boolean; size: number }) => ({
        path: s.path,
        name: s.name,
        isDirectory: s.isDirectory,
        size: s.size
      }))
    } else {
      newItems = paths.map(p => {
        const name = p.split(/[/\\]/).pop() || p
        return {
          path: p,
          name,
          isDirectory: false,
          size: 1024 * 10
        }
      })
    }

    setSelectedItems(prev => {
      const existingPaths = new Set(prev.map(i => i.path))
      const filtered = newItems.filter(i => !existingPaths.has(i.path))
      return [...prev, ...filtered]
    })
  }

  const handleRemoveItem = (index: number) => {
    setSelectedItems(prev => prev.filter((_, i) => i !== index))
  }

  const handleClearItems = () => {
    setSelectedItems([])
  }

  const handleSelectFilesDialog = async (allowFolder = false) => {
    if ((window as any).electronAPI) {
      const paths = await (window as any).electronAPI.selectFiles({
        allowDirectories: allowFolder,
        title: t('dialogs.selectCompressInputs')
      })
      if (paths.length > 0) {
        handleAddFiles(paths)
      }
    }
  }

  // Extract Tab Handlers
  const handleAddExtractFiles = async (paths: string[]) => {
    const supportedExtensions = ['.zip', '.tar', '.tgz', '.tar.gz', '.gz']
    const isSupportedArchive = (filePath: string) => supportedExtensions.some(extension => filePath.toLowerCase().endsWith(extension))
    let newItems: SelectedItem[]
    if ((window as any).electronAPI?.getItemStat) {
      const stats = await (window as any).electronAPI.getItemStat(paths)
      newItems = stats.map((s: { path: string; name: string; isDirectory: boolean; size: number }) => ({
        path: s.path,
        name: s.name,
        isDirectory: s.isDirectory,
        size: s.size
      }))
    } else {
      newItems = paths.map(p => {
        const name = p.split(/[/\\]/).pop() || p
        return {
          path: p,
          name,
          isDirectory: false,
          size: 1024 * 10
        }
      })
    }

    const invalidItems = newItems.filter(item => item.isDirectory || !isSupportedArchive(item.path))
    const validItems = newItems.filter(item => !item.isDirectory && isSupportedArchive(item.path))
    setExtractInputErrorKey(invalidItems.length > 0 ? 'dropZone.invalidExtractInput' : null)

    setExtractItems(prev => {
      const existingPaths = new Set(prev.map(i => i.path))
      const filtered = validItems.filter(i => !existingPaths.has(i.path))
      return [...prev, ...filtered]
    })
  }

  const handleRemoveExtractItem = (index: number) => {
    setExtractItems(prev => prev.filter((_, i) => i !== index))
  }

  const handleClearExtractItems = () => {
    setExtractItems([])
    setExtractInputErrorKey(null)
  }

  const handleSelectExtractFilesDialog = async () => {
    if ((window as any).electronAPI) {
      const paths = await (window as any).electronAPI.selectFiles({
        allowDirectories: false,
        extensions: ['zip', 'tar', 'tgz', 'gz'],
        title: t('dialogs.selectExtractInputs'),
        filterName: t('dialogs.supportedArchives')
      })
      if (paths.length > 0) {
        handleAddExtractFiles(paths)
      }
    }
  }

  // Job Triggers
  const handleStartCompress = async (options: {
    format: 'zip' | 'tar' | 'gz' | 'tgz'
    level: number
    outputPath: string
    password?: string
  }) => {
    const jobId = `job-${Date.now()}`
    const inputPaths = selectedItems.map(i => i.path)
    const newJob: ActiveJob = {
      id: jobId,
      type: 'compress',
      sourceName: selectedItems.length === 1 ? selectedItems[0].name : undefined,
      itemCount: selectedItems.length,
      format: options.format,
      outputPath: options.outputPath,
      status: 'running',
      phase: 'initializing',
      processedBytes: 0,
      totalBytes: 100,
      percent: 0,
      startTime: Date.now()
    }

    setJobs(prev => [newJob, ...prev])
    setMode('queue')

    if ((window as any).electronAPI) {
      const res = await (window as any).electronAPI.compressArchive({
        inputPaths,
        outputPath: options.outputPath,
        format: options.format,
        level: options.level,
        password: options.password
      }, jobId)

      if (cancelledJobIds.current.has(jobId)) return

      setJobs(prev =>
        prev.map(j => {
          if (j.id === jobId) {
            if (res.success) {
              return {
                ...j,
                status: 'completed',
                percent: 100,
                phase: 'complete',
                durationMs: res.result.durationMs,
                originalSize: res.result.originalSize,
                compressedSize: res.result.compressedSize
              }
            } else {
              return {
                ...j,
                status: 'error',
                errorCode: res.errorCode || 'genericCompression',
                errorDetail: res.error
              }
            }
          }
          return j
        })
      )
    }
  }

  const handleStartBatchExtract = async (options: { targetDir: string; createSubfolder: boolean }) => {
    if (extractItems.length === 0) return

    const newJobs: ActiveJob[] = extractItems.map((item, idx) => {
      const jobId = `job-${Date.now()}-${idx}`
      const archiveName = item.name.replace(/\.[^/.]+$/, '')
      const sep = options.targetDir.includes('\\') ? '\\' : '/'
      const outputPath = options.createSubfolder
        ? `${options.targetDir}${sep}${archiveName}`
        : options.targetDir

      return {
        id: jobId,
        type: 'extract',
        sourceName: item.name,
        itemCount: 1,
        format: item.name.split('.').pop() || 'zip',
        outputPath,
        status: 'pending',
        phase: 'extracting',
        processedBytes: 0,
        totalBytes: 100,
        percent: 0,
        startTime: Date.now()
      }
    })

    setJobs(prev => [...newJobs, ...prev])
    setMode('queue')

    if ((window as any).electronAPI) {
      for (let i = 0; i < extractItems.length; i++) {
        const item = extractItems[i]
        const job = newJobs[i]
        if (cancelledJobIds.current.has(job.id)) continue
        setJobs(prev => prev.map(existing => existing.id === job.id ? { ...existing, status: 'running' } : existing))
        const passwordProtected = await isZipPasswordProtected(item.path)
        if (cancelledJobIds.current.has(job.id)) continue
        const res = await extractWithPasswordRetry(job.id, item.name, passwordProtected, (password) =>
          (window as any).electronAPI.extractArchive({
            archivePath: item.path,
            targetDir: job.outputPath,
            password
          }, job.id)
        )

        if (cancelledJobIds.current.has(job.id)) continue
        if (!res) {
          setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'error', errorCode: 'passwordCancelled' } : j))
          continue
        }

        setJobs(prev =>
          prev.map(j => {
            if (j.id === job.id) {
              if (res.success) {
                return {
                  ...j,
                  status: 'completed',
                  percent: 100,
                  phase: 'complete',
                  durationMs: res.result.durationMs
                }
              } else {
                return {
                  ...j,
                  status: 'error',
                  errorCode: res.errorCode || 'genericExtraction',
                  errorDetail: res.error
                }
              }
            }
            return j
          })
        )
      }
    }

    setExtractItems([])
  }

  const handleOpenFolder = (targetPath: string) => {
    if ((window as any).electronAPI) {
      (window as any).electronAPI.openFolder(targetPath)
    }
  }

  const handleCancelJob = (jobId: string) => {
    cancelledJobIds.current.add(jobId)
    if (passwordPromptJobId.current === jobId) resolvePasswordPrompt(null)
    setJobs(prev => prev.map(job =>
      job.id === jobId && (job.status === 'pending' || job.status === 'running')
        ? { ...job, status: 'cancelled', errorCode: job.type === 'compress' ? 'compressionCancelled' : 'extractionCancelled' }
        : job
    ))
    void (window as any).electronAPI?.cancelJob(jobId)
  }

  const handleClearCompleted = () => {
    setJobs(prev => prev.filter(j => j.status === 'pending' || j.status === 'running'))
  }

  const activeQueueCount = jobs.filter(j => j.status === 'pending' || j.status === 'running').length

  return (
    <div className="app-shell">
      <TitleBar currentMode={mode} setMode={setMode} activeQueueCount={activeQueueCount} />

      <main className="app-main">
        {mode === 'compress' && (
          <div className="app-workspace">
            <DropZone
              items={selectedItems}
              onAddFiles={handleAddFiles}
              onRemoveItem={handleRemoveItem}
              onClearItems={handleClearItems}
              onSelectFilesDialog={handleSelectFilesDialog}
            />
            <CompressionPanel
              items={selectedItems}
              onStartCompress={handleStartCompress}
            />
          </div>
        )}

        {mode === 'extract' && (
          <div className="app-workspace">
            <DropZone
              items={extractItems}
              onAddFiles={handleAddExtractFiles}
              onRemoveItem={handleRemoveExtractItem}
              onClearItems={handleClearExtractItems}
              onSelectFilesDialog={handleSelectExtractFilesDialog}
              allowFolders={false}
              acceptedFileExtensions={['.zip', '.tar', '.tgz', '.tar.gz', '.gz']}
              validationError={extractInputErrorKey ? t(extractInputErrorKey) : null}
            />
            <ExtractionPanel
              items={extractItems}
              onStartBatchExtract={handleStartBatchExtract}
            />
          </div>
        )}

        {mode === 'inspect' && (
          <ArchiveInspector />
        )}

        {mode === 'queue' && (
          <QueueManager
            jobs={jobs}
            onOpenFolder={handleOpenFolder}
            onClearCompleted={handleClearCompleted}
            onCancelJob={handleCancelJob}
          />
        )}
      </main>
      {passwordPromptArchive && (
        <PasswordPromptModal
          archiveName={passwordPromptArchive}
          hasIncorrectPassword={passwordPromptIncorrect}
          onConfirm={(password) => resolvePasswordPrompt(password)}
          onCancel={() => resolvePasswordPrompt(null)}
        />
      )}
    </div>
  )
}
