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
