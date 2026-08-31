# libera7z

A dependency-free TypeScript reader and writer for the 7z archive format.

The codecs are implemented from scratch — LZMA, LZMA2, PPMd, BZip2, Deflate,
BCJ/BCJ2 and 7zAES — so the package has no dependencies and no Node built-ins.
It runs anywhere `globalThis.crypto`, `TextEncoder` and `ReadableStream` exist,
which covers browsers and Node 18+.

## Usage

I/O is injected, so the caller decides where the bytes come from and go:

```ts
import { open7z, create7z, MemorySource, MemorySink } from 'libera7z'

const archive = await open7z(new MemorySource(bytes))
for (const entry of archive.entries) console.log(entry.path, entry.size)
const contents = archive.openEntry(archive.entries[0].id) // ReadableStream<Uint8Array>
await archive.close()
```

Implement `RandomAccessSource` and `SeekableSink` to read and write elsewhere,
such as files on disk.

## Reference fixtures

`libera7z/testing` exports archives produced by the reference 7-Zip
implementation, for testing an integration against real output.

## Workers

The codecs are synchronous and CPU-bound, so a large archive would block the
calling thread. Point the package at the worker bundle it ships and `open7z`
and `create7z` move the whole operation off-thread:

```ts
import { configure } from 'libera7z'
import 'libera7z/node' // Node only; browsers use the global Worker

configure({ workerScript: '/path/to/libera7z/dist/worker.js' })
```

Nothing else changes. Your source and sink stay on the calling thread and the
worker calls back into them, so the same objects work either way. Without a
`workerScript`, or with `useWorkers: false`, everything runs in process.

## Licence

MIT
