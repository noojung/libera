// One file - `hello from libera\n` - wrapped by each codec that can carry a
// lone file. Built with the reference `gzip`, `xz`, `bzip2` and `zstd` tools,
// so the readers are held to what those write.

export const SINGLE_FILE_TEXT = 'hello from libera\n'

export const A_TXT_GZ = [
  'H4sICCZVp2oCA2EudHh0AMtIzcnJV0grys9VyMlMSi1K5AIAqv1jshIAAAA='
].join('')

export const A_TXT_XZ = [
  '/Td6WFoAAATm1rRGBMAWEiEBHAAAAAAAAAAAAG7BVYkBABFoZWxsbyBmcm9tIGxpYmVyYQoAAADk0hB7fbxVsgABMhISkE8+',
  'H7bzfQEAAAAABFla'
].join('')

export const A_TXT_BZ2 = [
  'QlpoOTFBWSZTWXWtS9IAAARRgAAQQAAzZpAAIAAim1A9PShA0DQQQG3EK6ep8XckU4UJB1rUvSA='
].join('')

export const A_TXT_ZST = [
  'KLUv/SQSkQAAaGVsbG8gZnJvbSBsaWJlcmEKwJZW6A=='
].join('')
