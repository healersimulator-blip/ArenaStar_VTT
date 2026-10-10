/** Header-only PNG fixture for tests whose injected ImageCodec does not decode pixels. */
export function pngHeaderForTest(
  width = 1,
  height = 1,
  suffix: readonly number[] = [],
): Uint8Array {
  const bytes = new Uint8Array(24 + suffix.length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  writeU32be(bytes, 16, width);
  writeU32be(bytes, 20, height);
  bytes.set(suffix, 24);
  return bytes;
}

function writeU32be(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
