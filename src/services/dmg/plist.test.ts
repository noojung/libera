import { describe, expect, it } from 'vitest'
import { parsePlist } from './plist'

describe('property list parser', () => {
  it('reads the values a UDIF resource map uses', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0"><dict>
        <!-- a comment <dict> that is not markup -->
        <key>name</key><string>disk image (Apple_HFS : 4) &amp; &lt;more&gt; &#x41;&#66;</string>
        <key>data</key><data>
          aGVs
          bG8=
        </data>
        <key>list</key><array><integer>-5</integer><real>1.5</real><true/><false/><string/><dict/></array>
      </dict></plist>`
    expect(parsePlist(xml)).toEqual({
      name: 'disk image (Apple_HFS : 4) & <more> AB',
      data: new Uint8Array(Buffer.from('hello')),
      list: [-5, 1.5, true, false, '', {}]
    })
  })

  it('keeps keys such as __proto__ as plain data', () => {
    const parsed = parsePlist('<plist><dict><key>__proto__</key><string>x</string></dict></plist>') as Record<string, unknown>
    expect(Object.getPrototypeOf(parsed)).toBeNull()
    expect(parsed.__proto__).toBe('x')
  })

  it('rejects malformed and deeply nested documents', () => {
    expect(() => parsePlist('<dict></dict>')).toThrow('not a property list')
    expect(() => parsePlist('<plist><dict><key>a</key>')).toThrow('truncated property list')
    expect(() => parsePlist('<plist><dict><string>a</string></dict></plist>')).toThrow('malformed property list')
    expect(() => parsePlist('<plist><date>2026</date></plist>')).toThrow('unexpected property list element')
    expect(() => parsePlist(`<plist>${'<array>'.repeat(40)}${'</array>'.repeat(40)}</plist>`)).toThrow('malformed property list')
  })
})
