/*
 * TypeScript port of the public-domain PPMdH implementation in 7-Zip 26.02.
 * Reference revision: f9d78aff31a5f2521ae7ddbdc97c4a8855808959
 *   https://github.com/ip7z/7zip/tree/f9d78aff31a5f2521ae7ddbdc97c4a8855808959/C
 * Reference files: Ppmd.h, Ppmd7.h, Ppmd7.c and Ppmd7Dec.c.
 *
 * Each reference file identifies Igor Pavlov's code as public domain and the
 * underlying PPMd var.H (2001) by Dmitry Shkarin as public domain. This port
 * follows those C files directly. The Readwide Java port is not an
 * implementation source for this file.
 */
import { invalidArchive, throwIfCancelled, unsupportedFeature } from './errors.js'

const INT_BITS = 7
const PERIOD_BITS = 7
const BIN_SCALE = 1 << (INT_BITS + PERIOD_BITS)
const MAX_FREQ = 124
const UNIT_SIZE = 12
const N_INDEXES = 38
const K_TOP = 1 << 24
const MIN_ORDER = 2
const MAX_ORDER = 64
const MIN_MEMORY = 1 << 11
const MAX_MEMORY = 1 << 28
const INITIAL_BINARY_ESCAPE = [0x3cdd, 0x1f3f, 0x59bf, 0x48f3, 0x64a1, 0x5abc, 0x6632, 0x6051]
const EXP_ESCAPE = [25, 14, 9, 7, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 2]
const DUMMY_SEE = 25 * 16
const STATE_SIZE = 6

/** Ppmd7z range decoder from the public-domain C/Ppmd7Dec.c. */
class Ppmd7zRangeDecoder {
  private offset = 0
  private code = 0
  private range = 0xffffffff

  constructor(private readonly input: Uint8Array) {
    if (this.readByte() !== 0) throw invalidArchive('7z PPMd range coder header is invalid')
    for (let index = 0; index < 4; index += 1) {
      this.code = ((this.code << 8) | this.readByte()) >>> 0
    }
    if (this.code === 0xffffffff) throw invalidArchive('7z PPMd range coder header is invalid')
  }

  threshold(total: number): number {
    this.range = Math.floor(this.range / total)
    return Math.floor(this.code / this.range)
  }

  decode(start: number, size: number): void {
    this.code = (this.code - start * this.range) >>> 0
    this.range = (this.range * size) >>> 0
    this.normalize()
  }

  decodeBit(probability: number): boolean {
    const size0 = (this.range >>> 14) * probability
    if (this.code < size0) {
      this.range = size0 >>> 0
      this.normalize()
      return false
    }
    this.code = (this.code - size0) >>> 0
    this.range = (this.range - size0) >>> 0
    this.normalize()
    return true
  }

  private readByte(): number {
    const value = this.offset < this.input.length ? this.input[this.offset] : 0
    this.offset += 1
    return value
  }

  private normalize(): void {
    if (this.range < K_TOP) {
      this.code = ((this.code << 8) | this.readByte()) >>> 0
      this.range = (this.range << 8) >>> 0
      if (this.range < K_TOP) {
        this.code = ((this.code << 8) | this.readByte()) >>> 0
        this.range = (this.range << 8) >>> 0
      }
    }
  }
}

/** Offset-based sub-allocator corresponding to the allocator in C/Ppmd7.c. */
class Ppmd7Arena {
  readonly bytes: Uint8Array
  private readonly words: DataView
  private readonly origin: number
  private readonly unitsForClass = new Uint8Array(N_INDEXES)
  private readonly classForUnits = new Uint8Array(128)
  private readonly freeHead = new Uint32Array(N_INDEXES)

  text = 0
  unitsStart = 0
  low = 0
  high = 0
  private glueCountdown = 0

  constructor(private readonly capacity: number) {
    const alignment = 4 - (capacity & 3)
    this.bytes = new Uint8Array(alignment + capacity + UNIT_SIZE)
    this.words = new DataView(this.bytes.buffer)
    this.origin = alignment
    this.text = this.origin

    let unitCount = 0
    for (let allocationClass = 0; allocationClass < N_INDEXES; allocationClass += 1) {
      let repetitions = allocationClass >= 12 ? 4 : (allocationClass >> 2) + 1
      do this.classForUnits[unitCount++] = allocationClass
      while (--repetitions !== 0)
      this.unitsForClass[allocationClass] = unitCount
    }
  }

  reset(): void {
    this.freeHead.fill(0)
    this.text = this.origin
    this.high = this.origin + this.capacity
    const allocatableUnits = Math.floor(this.capacity / 8 / UNIT_SIZE) * 7
    this.low = this.unitsStart = this.high - allocatableUnits * UNIT_SIZE
    this.glueCountdown = 0
  }

  reserveRootContext(): number {
    this.high -= UNIT_SIZE
    return this.high
  }

  reserveRootStates(): number {
    const address = this.low
    this.low += this.bytesForUnits(128)
    return address
  }

  appendText(symbol: number): boolean {
    this.bytes[this.text++] = symbol
    return this.text < this.unitsStart
  }

  rewindText(): void {
    this.text -= 1
  }

  readContextCount(context: number): number {
    return this.read16(context)
  }

  writeContextCount(context: number, count: number): void {
    this.write16(context, count)
  }

  readContextTotal(context: number): number {
    return this.read16(context + 2)
  }

  writeContextTotal(context: number, total: number): void {
    this.write16(context + 2, total)
  }

  readContextStates(context: number): number {
    return this.read32(context + 4)
  }

  writeContextStates(context: number, states: number): void {
    this.write32(context + 4, states)
  }

  readContextSuffix(context: number): number {
    return this.read32(context + 8)
  }

  writeContextSuffix(context: number, suffix: number): void {
    this.write32(context + 8, suffix)
  }

  inlineState(context: number): number {
    return context + 2
  }

  readSymbol(state: number): number {
    return this.bytes[state]
  }

  writeSymbol(state: number, symbol: number): void {
    this.bytes[state] = symbol
  }

  readFrequency(state: number): number {
    return this.bytes[state + 1]
  }

  writeFrequency(state: number, frequency: number): void {
    this.bytes[state + 1] = frequency
  }

  readSuccessor(state: number): number {
    return this.read16(state + 2) | (this.read16(state + 4) << 16)
  }

  writeSuccessor(state: number, successor: number): void {
    this.write16(state + 2, successor)
    this.write16(state + 4, successor >>> 16)
  }

  copyState(destination: number, source: number): void {
    this.bytes.copyWithin(destination, source, source + STATE_SIZE)
  }

  swapStates(left: number, right: number): void {
    for (let byte = 0; byte < STATE_SIZE; byte += 1) {
      const saved = this.bytes[left + byte]
      this.bytes[left + byte] = this.bytes[right + byte]
      this.bytes[right + byte] = saved
    }
  }

  copyUnits(destination: number, source: number, unitCount: number): void {
    this.bytes.copyWithin(destination, source, source + this.bytesForUnits(unitCount))
  }

  allocationClass(unitCount: number): number {
    return this.classForUnits[unitCount - 1]
  }

  allocate(allocationClass: number): number {
    if (this.freeHead[allocationClass] !== 0) return this.detach(allocationClass)

    const byteCount = this.bytesForUnits(this.unitsForClass[allocationClass])
    if (this.high - this.low >= byteCount) {
      const address = this.low
      this.low += byteCount
      return address
    }
    return this.allocateRare(allocationClass)
  }

  allocateContext(): number {
    if (this.high !== this.low) {
      this.high -= UNIT_SIZE
      return this.high
    }
    if (this.freeHead[0] !== 0) return this.detach(0)
    return this.allocateRare(0)
  }

  release(address: number, unitCount: number): void {
    this.attach(address, this.allocationClass(unitCount))
  }

  resize(address: number, oldUnitCount: number, newUnitCount: number): number {
    const oldClass = this.allocationClass(oldUnitCount)
    const newClass = this.allocationClass(newUnitCount)
    if (oldClass === newClass) return address

    if (this.freeHead[newClass] !== 0) {
      const replacement = this.detach(newClass)
      this.copyUnits(replacement, address, newUnitCount)
      this.attach(address, oldClass)
      return replacement
    }
    this.split(address, oldClass, newClass)
    return address
  }

  private read16(address: number): number {
    return this.words.getUint16(address, true)
  }

  private write16(address: number, value: number): void {
    this.words.setUint16(address, value & 0xffff, true)
  }

  private read32(address: number): number {
    return this.words.getUint32(address, true)
  }

  private write32(address: number, value: number): void {
    this.words.setUint32(address, value >>> 0, true)
  }

  private bytesForUnits(unitCount: number): number {
    return unitCount * UNIT_SIZE
  }

  private attach(address: number, allocationClass: number): void {
    this.write32(address, this.freeHead[allocationClass])
    this.freeHead[allocationClass] = address
  }

  private detach(allocationClass: number): number {
    const address = this.freeHead[allocationClass]
    this.freeHead[allocationClass] = this.read32(address)
    return address
  }

  private split(address: number, oldClass: number, newClass: number): void {
    const remainderUnits = this.unitsForClass[oldClass] - this.unitsForClass[newClass]
    const remainder = address + this.bytesForUnits(this.unitsForClass[newClass])
    let remainderClass = this.allocationClass(remainderUnits)
    if (this.unitsForClass[remainderClass] !== remainderUnits) {
      const smallerUnits = this.unitsForClass[--remainderClass]
      this.attach(remainder + this.bytesForUnits(smallerUnits), remainderUnits - smallerUnits - 1)
    }
    this.attach(remainder, remainderClass)
  }

  private allocateRare(allocationClass: number): number {
    if (this.glueCountdown === 0) {
      this.coalesceFreeBlocks()
      if (this.freeHead[allocationClass] !== 0) return this.detach(allocationClass)
    }

    let largerClass = allocationClass + 1
    while (largerClass < N_INDEXES && this.freeHead[largerClass] === 0) largerClass += 1
    if (largerClass < N_INDEXES) {
      const address = this.detach(largerClass)
      this.split(address, largerClass, allocationClass)
      return address
    }

    const byteCount = this.bytesForUnits(this.unitsForClass[allocationClass])
    this.glueCountdown -= 1
    if (this.unitsStart - this.text <= byteCount) return 0
    this.unitsStart -= byteCount
    return this.unitsStart
  }

  private coalesceFreeBlocks(): void {
    this.glueCountdown = 255
    if (this.low !== this.high) this.write16(this.low, 1)

    let list = 0
    for (let allocationClass = 0; allocationClass < N_INDEXES; allocationClass += 1) {
      let address = this.freeHead[allocationClass]
      this.freeHead[allocationClass] = 0
      while (address !== 0) {
        const next = this.read32(address)
        this.write16(address, 0)
        this.write16(address + 2, this.unitsForClass[allocationClass])
        this.write32(address + 4, list)
        list = address
        address = next
      }
    }

    let head = list
    let previous = 0
    while (list !== 0) {
      const next = this.read32(list + 4)
      let unitCount = this.read16(list + 2)
      if (unitCount === 0) {
        if (previous === 0) head = next
        else this.write32(previous + 4, next)
        list = next
        continue
      }
      previous = list
      while (true) {
        const adjacent = list + this.bytesForUnits(unitCount)
        const combined = unitCount + this.read16(adjacent + 2)
        if (this.read16(adjacent) !== 0 || combined >= 0x10000) break
        unitCount = combined
        this.write16(list + 2, unitCount)
        this.write16(adjacent + 2, 0)
      }
      list = next
    }

    for (list = head; list !== 0;) {
      const next = this.read32(list + 4)
      let unitCount = this.read16(list + 2)
      if (unitCount !== 0) {
        while (unitCount > 128) {
          this.attach(list, N_INDEXES - 1)
          list += this.bytesForUnits(128)
          unitCount -= 128
        }
        let allocationClass = this.allocationClass(unitCount)
        if (this.unitsForClass[allocationClass] !== unitCount) {
          const smallerUnits = this.unitsForClass[--allocationClass]
          this.attach(list + this.bytesForUnits(smallerUnits), unitCount - smallerUnits - 1)
        }
        this.attach(list, allocationClass)
      }
      list = next
    }
  }
}

class Ppmd7Model {
  private readonly arena: Ppmd7Arena
  private readonly ns2BSIndx = new Uint8Array(256)
  private readonly ns2Indx = new Uint8Array(256)
  private readonly hb2Flag = new Uint8Array(256)
  private readonly seeSumm = new Uint16Array(25 * 16 + 1)
  private readonly seeShift = new Uint8Array(25 * 16 + 1)
  private readonly seeCount = new Uint8Array(25 * 16 + 1)
  private readonly binSumm = new Uint16Array(128 * 64)

  private orderFall = 0
  private initRL = 0
  private runLength = 0
  private prevSuccess = 0
  private initEsc = 0
  private hiBitsFlag = 0
  private minContext = 0
  private maxContext = 0
  private foundState = 0
  private readonly decoder: Ppmd7zRangeDecoder

  constructor(
    private readonly maxOrder: number,
    memorySize: number,
    input: Uint8Array,
    private readonly signal?: AbortSignal
  ) {
    this.arena = new Ppmd7Arena(memorySize)
    this.decoder = new Ppmd7zRangeDecoder(input)
    this.constructModelTables()
    this.restartModel()
  }

  decode(expectedSize: number): Uint8Array {
    const output = new Uint8Array(expectedSize)
    for (let index = 0; index < output.length; index += 1) {
      if ((index & 0x3fff) === 0) throwIfCancelled(this.signal)
      const symbol = this.decodeSymbol()
      if (symbol < 0) throw invalidArchive(`PPMd stream error at byte ${index}`)
      output[index] = symbol
    }
    return output
  }

  private constructModelTables(): void {
      this.ns2BSIndx[0] = 0
      this.ns2BSIndx[1] = 2
      for (let i = 2; i < 11; i++) this.ns2BSIndx[i] = 4
      for (let i = 11; i < 256; i++) this.ns2BSIndx[i] = 6
      for (let i = 0; i < 3; i++) this.ns2Indx[i] = i
      let m = 3
      let k = 1
      for (let i = 3; i < 256; i++) {
          this.ns2Indx[i] = m
          if (--k === 0) {
              k = (++m) - 2
          }
      }
      for (let i = 0; i < 0x40; i++) this.hb2Flag[i] = 0
      for (let i = 0x40; i < 0x100; i++) this.hb2Flag[i] = 8
  }

  private restartModel(): void {
      this.arena.reset()
      this.orderFall = this.maxOrder
      this.initRL = -(Math.min(this.maxOrder, 12)) - 1
      this.runLength = this.initRL
      this.prevSuccess = 0
      this.minContext = this.maxContext = this.arena.reserveRootContext()
      this.foundState = this.arena.reserveRootStates()
      this.arena.writeContextSuffix(this.minContext, 0)
      this.arena.writeContextCount(this.minContext, 256)
      this.arena.writeContextTotal(this.minContext, 257)
      this.arena.writeContextStates(this.minContext, this.foundState)
      for (let i = 0; i < 256; i++) {
          const state = this.foundState + i * STATE_SIZE
          this.arena.writeSymbol(state, i)
          this.arena.writeFrequency(state, 1)
          this.arena.writeSuccessor(state, 0)
      }

      for (let i = 0; i < 128; i++) {
          for (let k = 0; k < 8; k++) {
              const val = (BIN_SCALE - Math.floor(INITIAL_BINARY_ESCAPE[k] / (i + 2))) & 0xffff
              for (let mIdx = k; mIdx < 64; mIdx += 8) {
                  this.binSumm[i * 64 + mIdx] = val
              }
          }
      }
      for (let i = 0; i < 25; i++) {
          for (let k = 0; k < 16; k++) {
              const idx = i * 16 + k
              this.seeShift[idx] = PERIOD_BITS - 4
              this.seeSumm[idx] = ((5 * i + 10) << this.seeShift[idx]) & 0xffff
              this.seeCount[idx] = 4
          }
      }
      this.seeShift[DUMMY_SEE] = PERIOD_BITS
      this.seeSumm[DUMMY_SEE] = 0
      this.seeCount[DUMMY_SEE] = 64
  }

  private rescale(): void {
      const memory = this.arena
      const context = this.minContext
      const firstState = memory.readContextStates(context)
      let state = this.foundState

      if (state !== firstState) {
          const selected = memory.bytes.slice(state, state + STATE_SIZE)
          do {
              memory.copyState(state, state - STATE_SIZE)
              state -= STATE_SIZE
          } while (state !== firstState)
          memory.bytes.set(selected, firstState)
      }

      let symbolTotal = memory.readFrequency(firstState)
      let escapeTotal = memory.readContextTotal(context) - symbolTotal
      const preserveZeroFrequency = Number(this.orderFall !== 0)
      symbolTotal = (symbolTotal + 4 + preserveZeroFrequency) >> 1
      memory.writeFrequency(firstState, symbolTotal)

      const oldStateCount = memory.readContextCount(context)
      let remaining = oldStateCount - 1
      state = firstState
      do {
          state += STATE_SIZE
          let frequency = memory.readFrequency(state)
          escapeTotal -= frequency
          frequency = (frequency + preserveZeroFrequency) >> 1
          symbolTotal += frequency
          memory.writeFrequency(state, frequency)
          if (frequency > memory.readFrequency(state - STATE_SIZE)) {
              const selected = memory.bytes.slice(state, state + STATE_SIZE)
              let insertion = state
              do {
                  memory.copyState(insertion, insertion - STATE_SIZE)
                  insertion -= STATE_SIZE
              } while (insertion !== firstState && frequency > memory.readFrequency(insertion - STATE_SIZE))
              memory.bytes.set(selected, insertion)
          }
      } while (--remaining !== 0)

      if (memory.readFrequency(state) === 0) {
          let removed = 0
          do {
              removed += 1
              state -= STATE_SIZE
          } while (memory.readFrequency(state) === 0)
          escapeTotal += removed

          const newStateCount = oldStateCount - removed
          memory.writeContextCount(context, newStateCount)
          const oldUnitCount = (oldStateCount + 1) >> 1
          if (newStateCount === 1) {
              let frequency = memory.readFrequency(firstState)
              do {
                  escapeTotal >>= 1
                  frequency = (frequency + 1) >> 1
              } while (escapeTotal > 1)
              const inline = memory.inlineState(context)
              memory.copyState(inline, firstState)
              memory.writeFrequency(inline, frequency)
              this.foundState = inline
              memory.release(firstState, oldUnitCount)
              return
          }

          const newUnitCount = (newStateCount + 1) >> 1
          if (oldUnitCount !== newUnitCount) {
              memory.writeContextStates(context, memory.resize(firstState, oldUnitCount, newUnitCount))
          }
      }

      memory.writeContextTotal(context, symbolTotal + escapeTotal - (escapeTotal >> 1))
      this.foundState = memory.readContextStates(context)
  }

  private createSuccessors(): number {
      const memory = this.arena
      const rawSuccessor = memory.readSuccessor(this.foundState)
      const foundSymbol = memory.readSymbol(this.foundState)
      const pendingStates: number[] = []
      let parent = this.minContext

      if (this.orderFall !== 0) pendingStates.push(this.foundState)
      while (memory.readContextSuffix(parent) !== 0) {
          parent = memory.readContextSuffix(parent)
          let matchingState = memory.readContextCount(parent) === 1
            ? memory.inlineState(parent)
            : memory.readContextStates(parent)
          while (memory.readSymbol(matchingState) !== foundSymbol) matchingState += STATE_SIZE

          const successor = memory.readSuccessor(matchingState)
          if (successor !== rawSuccessor) {
              parent = successor
              if (pendingStates.length === 0) return parent
              break
          }
          pendingStates.push(matchingState)
      }

      const newSymbol = memory.bytes[rawSuccessor]
      const nextRawSuccessor = rawSuccessor + 1
      let newFrequency: number
      if (memory.readContextCount(parent) === 1) {
          newFrequency = memory.readFrequency(memory.inlineState(parent))
      } else {
          let matchingState = memory.readContextStates(parent)
          while (memory.readSymbol(matchingState) !== newSymbol) matchingState += STATE_SIZE
          const matchingFrequency = memory.readFrequency(matchingState) - 1
          const otherFrequency = memory.readContextTotal(parent)
            - memory.readContextCount(parent)
            - matchingFrequency
          newFrequency = 1 + (2 * matchingFrequency <= otherFrequency
            ? Number(5 * matchingFrequency > otherFrequency)
            : Math.floor((2 * matchingFrequency + otherFrequency - 1) / (2 * otherFrequency)) + 1)
      }

      do {
          const context = memory.allocateContext()
          if (context === 0) return 0
          memory.writeContextCount(context, 1)
          const inline = memory.inlineState(context)
          memory.writeSymbol(inline, newSymbol)
          memory.writeFrequency(inline, newFrequency)
          memory.writeSuccessor(inline, nextRawSuccessor)
          memory.writeContextSuffix(context, parent)
          memory.writeSuccessor(pendingStates.pop()!, context)
          parent = context
      } while (pendingStates.length !== 0)
      return parent
  }

  private updateModel(): void {
      const memory = this.arena
      const symbol = memory.readSymbol(this.foundState)

      const suffix = memory.readContextSuffix(this.minContext)
      if (memory.readFrequency(this.foundState) < MAX_FREQ / 4 && suffix !== 0) {
          if (memory.readContextCount(suffix) === 1) {
              const state = memory.inlineState(suffix)
              const frequency = memory.readFrequency(state)
              if (frequency < 32) memory.writeFrequency(state, frequency + 1)
          } else {
              let state = memory.readContextStates(suffix)
              while (memory.readSymbol(state) !== symbol) state += STATE_SIZE
              if (state !== memory.readContextStates(suffix)
                && memory.readFrequency(state) >= memory.readFrequency(state - STATE_SIZE)) {
                  memory.swapStates(state, state - STATE_SIZE)
                  state -= STATE_SIZE
              }
              const frequency = memory.readFrequency(state)
              if (frequency < MAX_FREQ - 9) {
                  memory.writeFrequency(state, frequency + 2)
                  memory.writeContextTotal(suffix, memory.readContextTotal(suffix) + 2)
              }
          }
      }

      if (this.orderFall === 0) {
          const context = this.createSuccessors()
          if (context === 0) return this.restartModel()
          this.maxContext = this.minContext = context
          memory.writeSuccessor(this.foundState, context)
          return
      }

      if (!memory.appendText(symbol)) return this.restartModel()
      let maxSuccessor = memory.text
      let minSuccessor = memory.readSuccessor(this.foundState)
      if (minSuccessor !== 0) {
          if (minSuccessor <= maxSuccessor) {
              minSuccessor = this.createSuccessors()
              if (minSuccessor === 0) return this.restartModel()
          }
          this.orderFall -= 1
          if (this.orderFall === 0) {
              maxSuccessor = minSuccessor
              if (this.maxContext !== this.minContext) memory.rewindText()
          }
      } else {
          memory.writeSuccessor(this.foundState, maxSuccessor)
          minSuccessor = this.minContext
      }

      const oldMinContext = this.minContext
      let context = this.maxContext
      this.maxContext = this.minContext = minSuccessor
      if (context === oldMinContext) return

      const minStateCount = memory.readContextCount(oldMinContext)
      const pureEscapeFrequency = memory.readContextTotal(oldMinContext)
        - minStateCount
        - (memory.readFrequency(this.foundState) - 1)

      do {
          const oldStateCount = memory.readContextCount(context)
          let contextTotal: number
          if (oldStateCount === 1) {
              const states = memory.allocate(0)
              if (states === 0) return this.restartModel()
              memory.copyState(states, memory.inlineState(context))
              memory.writeContextStates(context, states)
              let frequency = memory.readFrequency(states)
              frequency = frequency < MAX_FREQ / 4 - 1 ? frequency * 2 : MAX_FREQ - 4
              memory.writeFrequency(states, frequency)
              contextTotal = frequency + this.initEsc + Number(minStateCount > 3)
          } else {
              if ((oldStateCount & 1) === 0) {
                  const oldUnitCount = oldStateCount >> 1
                  const oldClass = memory.allocationClass(oldUnitCount)
                  if (oldClass !== memory.allocationClass(oldUnitCount + 1)) {
                      const replacement = memory.allocate(oldClass + 1)
                      if (replacement === 0) return this.restartModel()
                      const oldStates = memory.readContextStates(context)
                      memory.copyUnits(replacement, oldStates, oldUnitCount)
                      memory.release(oldStates, oldUnitCount)
                      memory.writeContextStates(context, replacement)
                  }
              }
              contextTotal = memory.readContextTotal(context)
              contextTotal += Number(2 * oldStateCount < minStateCount)
                + 2 * Number(4 * oldStateCount <= minStateCount && contextTotal <= 8 * oldStateCount)
          }

          const state = memory.readContextStates(context) + oldStateCount * STATE_SIZE
          let newFrequency = 2 * (contextTotal + 6) * memory.readFrequency(this.foundState)
          const scale = pureEscapeFrequency + contextTotal
          memory.writeSymbol(state, symbol)
          memory.writeContextCount(context, oldStateCount + 1)
          memory.writeSuccessor(state, maxSuccessor)
          if (newFrequency < 6 * scale) {
              newFrequency = 1 + Number(newFrequency > scale) + Number(newFrequency >= 4 * scale)
              contextTotal += 3
          } else {
              newFrequency = 4
                + Number(newFrequency >= 9 * scale)
                + Number(newFrequency >= 12 * scale)
                + Number(newFrequency >= 15 * scale)
              contextTotal += newFrequency
          }
          memory.writeContextTotal(context, contextTotal)
          memory.writeFrequency(state, newFrequency)
          context = memory.readContextSuffix(context)
      } while (context !== oldMinContext)
  }

  private advanceContext(): void {
      const successor = this.arena.readSuccessor(this.foundState)
      if (this.orderFall === 0 && successor > this.arena.text) {
          this.minContext = this.maxContext = successor
          return
      }
      this.updateModel()
  }

  private updateOtherState(state: number): void {
      const memory = this.arena
      const frequency = memory.readFrequency(state) + 4
      memory.writeFrequency(state, frequency)
      memory.writeContextTotal(this.minContext, memory.readContextTotal(this.minContext) + 4)
      this.foundState = state
      if (frequency > memory.readFrequency(state - STATE_SIZE)) {
          memory.swapStates(state, state - STATE_SIZE)
          this.foundState = state - STATE_SIZE
          if (frequency > MAX_FREQ) this.rescale()
      }
      this.advanceContext()
  }

  private updateFirstState(state: number): void {
      const memory = this.arena
      const frequency = memory.readFrequency(state)
      this.prevSuccess = Number(2 * frequency > memory.readContextTotal(this.minContext))
      this.runLength += this.prevSuccess
      memory.writeContextTotal(this.minContext, memory.readContextTotal(this.minContext) + 4)
      memory.writeFrequency(state, frequency + 4)
      this.foundState = state
      if (frequency + 4 > MAX_FREQ) this.rescale()
      this.advanceContext()
  }

  private updateBinaryState(state: number): void {
      const frequency = this.arena.readFrequency(state)
      this.arena.writeFrequency(state, frequency + Number(frequency < 128))
      this.prevSuccess = 1
      this.runLength += 1
      this.foundState = state
      this.advanceContext()
  }

  private updateMaskedState(state: number): void {
      const memory = this.arena
      const frequency = memory.readFrequency(state) + 4
      this.foundState = state
      memory.writeFrequency(state, frequency)
      memory.writeContextTotal(this.minContext, memory.readContextTotal(this.minContext) + 4)
      if (frequency > MAX_FREQ) this.rescale()
      this.runLength = this.initRL
      this.updateModel()
  }

  private selectSeeContext(maskedCount: number): { index: number; escape: number } {
      const memory = this.arena
      const context = this.minContext
      const stateCount = memory.readContextCount(context)
      if (stateCount === 256) return { index: DUMMY_SEE, escape: 1 }

      const availableCount = stateCount - maskedCount
      const suffixCountDelta = (memory.readContextCount(memory.readContextSuffix(context)) - stateCount) >>> 0
      const index = this.ns2Indx[availableCount - 1] * 16
              + Number(availableCount < suffixCountDelta)
              + 2 * Number(memory.readContextTotal(context) < 11 * stateCount)
              + 4 * Number(maskedCount > availableCount)
              + this.hiBitsFlag
      const estimate = this.seeSumm[index] >>> this.seeShift[index]
      this.seeSumm[index] = (this.seeSumm[index] - estimate) & 0xffff
      return { index, escape: estimate || 1 }
  }

  private seeUpdate(idx: number): void {
      if (this.seeShift[idx] < PERIOD_BITS && --this.seeCount[idx] === 0) {
          this.seeSumm[idx] = (this.seeSumm[idx] << 1) & 0xffff
          this.seeCount[idx] = 3 << this.seeShift[idx]
          this.seeShift[idx]++
      }
  }
  private decodeSymbol(): number {
      const memory = this.arena
      const excluded = new Uint8Array(256)
      excluded.fill(0xff)

      if (memory.readContextCount(this.minContext) !== 1) {
          let state = memory.readContextStates(this.minContext)
          const total = memory.readContextTotal(this.minContext)
          const threshold = this.decoder.threshold(total)
          let remainder = threshold - memory.readFrequency(state)
          if (remainder < 0) {
              this.decoder.decode(0, memory.readFrequency(state))
              const symbol = memory.readSymbol(state)
              this.updateFirstState(state)
              return symbol
          }

          this.prevSuccess = 0
          let statesLeft = memory.readContextCount(this.minContext) - 1
          do {
              state += STATE_SIZE
              remainder -= memory.readFrequency(state)
              if (remainder < 0) {
                  this.decoder.decode(threshold - remainder - memory.readFrequency(state), memory.readFrequency(state))
                  const symbol = memory.readSymbol(state)
                  this.updateOtherState(state)
                  return symbol
              }
          } while (--statesLeft !== 0)
          if (threshold >= total) return -2

          const symbolsTotal = threshold - remainder
          this.decoder.decode(symbolsTotal, total - symbolsTotal)
          this.hiBitsFlag = this.hb2Flag[memory.readSymbol(this.foundState)]
          state = memory.readContextStates(this.minContext)
          for (let index = 0; index < memory.readContextCount(this.minContext); index += 1) {
              excluded[memory.readSymbol(state)] = 0
              state += STATE_SIZE
          }
      } else {
          const state = memory.inlineState(this.minContext)
          this.hiBitsFlag = this.hb2Flag[memory.readSymbol(this.foundState)]
          const suffixCount = memory.readContextCount(memory.readContextSuffix(this.minContext))
          const probabilityIndex = (memory.readFrequency(state) - 1) * 64
                  + this.prevSuccess
                  + this.ns2BSIndx[suffixCount - 1]
                  + this.hiBitsFlag
                  + 2 * this.hb2Flag[memory.readSymbol(state)]
                  + ((this.runLength >> 26) & 0x20)
          const probability = this.binSumm[probabilityIndex]
          const adjustment = (probability + (1 << (PERIOD_BITS - 2))) >>> PERIOD_BITS
          if (!this.decoder.decodeBit(probability)) {
              this.binSumm[probabilityIndex] = (probability + (1 << INT_BITS) - adjustment) & 0xffff
              const symbol = memory.readSymbol(state)
              this.updateBinaryState(state)
              return symbol
          }
          this.binSumm[probabilityIndex] = (probability - adjustment) & 0xffff
          this.initEsc = EXP_ESCAPE[this.binSumm[probabilityIndex] >>> 10]
          excluded[memory.readSymbol(state)] = 0
          this.prevSuccess = 0
      }

      while (true) {
          const maskedCount = memory.readContextCount(this.minContext)
          do {
              this.orderFall++
              const suffix = memory.readContextSuffix(this.minContext)
              if (suffix === 0) return -1
              this.minContext = suffix
          } while (memory.readContextCount(this.minContext) === maskedCount)

          let state = memory.readContextStates(this.minContext)
          let availableTotal = 0
          for (let index = 0; index < memory.readContextCount(this.minContext); index += 1) {
              if (excluded[memory.readSymbol(state)] !== 0) availableTotal += memory.readFrequency(state)
              state += STATE_SIZE
          }

          const see = this.selectSeeContext(maskedCount)
          const rangeTotal = availableTotal + see.escape
          const threshold = this.decoder.threshold(rangeTotal)
          if (threshold < availableTotal) {
              let remainder = threshold
              state = memory.readContextStates(this.minContext)
              while (true) {
                  if (excluded[memory.readSymbol(state)] !== 0) remainder -= memory.readFrequency(state)
                  if (remainder < 0) break
                  state += STATE_SIZE
              }
              this.decoder.decode(threshold - remainder - memory.readFrequency(state), memory.readFrequency(state))
              this.seeUpdate(see.index)
              const symbol = memory.readSymbol(state)
              this.updateMaskedState(state)
              return symbol
          }
          if (threshold >= rangeTotal) return -2

          this.decoder.decode(availableTotal, rangeTotal - availableTotal)
          this.seeSumm[see.index] = (this.seeSumm[see.index] + rangeTotal) & 0xffff
          state = memory.readContextStates(this.minContext)
          for (let index = 0; index < memory.readContextCount(this.minContext); index += 1) {
              excluded[memory.readSymbol(state)] = 0
              state += STATE_SIZE
          }
      }
  }

}

export function parsePpmd7Properties(properties: Uint8Array): { order: number; memorySize: number } {
  if (properties.length !== 5 && properties.length !== 7) throw invalidArchive('PPMd coder properties are malformed')
  const order = properties[0]
  const memorySize = (properties[1] | (properties[2] << 8) | (properties[3] << 16) | (properties[4] << 24)) >>> 0
  if (order < MIN_ORDER || order > MAX_ORDER) throw invalidArchive('PPMd model order is out of range')
  if (memorySize < MIN_MEMORY) throw invalidArchive('PPMd model memory is too small')
  if (memorySize > MAX_MEMORY) throw unsupportedFeature('PPMd model memory exceeds the 256 MiB limit')
  return { order, memorySize }
}

export function decodePpmd7(
  input: Uint8Array,
  properties: Uint8Array,
  expectedSize: number,
  signal?: AbortSignal
): Uint8Array {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw invalidArchive('Invalid PPMd output size')
  const { order, memorySize } = parsePpmd7Properties(properties)
  return new Ppmd7Model(order, memorySize, input, signal).decode(expectedSize)
}
