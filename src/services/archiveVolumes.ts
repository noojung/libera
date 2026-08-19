import { terminalVolumePath } from './splitZipVolumes'
import { firstVolumePath, isSevenZipVolumePath } from './sevenZipVolumes'

/**
 * The one volume of a set that can actually be opened, whichever volume the
 * user picked. The two formats disagree about which end that is - a ZIP set is
 * read from the terminal `.zip`, a 7z set from `.7z.001` - so every reader
 * goes through this rather than assuming either.
 */
export function canonicalArchivePath(archivePath: string): string {
  return isSevenZipVolumePath(archivePath) ? firstVolumePath(archivePath) : terminalVolumePath(archivePath)
}

/**
 * Extensions read by the ZIP reader. A JAR and a WAR are both ZIP containers
 * with a prescribed layout, so they are listed, previewed, and extracted
 * through exactly the same path.
 */
export function isZipFormatExtension(extension: string): boolean {
  return extension === '.zip' || extension === '.jar' || extension === '.war'
}

/** How a ZIP-family archive is labelled, so a JAR does not just read as ZIP. */
export function zipFormatLabel(extension: string): string {
  if (extension === '.jar') return 'JAR'
  if (extension === '.war') return 'WAR'
  return 'ZIP'
}
