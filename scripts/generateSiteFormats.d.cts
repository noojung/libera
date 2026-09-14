// Types for the CommonJS generator, which stays .cjs so npm scripts can run it
// with plain `node` before any build step exists.
export interface SiteFormatCodecs {
  write: string[]
  read: string[]
}

export interface SiteFormat {
  name: string
  extensions: string[]
  compress: boolean
  extract: boolean
  read: boolean
  password: boolean
  split: boolean
  codecs: SiteFormatCodecs
}

export interface SiteFormats {
  comment: string
  formats: SiteFormat[]
}

export declare function generate(): Promise<SiteFormats>
export declare const outputPath: string
