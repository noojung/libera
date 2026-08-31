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

## A note on threads

The codecs are synchronous and CPU-bound. Long operations should run on a
worker so they do not block the calling thread; this package does not spawn one
for you.

## Licence

MIT
