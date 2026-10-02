//! The two encryption schemes a ZIP entry can carry: PKWARE's traditional
//! stream cipher, which every reader knows and which is weak, and WinZip's
//! AES, which is what anything worth protecting should use.

use std::io::{self, Read, Write};

use aes::cipher::{BlockCipherEncrypt, KeyInit};
use aes::{Aes128, Aes192, Aes256};
use hmac::{Hmac, Mac};
use sha1::Sha1;

use crate::LiberaError;

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut index = 0;
    while index < 256 {
        let mut value = index as u32;
        let mut bit = 0;
        while bit < 8 {
            value = if value & 1 != 0 { 0xedb8_8320 ^ (value >> 1) } else { value >> 1 };
            bit += 1;
        }
        table[index] = value;
        index += 1;
    }
    table
}

const CRC_TABLE: [u32; 256] = crc_table();

fn crc_step(crc: u32, byte: u8) -> u32 {
    CRC_TABLE[((crc ^ u32::from(byte)) & 0xff) as usize] ^ (crc >> 8)
}

/// The three keys of the traditional cipher, which the password seeds and
/// every plaintext byte then advances.
#[derive(Clone)]
pub(crate) struct ZipCryptoKeys([u32; 3]);

/// The 12 random-looking bytes ahead of a traditionally encrypted entry. The
/// last one repeats a byte the reader can check, which is how a wrong
/// password is caught - 255 times in 256.
pub(crate) const ZIP_CRYPTO_HEADER_LENGTH: usize = 12;

impl ZipCryptoKeys {
    pub(crate) fn new(password: &[u8]) -> Self {
        let mut keys = Self([0x1234_5678, 0x2345_6789, 0x3456_7890]);
        for &byte in password {
            keys.update(byte);
        }
        keys
    }

    fn update(&mut self, plain: u8) {
        let [k0, k1, k2] = &mut self.0;
        *k0 = crc_step(*k0, plain);
        *k1 = k1.wrapping_add(*k0 & 0xff).wrapping_mul(134_775_813).wrapping_add(1);
        *k2 = crc_step(*k2, (*k1 >> 24) as u8);
    }

    fn stream_byte(&self) -> u8 {
        let temp = (self.0[2] | 2) as u16;
        (temp.wrapping_mul(temp ^ 1) >> 8) as u8
    }

    fn decrypt(&mut self, buffer: &mut [u8]) {
        for byte in buffer {
            let plain = *byte ^ self.stream_byte();
            self.update(plain);
            *byte = plain;
        }
    }

    fn encrypt(&mut self, buffer: &mut [u8]) {
        for byte in buffer {
            let plain = *byte;
            *byte = plain ^ self.stream_byte();
            self.update(plain);
        }
    }
}

/// The error a decrypting reader fails with, carried through `io::Error` so
/// it comes back out as itself.
fn wrong_password() -> io::Error {
    LiberaError::WrongPassword.into()
}

pub(crate) struct ZipCryptoReader<R> {
    inner: R,
    keys: ZipCryptoKeys,
}

impl<R: Read> ZipCryptoReader<R> {
    /// Reads and checks the header. `check_byte` is the high byte of the CRC,
    /// or of the DOS time for an entry whose CRC follows its data.
    pub(crate) fn new(mut inner: R, password: &[u8], check_byte: u8) -> io::Result<Self> {
        let mut keys = ZipCryptoKeys::new(password);
        let mut header = [0; ZIP_CRYPTO_HEADER_LENGTH];
        inner.read_exact(&mut header)?;
        keys.decrypt(&mut header);
        if header[ZIP_CRYPTO_HEADER_LENGTH - 1] != check_byte {
            return Err(wrong_password());
        }
        Ok(Self { inner, keys })
    }
}

impl<R: Read> Read for ZipCryptoReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buf)?;
        self.keys.decrypt(&mut buf[..read]);
        Ok(read)
    }
}

pub(crate) struct ZipCryptoWriter<W> {
    inner: W,
    keys: ZipCryptoKeys,
    buffer: Vec<u8>,
}

impl<W: Write> ZipCryptoWriter<W> {
    pub(crate) fn new(mut inner: W, password: &[u8], check_byte: u8) -> io::Result<Self> {
        let mut keys = ZipCryptoKeys::new(password);
        let mut header = [0; ZIP_CRYPTO_HEADER_LENGTH];
        getrandom::fill(&mut header[..ZIP_CRYPTO_HEADER_LENGTH - 1]).map_err(io::Error::other)?;
        header[ZIP_CRYPTO_HEADER_LENGTH - 1] = check_byte;
        keys.encrypt(&mut header);
        inner.write_all(&header)?;
        Ok(Self { inner, keys, buffer: Vec::new() })
    }

    pub(crate) fn finish(self) -> io::Result<W> {
        Ok(self.inner)
    }
}

impl<W: Write> Write for ZipCryptoWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.buffer.clear();
        self.buffer.extend_from_slice(buf);
        self.keys.encrypt(&mut self.buffer);
        self.inner.write_all(&self.buffer)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// WinZip AES key sizes, numbered as its extra field numbers them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AesStrength {
    Aes128 = 1,
    Aes192 = 2,
    Aes256 = 3,
}

impl AesStrength {
    pub(crate) fn from_code(code: u8) -> Option<Self> {
        match code {
            1 => Some(Self::Aes128),
            2 => Some(Self::Aes192),
            3 => Some(Self::Aes256),
            _ => None,
        }
    }

    fn key_length(self) -> usize {
        match self {
            Self::Aes128 => 16,
            Self::Aes192 => 24,
            Self::Aes256 => 32,
        }
    }

    pub(crate) fn salt_length(self) -> usize {
        self.key_length() / 2
    }
}

const PASSWORD_VERIFIER_LENGTH: usize = 2;
pub(crate) const AES_AUTHENTICATION_LENGTH: usize = 10;
const KEY_DERIVATION_ROUNDS: u32 = 1000;

/// The bytes AES adds around an entry's data: salt and verifier in front,
/// the authentication code behind.
pub(crate) fn aes_overhead(strength: AesStrength) -> u64 {
    (strength.salt_length() + PASSWORD_VERIFIER_LENGTH + AES_AUTHENTICATION_LENGTH) as u64
}

enum AesCipher {
    Aes128(Box<Aes128>),
    Aes192(Box<Aes192>),
    Aes256(Box<Aes256>),
}

/// AES in counter mode as WinZip runs it: a little-endian block counter that
/// starts at one.
struct AesCtr {
    cipher: AesCipher,
    counter: u128,
    keystream: [u8; 16],
    used: usize,
}

impl AesCtr {
    fn new(strength: AesStrength, key: &[u8]) -> Self {
        let cipher = match strength {
            AesStrength::Aes128 => AesCipher::Aes128(Box::new(Aes128::new_from_slice(key).expect("key length"))),
            AesStrength::Aes192 => AesCipher::Aes192(Box::new(Aes192::new_from_slice(key).expect("key length"))),
            AesStrength::Aes256 => AesCipher::Aes256(Box::new(Aes256::new_from_slice(key).expect("key length"))),
        };
        Self { cipher, counter: 0, keystream: [0; 16], used: 16 }
    }

    fn apply(&mut self, buffer: &mut [u8]) {
        for byte in buffer {
            if self.used == 16 {
                self.counter = self.counter.wrapping_add(1);
                let mut block = self.counter.to_le_bytes().into();
                match &self.cipher {
                    AesCipher::Aes128(cipher) => cipher.encrypt_block(&mut block),
                    AesCipher::Aes192(cipher) => cipher.encrypt_block(&mut block),
                    AesCipher::Aes256(cipher) => cipher.encrypt_block(&mut block),
                }
                self.keystream = block.into();
                self.used = 0;
            }
            *byte ^= self.keystream[self.used];
            self.used += 1;
        }
    }
}

type HmacSha1 = Hmac<Sha1>;

/// The encryption key, the authentication key, and the two-byte verifier, all
/// drawn from one PBKDF2 run over the password and the entry's salt.
fn derive_keys(strength: AesStrength, password: &[u8], salt: &[u8]) -> (AesCtr, HmacSha1, [u8; 2]) {
    let key_length = strength.key_length();
    let mut derived = vec![0; key_length * 2 + PASSWORD_VERIFIER_LENGTH];
    pbkdf2::pbkdf2_hmac::<Sha1>(password, salt, KEY_DERIVATION_ROUNDS, &mut derived);
    let ctr = AesCtr::new(strength, &derived[..key_length]);
    let mac = HmacSha1::new_from_slice(&derived[key_length..key_length * 2]).expect("any key length");
    (ctr, mac, [derived[key_length * 2], derived[key_length * 2 + 1]])
}

/// Decrypts one AES entry. `inner` yields exactly the entry's stored bytes;
/// the authentication code at their end is checked once the data runs out,
/// so a reader that reaches the end has read data nobody tampered with.
pub(crate) struct AesReader<R> {
    inner: R,
    ctr: AesCtr,
    mac: Option<HmacSha1>,
    remaining: u64,
}

impl<R: Read> AesReader<R> {
    pub(crate) fn new(mut inner: R, password: &[u8], strength: AesStrength, stored_length: u64) -> io::Result<Self> {
        let data_length = stored_length
            .checked_sub(aes_overhead(strength))
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "an AES entry is shorter than its own header"))?;
        let mut salt = vec![0; strength.salt_length()];
        inner.read_exact(&mut salt)?;
        let mut verifier = [0; PASSWORD_VERIFIER_LENGTH];
        inner.read_exact(&mut verifier)?;
        let (ctr, mac, expected) = derive_keys(strength, password, &salt);
        if verifier != expected {
            return Err(wrong_password());
        }
        Ok(Self { inner, ctr, mac: Some(mac), remaining: data_length })
    }

    fn authenticate(&mut self) -> io::Result<()> {
        let Some(mac) = self.mac.take() else { return Ok(()) };
        let mut code = [0; AES_AUTHENTICATION_LENGTH];
        self.inner.read_exact(&mut code)?;
        let expected = mac.finalize().into_bytes();
        // Two passwords that share a verifier get this far 1 time in 65536,
        // and the data then fails to authenticate.
        if expected[..AES_AUTHENTICATION_LENGTH] != code { Err(wrong_password()) } else { Ok(()) }
    }
}

impl<R: Read> Read for AesReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            self.authenticate()?;
            return Ok(0);
        }
        let limit = buf.len().min(usize::try_from(self.remaining).unwrap_or(usize::MAX));
        let read = self.inner.read(&mut buf[..limit])?;
        if read == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "an AES entry ends before its data does"));
        }
        if let Some(mac) = &mut self.mac {
            mac.update(&buf[..read]);
        }
        self.ctr.apply(&mut buf[..read]);
        self.remaining -= read as u64;
        Ok(read)
    }
}

pub(crate) struct AesWriter<W> {
    inner: W,
    ctr: AesCtr,
    mac: HmacSha1,
    buffer: Vec<u8>,
}

impl<W: Write> AesWriter<W> {
    pub(crate) fn new(mut inner: W, password: &[u8], strength: AesStrength) -> io::Result<Self> {
        let mut salt = vec![0; strength.salt_length()];
        getrandom::fill(&mut salt).map_err(io::Error::other)?;
        let (ctr, mac, verifier) = derive_keys(strength, password, &salt);
        inner.write_all(&salt)?;
        inner.write_all(&verifier)?;
        Ok(Self { inner, ctr, mac, buffer: Vec::new() })
    }

    pub(crate) fn finish(mut self) -> io::Result<W> {
        let code = self.mac.finalize().into_bytes();
        self.inner.write_all(&code[..AES_AUTHENTICATION_LENGTH])?;
        Ok(self.inner)
    }
}

impl<W: Write> Write for AesWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.buffer.clear();
        self.buffer.extend_from_slice(buf);
        self.ctr.apply(&mut self.buffer);
        self.mac.update(&self.buffer);
        self.inner.write_all(&self.buffer)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_the_traditional_cipher_and_catches_a_wrong_password() {
        let mut writer = ZipCryptoWriter::new(Vec::new(), b"hunter2", 0xab).unwrap();
        writer.write_all(b"classified").unwrap();
        let encrypted = writer.finish().unwrap();
        assert_eq!(encrypted.len(), ZIP_CRYPTO_HEADER_LENGTH + 10);

        let mut plain = String::new();
        ZipCryptoReader::new(encrypted.as_slice(), b"hunter2", 0xab).unwrap().read_to_string(&mut plain).unwrap();
        assert_eq!(plain, "classified");
        let error = ZipCryptoReader::new(encrypted.as_slice(), b"wrong", 0xab).err().unwrap();
        assert!(matches!(LiberaError::from(error), LiberaError::WrongPassword));
    }

    #[test]
    fn round_trips_through_every_aes_strength_and_authenticates_the_data() {
        for strength in [AesStrength::Aes128, AesStrength::Aes192, AesStrength::Aes256] {
            let plain: Vec<u8> = (0..1000u32).map(|value| value as u8).collect();
            let mut writer = AesWriter::new(Vec::new(), b"hunter2", strength).unwrap();
            writer.write_all(&plain).unwrap();
            let encrypted = writer.finish().unwrap();
            assert_eq!(encrypted.len() as u64, plain.len() as u64 + aes_overhead(strength));

            let mut decrypted = Vec::new();
            AesReader::new(encrypted.as_slice(), b"hunter2", strength, encrypted.len() as u64)
                .unwrap()
                .read_to_end(&mut decrypted)
                .unwrap();
            assert_eq!(decrypted, plain, "{strength:?}");

            let wrong = AesReader::new(encrypted.as_slice(), b"wrong", strength, encrypted.len() as u64).err().unwrap();
            assert!(matches!(LiberaError::from(wrong), LiberaError::WrongPassword));

            let mut tampered = encrypted.clone();
            let middle = tampered.len() / 2;
            tampered[middle] ^= 1;
            let mut sink = Vec::new();
            let result = AesReader::new(tampered.as_slice(), b"hunter2", strength, tampered.len() as u64)
                .unwrap()
                .read_to_end(&mut sink);
            assert!(result.is_err(), "{strength:?}");
        }
    }

    /// The first block of WinZip's own counter mode, worked out from FIPS-197:
    /// AES-128 under the all-zero key, applied to the counter value 1.
    #[test]
    fn counts_blocks_little_endian_from_one_as_winzip_does() {
        let mut ctr = AesCtr::new(AesStrength::Aes128, &[0; 16]);
        let mut block = [0u8; 16];
        ctr.apply(&mut block);
        let mut expected = 1u128.to_le_bytes().into();
        Aes128::new_from_slice(&[0; 16]).unwrap().encrypt_block(&mut expected);
        assert_eq!(block, <[u8; 16]>::from(expected));
    }
}
