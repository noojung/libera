// The WASM engine sees one read-only input file and an in-memory filesystem.
// It never receives a host output directory. Node's safety core owns all writes.
const fs = require('node:fs')
const path = require('node:path')
const { parentPort, workerData } = require('node:worker_threads')
const createSevenZip = require(workerData.enginePath)
const acknowledgement = new Int32Array(workerData.acknowledgement)
let descriptor
let engine
let output
let stderr = ''

async function initialize() {
  descriptor = fs.openSync(workerData.archivePath, 'r')
  const stat = fs.fstatSync(descriptor)
  if (!stat.isFile()) throw new Error('DMG input must be a file')
  const trailer = Buffer.alloc(512)
  fs.readSync(descriptor, trailer, 0, 512, stat.size - 512)
  if (trailer.toString('ascii', 0, 4) !== 'koly') {
    throw new Error('Unsupported DMG: expected an unencrypted UDIF disk image')
  }
  engine = await createSevenZip({
    wasmBinary: fs.readFileSync(path.join(path.dirname(workerData.enginePath), '7zz.wasm')),
    stdin: () => null,
    print: () => {},
    printErr: text => { stderr = (stderr + text + '\n').slice(-8192) },
    quit: () => {}
  })
  const filesystem = engine.FS
  filesystem.writeFile('/image.dmg', new Uint8Array())
  const node = filesystem.lookupPath('/image.dmg').node
  // MEMFS's stat and seek use usedBytes; read is backed by just this descriptor.
  node.usedBytes = stat.size
  node.mode = 0o100400
  node.stream_ops = {
    ...node.stream_ops,
    read: (_stream, buffer, offset, length, position) => fs.readSync(descriptor, buffer, offset, length, position),
    write: () => { throw new Error('DMG input is read-only') }
  }
  const stdout = filesystem.getStream(1)
  stdout.stream_ops = {
    ...stdout.stream_ops,
    write: (_stream, buffer, offset, length) => {
      output(Buffer.from(buffer.subarray(offset, offset + length)))
      return length
    }
  }
}

parentPort.on('message', async request => {
  try {
    if (!engine) await initialize()
    stderr = ''
    let count = 0
    const chunks = []
    output = bytes => {
      count += bytes.length
      if (count > request.maxBytes) throw new Error('DMG output exceeds the configured size limit')
      if (request.kind === 'list') chunks.push(bytes)
      else {
        // One outstanding chunk bounds memory even when the destination is slow.
        for (let start = 0; start < bytes.length; start += 65536) {
          Atomics.store(acknowledgement, 0, 0)
          parentPort.postMessage({ kind: 'data', bytes: bytes.subarray(start, start + 65536) })
          Atomics.wait(acknowledgement, 0, 0)
        }
      }
    }
    const common = ['-bd', '-sccUTF-8', '-p-', '-y']
    const args = request.kind === 'list'
      ? ['l', '-slt', '-ba', ...common, '--', '/image.dmg']
      : ['x', '-so', '-bso0', '-bsp0', '-spd', '-r-', ...common, '--', '/image.dmg', request.entryPath]
    const code = engine.callMain(args)
    if (code !== 0) throw new Error(stderr.trim() || `DMG engine failed (${code})`)
    parentPort.postMessage({ kind: 'done', listing: request.kind === 'list' ? Buffer.concat(chunks).toString('utf8') : undefined })
  } catch (error) {
    parentPort.postMessage({ kind: 'error', message: stderr.trim() || error.message || String(error) })
  }
})
