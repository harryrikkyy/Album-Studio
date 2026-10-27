// @ts-check
// exif_date.js: a JPEG's capture time from the EXIF block near its start. Auto-Fill sorts photos
// by it, in the backend as it did in the Electron app.
'use strict'

// Tiny, dependency-free JPEG EXIF parser. Reads a buffer (the first ~256 KB of
// a JPEG is plenty — EXIF lives in the APP1 marker right after SOI), finds tag
// 0x9003 (DateTimeOriginal), parses "YYYY:MM:DD HH:MM:SS" → epoch ms, or null.
// Byte math only (no Buffer methods) so it accepts the bare Uint8Array the
// bundled renderer gets from the preload bridge; node Buffers still work
// (Buffer IS a Uint8Array). Out-of-range reads yield NaN and fall through to
// the null returns, which is stricter than Buffer's throwing reads.
/** @param {Uint8Array} buf @returns {number | null} */
function parseExifDateFromBuffer(buf) {
    const ascii = (/** @type {number} */ start, /** @type {number} */ end) => {
        let str = '';
        for (let i = start; i < end && i < buf.length; i++) str += String.fromCharCode(buf[i]);
        return str;
    };
    const be16 = (/** @type {number} */ p) => (buf[p] << 8) | buf[p + 1];
    const le16 = (/** @type {number} */ p) => buf[p] | (buf[p + 1] << 8);
    const be32 = (/** @type {number} */ p) => (((buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]) >>> 0);
    const le32 = (/** @type {number} */ p) => ((buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0);

    // JPEG SOI must be 0xFFD8
    if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
    let off = 2;
    while (off < buf.length - 8) {
        if (buf[off] !== 0xFF) return null;
        const marker = buf[off + 1];
        const size = be16(off + 2);
        // APP1 (0xE1) holds EXIF.
        if (marker === 0xE1) {
            // EXIF\0\0 magic
            if (ascii(off + 4, off + 10) === 'Exif\u0000\u0000') {
                const tiff = off + 10;
                const little = ascii(tiff, tiff + 2) === 'II';
                const u16 = (/** @type {number} */ p) => little ? le16(p) : be16(p);
                const u32 = (/** @type {number} */ p) => little ? le32(p) : be32(p);
                const ifd0 = tiff + u32(tiff + 4);
                const numEntries = u16(ifd0);
                let exifIfd = 0;
                for (let i = 0; i < numEntries; i++) {
                    const e = ifd0 + 2 + i * 12;
                    if (u16(e) === 0x8769) { exifIfd = tiff + u32(e + 8); break; }
                }
                if (!exifIfd) return null;
                const n2 = u16(exifIfd);
                for (let i = 0; i < n2; i++) {
                    const e = exifIfd + 2 + i * 12;
                    if (u16(e) === 0x9003) { // DateTimeOriginal
                        const valOff = tiff + u32(e + 8);
                        const str = ascii(valOff, valOff + 19);
                        // "YYYY:MM:DD HH:MM:SS"
                        const m = str.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
                        if (!m) return null;
                        return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).getTime();
                    }
                }
                return null;
            }
        }
        off += 2 + size;
    }
    return null;
}

module.exports = { parseExifDateFromBuffer }
