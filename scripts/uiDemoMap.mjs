import { deflateSync } from "node:zlib";
/** Original, deterministic courtyard artwork. No external assets or image toolchain required. */
export function uiDemoMap() {
  const width = 1400, height = 900;
  const pixels = Buffer.alloc(width * height * 4);
  const set = (x, y, color) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (Math.floor(y) * width + Math.floor(x)) * 4;
    pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2]; pixels[i + 3] = 255;
  };
  const rect = (x, y, w, h, color) => {
    for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++)
      for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx++) set(xx, yy, color);
  };
  const circle = (cx, cy, radius, color) => {
    for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++)
      if (x * x + y * y <= radius * radius) set(cx + x, cy + y, color);
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const n = ((Math.imul(x / 3 | 0, 37) ^ Math.imul(y / 3 | 0, 19)) & 7);
    set(x, y, [27 + n, 41 + n, 39 + n]);
  }
  // Enclosing buildings and an open, worn stone courtyard.
  rect(95, 100, 1210, 715, [17, 23, 27]);
  rect(110, 115, 1180, 685, [91, 89, 79]);
  for (let y = 128; y < 788; y += 46) for (let x = 122; x < 1280; x += 66) {
    const n = ((x * 13 + y * 23) % 19);
    rect(x, y, 62, 42, [66 + n, 76 + n, 73 + n]);
    rect(x + 1, y + 1, 59, 1, [96 + n, 107 + n, 102 + n]);
  }
  const room = (x, y, w, h) => {
    rect(x + 8, y + 10, w, h, [22, 29, 30]);
    rect(x, y, w, h, [43, 44, 38]); rect(x + 9, y + 9, w - 18, h - 18, [118, 107, 83]);
    rect(x + 21, y + 21, w - 42, h - 42, [54, 56, 48]);
    for (let yy = y + 24; yy < y + h - 23; yy += 15) rect(x + 22, yy, w - 44, 2, [70, 69, 54]);
    rect(x + w / 2 - 32, y + h - 24, 64, 25, [73, 63, 46]);
  };
  room(90, 80, 300, 205); room(1000, 80, 305, 205); room(90, 610, 305, 205); room(1000, 610, 305, 205);
  // Fountain, copper trim, water rings and a low plinth.
  circle(700, 450, 124, [35, 48, 48]); circle(700, 440, 116, [119, 110, 83]);
  circle(700, 440, 100, [35, 57, 63]); circle(700, 440, 81, [46, 84, 88]);
  circle(700, 440, 58, [49, 92, 94]); circle(700, 440, 28, [146, 139, 108]);
  circle(700, 432, 20, [74, 91, 84]);
  for (const [x, y] of [[455, 228], [945, 228], [455, 650], [945, 650]]) {
    rect(x - 36, y - 23, 72, 46, [35, 37, 32]); rect(x - 30, y - 19, 60, 34, [107, 97, 68]);
    circle(x, y - 6, 29, [43, 69, 50]); circle(x - 12, y - 11, 18, [62, 91, 61]); circle(x + 11, y - 4, 17, [53, 81, 53]);
  }
  for (const [x, y] of [[205, 322], [205, 566], [1195, 322], [1195, 566]]) {
    circle(x, y, 24, [104, 83, 47]); circle(x, y, 15, [193, 137, 53]); circle(x, y, 7, [255, 216, 133]);
  }
  // Gate approach and steps.
  for (let i = 0; i < 5; i++) rect(590 - i * 12, 752 + i * 20, 220 + i * 24, 15, [100 - i * 6, 99 - i * 6, 85 - i * 5]);
  return { width, height, bytes: encodePng(width, height, pixels) };
}

export function encodePng(width, height, pixels) {
  const scan = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) pixels.copy(scan, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const crc = (buffer) => {
    let value = 0xffffffff;
    for (const byte of buffer) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const kind = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([kind, data])));
    return Buffer.concat([length, kind, data, checksum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(scan)), chunk("IEND", Buffer.alloc(0))]);
}

/** Original compact token portraits; alpha outside the rim prevents missing-texture markers. */
export function uiDemoPortrait(index) {
  const size = 96, pixels = Buffer.alloc(size * size * 4);
  const dot = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const p = (y * size + x) * 4;
    for (let k = 0; k < 3; k++) pixels[p + k] = c[k];
    pixels[p + 3] = 255;
  };
  const ellipse = (cx, cy, rx, ry, c) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
      if ((x-cx)**2/rx**2 + (y-cy)**2/ry**2 <= 1) dot(x,y,c);
  };
  const colors = [[87,154,162],[108,148,85],[158,113,81]];
  ellipse(48,48,47,47,[17,29,38]); ellipse(48,48,44,44,colors[index]);
  ellipse(48,48,40,40,[32,45,53]); ellipse(48,75,30,22,colors[index]);
  ellipse(48,38,23,26,index===0?[206,204,180]:[54,48,40]);
  ellipse(48,42,17,22,[208,160,117]);
  if(index===2){ ellipse(48,26,24,13,[142,151,143]); for(let y=37;y<45;y++)for(let x=27;x<69;x++)dot(x,y,[53,64,64]); }
  else { ellipse(42,38,2,2,[40,40,35]); ellipse(55,38,2,2,[40,40,35]); }
  return encodePng(size,size,pixels);
}
