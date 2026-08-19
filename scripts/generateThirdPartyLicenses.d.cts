// Types for the CommonJS generator, which stays .cjs so npm scripts can run it
// with plain `node` before any build step exists.
export interface ThirdPartyLicense {
  name: string
  version: string
  license: string
  text: string
}

export declare function generate(): ThirdPartyLicense[]
export declare const outputPath: string
