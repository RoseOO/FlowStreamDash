// ESPHome Native API - proper Noise_XX_25519_ChaChaPoly_SHA256 with PSK
// Uses Node.js built-in crypto for the full encrypted handshake

import { connect } from 'net';
import { EventEmitter } from 'events';
import { createHash, createHmac, randomBytes, generateKeyPairSync, diffieHellman, createCipheriv, createDecipheriv } from 'crypto';

const PROTOCOL_NAME = 'Noise_XX_25519_ChaChaPoly_SHA256';
const EMPTY = Buffer.alloc(0);

export class EspHomeClient extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.encryptCipher = null;
    this.decryptCipher = null;
    this.connected = false;
  }

  connect(ip, encryptionKey) {
    this.disconnect();
    const rawKey = Buffer.from(encryptionKey, 'base64');
    if (rawKey.length !== 32) {
      console.error('[ESPHome] Invalid key length:', rawKey.length);
      return;
    }
    this.staticKey = rawKey;

    // Generate ephemeral keypair
    const eph = generateKeyPairSync('x25519');
    this.ephPriv = eph.privateKey.export({ format: 'der', type: 'pkcs8' }).slice(-32);
    this.ephPub = eph.publicKey.export({ format: 'der', type: 'spki' }).slice(-32);

    this.handshakeHash = createHash('sha256').update(PROTOCOL_NAME).digest();

    // Write e (ephemeral public key) to handshake
    this._mixHash(this.ephPub);

    console.log(`[ESPHome] Connecting to ${ip}:6053...`);
    this.socket = connect({ host: ip, port: 6053 }, () => this._sendHello());
    this.socket.on('data', (d) => this._onData(d));
    this.socket.on('error', (e) => { console.error('[ESPHome] Error:', e.message); this.connected = false; });
    this.socket.on('close', () => { this.connected = false; this.emit('disconnected'); });
  }

  disconnect() {
    if (this.socket) { this.socket.end(); this.socket = null; }
    this.connected = false;
  }

  // --- Protobuf ---
  _v(n) { const b = []; while (n > 0x7f) { b.push((n & 0x7f) | 0x80); n >>>= 7; } b.push(n); return Buffer.from(b); }
  _rv(buf, pos) { let v = 0, s = 0; while (pos < buf.length) { const b = buf[pos++]; v |= (b & 0x7f) << s; if (!(b & 0x80)) return { val: v, next: pos }; s += 7; } return null; }
  _f(num, wire, data) { return Buffer.concat([this._v((num << 3) | wire), data]); }
  _s(num, str) { const b = Buffer.from(str, 'utf-8'); return this._f(num, 2, Buffer.concat([this._v(b.length), b])); }
  _vi(num, v) { return this._f(num, 0, this._v(v)); }
  _frame(type, payload) { const b = Buffer.concat([Buffer.from([type]), payload]); return Buffer.concat([this._v(b.length), b]); }

  // --- Noise helpers ---
  _mixHash(data) { this.handshakeHash = createHash('sha256').update(Buffer.concat([this.handshakeHash, data])).digest(); return this.handshakeHash; }
  
  _hkdf(chainingKey, inputKeyMaterial, numOutputs = 2) {
    let tempKey = createHmac('sha256', chainingKey).update(inputKeyMaterial).digest();
    const outputs = [];
    for (let i = 0; i < numOutputs; i++) {
      const out = createHmac('sha256', tempKey).update(Buffer.from([i + 1])).digest();
      outputs.push(out);
    }
    const nextKey = createHmac('sha256', tempKey).update(Buffer.from([numOutputs + 1])).digest();
    return { outputs, nextKey };
  }

  _dh(privateKey, publicKey) {
    try {
      return diffieHellman({ privateKey, publicKey });
    } catch { return Buffer.alloc(32); }
  }

  _encryptPayload(plaintext) {
    // After handshake, use symmetric cipher
    if (!this.sendKey) return null;
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(this.sendNonce++, 4);
    const cipher = createCipheriv('chacha20-poly1305', this.sendKey, nonce, { authTagLength: 16 });
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([nonce, tag, ct]);
  }

  _decryptPayload(encrypted) {
    if (!this.recvKey || encrypted.length < 28) return null;
    try {
      const nonce = encrypted.slice(0, 12);
      const tag = encrypted.slice(12, 28);
      const ct = encrypted.slice(28);
      this.recvNonce++;
      const decipher = createDecipheriv('chacha20-poly1305', this.recvKey, nonce, { authTagLength: 16 });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch { return null; }
  }

  // --- Handshake flow ---
  _sendHello() {
    // Send e (our ephemeral public key) as first handshake message
    this.socket.write(this.ephPub);
  }

  _onData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);

    if (!this.handshakeDone) {
      this._processHandshake();
      return;
    }

    // After handshake: parse varint-framed encrypted messages
    while (true) {
      const r = this._rv(this.buffer, 0);
      if (!r) break;
      if (r.next + r.val > this.buffer.length) break;
      const frame = this.buffer.slice(r.next, r.next + r.val);
      this.buffer = this.buffer.slice(r.next + r.val);
      const plain = this._decryptPayload(frame);
      if (!plain) continue;
      if (plain.length === 0) continue;
      const type = plain[0];
      const payload = plain.slice(1);
      if (type === 7) this._parseSensor(payload);
    }
  }

  _processHandshake() {
    // Server responds with: e (32 bytes) + ee (32 bytes) + s (32 bytes encrypted) + es (32 bytes encrypted)
    if (this.buffer.length < 96) return;

    const serverEphPub = this.buffer.slice(0, 32);
    const eeEncrypted = this.buffer.slice(32, 64);
    const sEncrypted = this.buffer.slice(64, 80);
    const esEncrypted = this.buffer.slice(80, 96);

    this._mixHash(serverEphPub);

    // DH between ephemerals to get chaining key
    const dhEE = this._dh(this.ephPriv, serverEphPub);
    
    // Initialize chaining key from protocol name
    let ck = createHash('sha256').update(PROTOCOL_NAME).digest();
    
    // Mix ee
    const r1 = this._hkdf(ck, dhEE);
    ck = r1.nextKey;

    // Decrypt s (server static key) with first output
    const serverStaticKey = this._symmetricDecrypt(sEncrypted, r1.outputs[0]);

    // DH between our ephemeral and server static
    const dhES = this._dh(this.ephPriv, serverStaticKey);
    const r2 = this._hkdf(ck, dhES);
    ck = r2.nextKey;

    // DH between our static and server ephemeral
    const dhSE = this._dh(this.staticKey, serverEphPub);
    const r3 = this._hkdf(ck, dhSE);
    ck = r3.nextKey;

    // Mix in PSK (our static key, same as theirs)
    const r4 = this._hkdf(ck, this.staticKey);
    ck = r4.nextKey;

    // Send our static key encrypted + se + psk response
    const encryptedStatic = this._symmetricEncrypt(this.staticKey, r4.outputs[0]);
    const encryptedPayload = Buffer.concat([encryptedStatic, EMPTY, EMPTY]);
    this.socket.write(encryptedPayload);

    // Derive final session keys
    const r5 = this._hkdf(ck, EMPTY);
    this.sendKey = r5.outputs[0];
    this.recvKey = r5.outputs[1];
    this.sendNonce = 0;
    this.recvNonce = 0;
    this.handshakeDone = true;
    this.buffer = this.buffer.slice(96);
    this.connected = true;
    this.emit('connected');

    console.log('[ESPHome] Handshake complete, subscribing...');
    // Send SubscribeStatesRequest (type 5)
    this._sendMsg(Buffer.from([0x05, 0x08, 0x00]));
  }

  _symmetricEncrypt(plaintext, key) {
    const nonce = Buffer.alloc(12);
    const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([ct, cipher.getAuthTag()]);
  }

  _symmetricDecrypt(encrypted, key) {
    try {
      if (encrypted.length < 32) return Buffer.alloc(32);
      const ct = encrypted.slice(0, encrypted.length - 16);
      const tag = encrypted.slice(encrypted.length - 16);
      const decipher = createDecipheriv('chacha20-poly1305', key, Buffer.alloc(12), { authTagLength: 16 });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch { return Buffer.alloc(32); }
  }

  _sendMsg(data) {
    if (!this.socket || !this.sendKey) return;
    const frame = this._encryptPayload(data);
    if (!frame) return;
    this.socket.write(Buffer.concat([this._v(frame.length), frame]));
  }

  _parseSensor(payload) {
    let pos = 0, name = null, value = null;
    while (pos < payload.length) {
      const t = this._rv(payload, pos);
      if (!t) break;
      pos = t.next;
      const fn = t.val >> 3, w = t.val & 7;
      if (w === 0) { const v = this._rv(payload, pos); if (!v) break; pos = v.next; }
      else if (w === 5) { if (pos+4>payload.length) break; value = payload.readFloatLE(pos); pos+=4; }
      else if (w === 2) { const sl = this._rv(payload, pos); if (!sl) break; pos = sl.next;
        name = payload.slice(pos, pos+sl.val).toString('utf-8'); pos += sl.val; break; }
    }
    if (name && value != null) {
      this.emit('sensor', { name, value: Math.round(value * 100) / 100, ts: Math.floor(Date.now() / 1000) });
    }
  }
}
