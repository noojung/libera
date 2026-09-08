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

## Codecs on their own

The codecs are exported too, for a caller framing them in something other than
7z. Both decoders below run without being told how much they expand to, which a
container that does not declare it - `.xz`, `.bz2` - needs:

```ts
import { Lzma2StreamDecoder, decodeBzip2Blocks } from 'libera7z'

// LZMA2 frames itself, so it is pushed compressed bytes and pulled decoded ones.
const lzma2 = new Lzma2StreamDecoder(dictionaryProperty)
lzma2.push(chunk)
for (let out = lzma2.pull(); out; out = lzma2.pull()) consume(out)
lzma2.end() // throws if the stream stopped before its end marker

// BZip2 gives no way to find a block's end without decoding it, so it takes the
// whole stream and yields one block at a time.
for (const block of decodeBzip2Blocks(bytes, limit)) consume(block)
```

`decodeLzma2` and `decodeBzip2` stay the one-shot forms for a buffer whose
expanded size is already known.

## Reference fixtures

`libera7z/testing` exports archives produced by the reference 7-Zip
implementation, for testing an integration against real output.

## Workers

The codecs are synchronous and CPU-bound, so a large archive would block the
calling thread. Point the package at the worker bundle it ships and `open7z`
and `create7z` move the whole operation off-thread:

```ts
import { configure } from 'libera7z'

configure({ workerScript: '/path/to/libera7z/dist/worker.js' })
```

Node gets a `worker_threads` worker and browsers the global `Worker`, chosen by
the package's export conditions. A bundler that ignores those can import
`libera7z/node` to register the Node factory explicitly.

Nothing else changes. Your source and sink stay on the calling thread and the
worker calls back into them, so the same objects work either way. Without a
`workerScript`, or with `useWorkers: false`, everything runs in process.

## Licence

MIT
