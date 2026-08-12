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

export const App: React.FC = () => {
  const [mode, setMode] = useState<AppMode>('compress')
  const [selectedItems, setSelectedItems] = useState<SelectedItem[]>([])
  const [extractItems, setExtractItems] = useState<SelectedItem[]>([])
  const [extractInputError, setExtractInputError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<ActiveJob[]>([])
  const [passwordPromptArchive, setPasswordPromptArchive] = useState<string | null>(null)
  const [passwordPromptError, setPasswordPromptError] = useState<string | null>(null)
  const passwordPromptResolver = useRef<((password: string | null) => void) | null>(null)

  const isZipPasswordProtected = async (archivePath: string) => {
    if (!archivePath.toLowerCase().endsWith('.zip') || !(window as any).electronAPI) return false
    const response = await (window as any).electronAPI.inspectArchive(archivePath)
    return response.success && response.result?.passwordProtected === true
  }

  const requestZipPassword = (archiveName: string, errorMessage?: string) => new Promise<string | null>((resolve) => {
    passwordPromptResolver.current = resolve
    setPasswordPromptError(errorMessage || null)
    setPasswordPromptArchive(archiveName)
  })

  const resolvePasswordPrompt = (password: string | null) => {
    passwordPromptResolver.current?.(password)
    passwordPromptResolver.current = null
    setPasswordPromptError(null)
    setPasswordPromptArchive(null)
  }

  const extractWithPasswordRetry = async (
    archiveName: string,
    passwordProtected: boolean,
    extract: (password?: string) => Promise<any>,
    initialPassword?: string
  ) => {
    let password = passwordProtected ? initialPassword || await requestZipPassword(archiveName) : undefined

    while (password || !passwordProtected) {
      const result = await extract(password || undefined)
      if (!passwordProtected || result.success || result.code !== 'WRONG_ZIP_PASSWORD') {
        return result
      }

      password = await requestZipPassword(archiveName, '비밀번호가 올바르지 않습니다. 다시 입력해 주세요.')
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
                currentFile: data.currentFile
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
      const paths = await (window as any).electronAPI.selectFiles({ allowDirectories: allowFolder })
      if (paths.length > 0) {
        handleAddFiles(paths)
      }
    }
  }

  // Extract Tab Handlers
  const handleAddExtractFiles = async (paths: string[]) => {
    const supportedExtensions = ['.zip', '.tar', '.tgz', '.tar.gz', '.gz']
    const isSupportedArchive = (filePath: string) => supportedExtensions.some(extension => filePath.toLowerCase().endsWith(extension))
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

    const invalidItems = newItems.filter(item => item.isDirectory || !isSupportedArchive(item.path))
    const validItems = newItems.filter(item => !item.isDirectory && isSupportedArchive(item.path))
    setExtractInputError(invalidItems.length > 0 ? '폴더와 비지원 파일은 추가할 수 없습니다. ZIP, TAR, TAR.GZ, TGZ, GZ 파일을 선택해 주세요.' : null)

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
    setExtractInputError(null)
  }

  const handleSelectExtractFilesDialog = async () => {
    if ((window as any).electronAPI) {
      const paths = await (window as any).electronAPI.selectFiles({
        allowDirectories: false,
        extensions: ['zip', 'tar', 'tgz', 'gz'],
        title: 'Select Archive Files to Extract'
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
    const name = selectedItems.length === 1 ? selectedItems[0].name : `${selectedItems.length} items`

    const newJob: ActiveJob = {
      id: jobId,
      type: 'compress',
      name: `Compress ${name}`,
      format: options.format,
      outputPath: options.outputPath,
      status: 'running',
      processedBytes: 0,
      totalBytes: 100,
      percent: 0,
      currentFile: 'Initializing...',
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

      setJobs(prev =>
        prev.map(j => {
          if (j.id === jobId) {
            if (res.success) {
              return {
                ...j,
                status: 'completed',
                percent: 100,
                durationMs: res.result.durationMs,
                originalSize: res.result.originalSize,
                compressedSize: res.result.compressedSize
              }
            } else {
              return {
                ...j,
                status: 'error',
                error: res.error
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
        name: `Extract ${item.name}`,
        format: item.name.split('.').pop() || 'zip',
        outputPath,
        status: 'running',
        processedBytes: 0,
        totalBytes: 100,
        percent: 0,
        currentFile: 'Extracting...',
        startTime: Date.now()
      }
    })

    setJobs(prev => [...newJobs, ...prev])
    setMode('queue')

    if ((window as any).electronAPI) {
      for (let i = 0; i < extractItems.length; i++) {
        const item = extractItems[i]
        const job = newJobs[i]
        const passwordProtected = await isZipPasswordProtected(item.path)
        const res = await extractWithPasswordRetry(item.name, passwordProtected, (password) =>
          (window as any).electronAPI.extractArchive({
            archivePath: item.path,
            targetDir: job.outputPath,
            password
          }, job.id)
        )

        if (!res) {
          setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'error', error: 'Password entry cancelled' } : j))
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
                  durationMs: res.result.durationMs
                }
              } else {
                return {
                  ...j,
                  status: 'error',
                  error: res.error
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

  const handleClearCompleted = () => {
    setJobs(prev => prev.filter(j => j.status === 'running'))
  }

  const activeQueueCount = jobs.filter(j => j.status === 'running').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw' }}>
      <TitleBar currentMode={mode} setMode={setMode} activeQueueCount={activeQueueCount} />

      <main style={{ flex: 1, padding: '20px', overflow: 'hidden', background: '#F8FAFC' }}>
        {mode === 'compress' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '20px', height: '100%' }}>
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
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '20px', height: '100%' }}>
            <DropZone
              items={extractItems}
              onAddFiles={handleAddExtractFiles}
              onRemoveItem={handleRemoveExtractItem}
              onClearItems={handleClearExtractItems}
              onSelectFilesDialog={handleSelectExtractFilesDialog}
              allowFolders={false}
              acceptedFileExtensions={['.zip', '.tar', '.tgz', '.tar.gz', '.gz']}
              validationError={extractInputError}
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
          />
        )}
      </main>
      {passwordPromptArchive && (
        <PasswordPromptModal
          archiveName={passwordPromptArchive}
          errorMessage={passwordPromptError}
          onConfirm={(password) => resolvePasswordPrompt(password)}
          onCancel={() => resolvePasswordPrompt(null)}
        />
      )}
    </div>
  )
}
