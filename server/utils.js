import { createHash } from 'crypto';

export function round2(v) { return Math.round(v * 100) / 100; }

export function round3(v) { return v != null && !isNaN(v) ? Math.round(v * 1000) / 1000 : ''; }

export function round4(v) { return Math.round(v * 10000) / 10000; }

export function hashPassword(password, JWT_SECRET) {
  return createHash('sha256').update(password + JWT_SECRET).digest('hex');
}

export function encodeVarintField(fieldNum, value) {
  const buf = [];
  let tag = (fieldNum << 3) | 0;
  while (tag > 0x7f) { buf.push((tag & 0x7f) | 0x80); tag >>>= 7; }
  buf.push(tag);
  let v = value;
  while (v > 0x7f) { buf.push((v & 0x7f) | 0x80); v >>>= 7; }
  buf.push(v);
  return Buffer.from(buf);
}

export function buildProtoHeader({ pdata, cmd_func, cmd_id, need_ack, seq }) {
  let inner = pdata ? Buffer.concat([
    encodeVarintField(1, pdata.length), pdata
  ]) : Buffer.alloc(0);
  inner = Buffer.concat([
    inner,
    encodeVarintField(8, cmd_func || 254),
    encodeVarintField(9, cmd_id || 17),
    need_ack ? encodeVarintField(11, 1) : Buffer.alloc(0),
    encodeVarintField(14, seq || Math.floor(Date.now() / 1000) % 100000),
    encodeVarintField(2, 32),
    encodeVarintField(3, 2),
    encodeVarintField(16, 3),
    encodeVarintField(17, 1),
  ]);
  return inner;
}

export function wrapHeaderMessage(header) {
  return Buffer.concat([encodeVarintField(1, header.length), header]);
}
