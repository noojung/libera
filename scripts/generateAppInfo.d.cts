// Types for the CommonJS generator, which stays .cjs so npm scripts can run it
// with plain `node` before any build step exists.
export interface AppInfo {
  version: string
  homepage: string
  repositoryUrl: string
  copyrightYear: string
  copyrightHolder: string
}

export declare function generate(): AppInfo
export declare const outputPath: string
