// Protobuf decoding for EcoFlow Stream MQTT messages
// Field name mapping added inline — no .proto file needed.

const HEADER_PROTO = `
syntax = "proto3";
message Header {
  optional bytes pdata = 1;
  optional int32 src = 2;
  optional int32 dest = 3;
  optional int32 d_src = 4;
  optional int32 d_dest = 5;
  optional int32 enc_type = 6;
  optional int32 check_type = 7;
  optional int32 cmd_func = 8;
  optional int32 cmd_id = 9;
  optional int32 data_len = 10;
  optional int32 need_ack = 11;
  optional int32 is_ack = 12;
  optional int32 seq = 14;
  optional int32 product_id = 15;
  optional int32 version = 16;
  optional int32 payload_ver = 17;
}
message HeaderMessage {
  repeated Header header = 1;
}
`;

import protobuf from 'protobufjs';

let HeaderMessage;

try {
  const root = protobuf.parse(HEADER_PROTO).root;
  HeaderMessage = root.lookupType('HeaderMessage');
} catch (e) {
  console.error('Failed to parse protobuf schema:', e.message);
}

// XOR decrypt pdata with seq
function xorDecrypt(buffer, seq) {
  const key = seq & 0xFF;
  return Buffer.from(buffer.map(b => b ^ key));
}

// Decode a raw MQTT payload into { field_num: value, ... }
export function decodeMqttPayload(rawBuffer) {
  if (!HeaderMessage) return null;

  try {
    const outer = HeaderMessage.decode(rawBuffer);
    const obj = HeaderMessage.toObject(outer, { defaults: false });

    if (!obj.header || obj.header.length === 0) return null;
    const hdr = obj.header[0];
    if (!hdr.pdata || hdr.pdata.length === 0) return null;

    let pdata = Buffer.from(hdr.pdata);

    // XOR decrypt if enc_type == 1
    if (hdr.encType === 1 && hdr.seq) {
      pdata = xorDecrypt(pdata, hdr.seq);
    }

    if (pdata.length === 0) return null;

    // Parse inner protobuf — we decode field-by-field generically
    const result = {};
    let pos = 0;
    while (pos < pdata.length) {
      const { field, wireType, nextPos } = readTag(pdata, pos);
      if (field === null) break;
      pos = nextPos;

      if (wireType === 0) { // varint
        const { value, nextPos: np } = readVarint(pdata, pos);
        result[field] = value;
        pos = np;
      } else if (wireType === 2) { // length-delimited
        const { value: len, nextPos: np1 } = readVarint(pdata, pos);
        if (len > 65536) break;
        const bytes = pdata.slice(np1, np1 + len);
        // Try UTF-8 string first; if fails, interpret as sub-message
        try {
          result[field] = bytes.toString('utf-8');
        } catch {
          // Could be nested message — skip for now
          result[field] = bytes.toString('hex');
        }
        pos = np1 + len;
      } else if (wireType === 5) { // 32-bit float
        if (pos + 4 <= pdata.length) {
          result[field] = Math.round(pdata.readFloatLE(pos) * 100) / 100;
          pos += 4;
        } else {
          break;
        }
      } else {
        break; // unknown wire type
      }
    }

    return result;
  } catch (e) {
    // silence decode errors for unknown message types
    return null;
  }
}

function readTag(buffer, pos) {
  if (pos >= buffer.length) return { field: null, wireType: null, nextPos: pos };
  const { value: tag, nextPos } = readVarint(buffer, pos);
  return { field: tag >> 3, wireType: tag & 7, nextPos };
}

function readVarint(buffer, pos) {
  let result = 0;
  let shift = 0;
  while (pos < buffer.length) {
    const byte = buffer[pos++];
    result |= (byte & 0x7F) << shift;
    if (!(byte & 0x80)) return { value: result, nextPos: pos };
    shift += 7;
  }
  return { value: result, nextPos: pos };
}
