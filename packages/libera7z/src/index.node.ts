// The entry the "node" export condition selects. It is the ordinary API plus
// the worker_threads factory, so Node consumers get workers from a plain
// `import 'libera7z'` while the default entry stays free of Node built-ins.
import './node.js'

export * from './index.js'
