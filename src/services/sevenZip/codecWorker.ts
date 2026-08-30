import { isMainThread, parentPort } from 'worker_threads'
import { installCodecWorker } from './workerCodec'

// Worker entry only, kept apart from the client module so that importing the
// client from another worker bundle does not also install this handler.
if (!isMainThread && parentPort) installCodecWorker(parentPort)
