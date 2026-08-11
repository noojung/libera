import React, { useState, useEffect } from 'react'
import { TitleBar } from './components/TitleBar'
import { DropZone } from './components/DropZone'
import { CompressionPanel } from './components/CompressionPanel'
import { ArchiveInspector } from './components/ArchiveInspector'
import { QueueManager } from './components/QueueManager'
import { AppMode, SelectedItem, ActiveJob } from './types'
import './styles/theme.css'

export const App: React.FC = () => {
  const [mode, setMode] = useState<AppMode>('compress')
  const [selectedItems, setSelectedItems] = useState<SelectedItem[]>([])
  const [jobs, setJobs] = useState<ActiveJob[]>([])

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

  const handleStartExtract = async (archivePath: string, targetDir: string) => {
    const jobId = `job-${Date.now()}`
    const archiveName = archivePath.split(/[/\\]/).pop() || 'Archive'

    const newJob: ActiveJob = {
      id: jobId,
      type: 'extract',
      name: `Extract ${archiveName}`,
      format: archivePath.split('.').pop() || 'zip',
      outputPath: targetDir,
      status: 'running',
      processedBytes: 0,
      totalBytes: 100,
      percent: 0,
      currentFile: 'Extracting...',
      startTime: Date.now()
    }

    setJobs(prev => [newJob, ...prev])
    setMode('queue')

    if ((window as any).electronAPI) {
      const res = await (window as any).electronAPI.extractArchive({
        archivePath,
        targetDir
      }, jobId)

      setJobs(prev =>
        prev.map(j => {
          if (j.id === jobId) {
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
          <ArchiveInspector onStartExtract={handleStartExtract} />
        )}

        {mode === 'inspect' && (
          <ArchiveInspector onStartExtract={handleStartExtract} />
        )}

        {mode === 'queue' && (
          <QueueManager
            jobs={jobs}
            onOpenFolder={handleOpenFolder}
            onClearCompleted={handleClearCompleted}
          />
        )}
      </main>
    </div>
  )
}
