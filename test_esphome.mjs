import { connect } from 'net';
import { createHash, diffieHellman, generateKeyPairSync, createCipheriv, createDecipheriv, createHmac } from 'crypto';

const ip = '192.168.150.202';
const key = Buffer.from('oirElGgHcLv0IBKDZkTp0E/p7OKow6DF+4levHF2dj0=', 'base64');

function v(n) { const b = []; while (n > 0x7f) { b.push((n & 0x7f) | 0x80); n >>>= 7; } b.push(n); return Buffer.from(b); }

// Generate ephemeral keypair
const eph = generateKeyPairSync('x25519');
const ephPriv = eph.privateKey.export({ format: 'der', type: 'pkcs8' }).slice(-32);
const ephPub = eph.publicKey.export({ format: 'der', type: 'spki' }).slice(-32);

// Test: Send 0x01 indicator + noise handshake
const initialMsg = Buffer.concat([Buffer.from([0x01]), ephPub]); // indicator 0x01 + 32-byte key
console.log('Sending Noise handshake (indicator 0x01):', initialMsg.toString('hex'));

const sock = connect({ host: ip, port: 6053 }, () => {
  console.log('Connected, sending handshake...');
  sock.write(initialMsg);
});

let buf = Buffer.alloc(0);
sock.on('data', (data) => {
  buf = Buffer.concat([buf, data]);
  console.log('Received', data.length, 'bytes:', data.toString('hex').substring(0, 200));
  
  // After handshake, expect encrypted frames
  if (buf.length >= 64) {
    console.log('Handshake response received, starting encryption...');
    
    // Server sends: e + encrypted payload
    const serverEphPub = buf.slice(0, 32);
    console.log('Server eph pub:', serverEphPub.toString('hex'));
    
    // DH between ephemerals
    const dhEE = diffieHellman({ privateKey: ephPriv, publicKey: serverEphPub });
    
    // Derive keys from protocol name
    let ck = createHash('sha256').update('Noise_XX_25519_ChaChaPoly_SHA256').digest();
    const h1 = createHmac('sha256', ck).update(dhEE).digest();
    ck = createHmac('sha256', h1).update(Buffer.from([0x01])).digest();
    const encryptKey = createHmac('sha256', h1).update(Buffer.from([0x02])).digest();
    
    console.log('HKDF complete. Trying to send encrypted HelloRequest...');
    
    // Now send encrypted HelloRequest
    // Frame: varint length, then encrypted(type + protobuf payload)
    const helloProto = Buffer.concat([
      v((1 << 3) | 2), v(9), Buffer.from('ecoflow-mon'),  // string field 1 = "ecoflow-mon"
      v((2 << 3) | 0), v(1),  // varint field 2 = 1
      v((3 << 3) | 0), v(9),  // varint field 3 = 9
    ]);
    const plainMsg = Buffer.concat([Buffer.from([0x01]), helloProto]); // type 1 = HelloRequest
    
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(0, 4);
    const cipher = createCipheriv('chacha20-poly1305', encryptKey, nonce, { authTagLength: 16 });
    const encrypted = Buffer.concat([cipher.update(plainMsg), cipher.final(), cipher.getAuthTag()]);
    const frame = Buffer.concat([v(encrypted.length), encrypted]);
    
    console.log('Sending encrypted frame:', frame.toString('hex').substring(0, 80));
    sock.write(frame);
  }
  
  // Read response
  try {
    let pos = 0;
    while (pos < buf.length) {
      let frameLen = 0, shift = 0;
      let start = pos;
      while (pos < buf.length) {
        const b = buf[pos++];
        frameLen |= (b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
      }
      if (pos + frameLen > buf.length) { pos = start; break; }
      const frame = buf.slice(pos, pos + frameLen);
      pos += frameLen;
      console.log('Response frame (' + frameLen + ' bytes):', frame.toString('hex').substring(0, 100));
    }
  } catch(e) { console.log('Parse error:', e.message); }
});

sock.on('error', (e) => console.log('Error:', e.message));
sock.on('close', () => console.log('Closed'));
setTimeout(() => { sock.end(); process.exit(0); }, 5000);
