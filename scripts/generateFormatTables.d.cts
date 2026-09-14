// Types for the CommonJS generator, which stays .cjs so npm scripts can run it
// with plain `node` before any build step exists.
export interface FormatCodecs {
  write: string[]
  read: string[]
}

/** A row as the site reads it: what the app itself knows about a format. */
export interface SiteFormat {
  name: string
  extensions: string[]
  compress: boolean
  extract: boolean
  read: boolean
  password: boolean
  split: boolean
  codecs: FormatCodecs
}

/** The same row plus what only the README says about it. */
export interface DocumentedFormat extends SiteFormat {
  encryption: string[]
  readFilters: string[]
  notes: string
}

export interface SiteFormats {
  comment: string
  formats: SiteFormat[]
}

export declare function readFormats(): Promise<DocumentedFormat[]>
export declare function readmeTable(formats: DocumentedFormat[]): string
export declare function siteData(formats: DocumentedFormat[]): SiteFormats
export declare function generate(): Promise<{ formats: DocumentedFormat[]; data: SiteFormats }>
export declare const outputPath: string
export declare const readmePath: string
