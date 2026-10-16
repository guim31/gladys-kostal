// -----------------------------------------------------------------------------
// The login handshake of the Kostal REST API (SCRAM-SHA-256, RFC 5802, with
// Kostal's own message layout), then the session request encrypted with
// AES-256-GCM. Ported from pykoplenti (`ApiClient._login`, Apache 2.0).
//
// The password never travels: the inverter only receives a proof built from
// it. Only node:crypto, no dependency.
//
// 1. POST auth/start   { username, nonce }            → { nonce, transactionId, salt, rounds }
// 2. POST auth/finish  { transactionId, proof }        → { token, signature }
//    (the inverter's signature is checked: a fake inverter is refused)
// 3. POST auth/create_session { iv, tag, transactionId, payload }  → { sessionId }
//    payload = the token, encrypted with a key derived from the handshake.
// -----------------------------------------------------------------------------

import { createCipheriv, createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

const hmac = (key, ...parts) => {
  const mac = createHmac('sha256', key);
  for (const part of parts) {
    mac.update(part);
  }
  return mac.digest();
};

const b64 = (buffer) => Buffer.from(buffer).toString('base64');
const unb64 = (text) => Buffer.from(String(text), 'base64');

/** 12 random bytes, as pykoplenti sends. */
export function createClientNonce() {
  return randomBytes(12);
}

/**
 * The client side of the handshake, once the inverter answered auth/start.
 * @param {object} input
 * @param {string} input.username 'user' (the plant owner)
 * @param {string} input.password the owner password
 * @param {Buffer} input.clientNonce sent in auth/start
 * @param {{ nonce: string, salt: string, rounds: number }} input.start the answer of auth/start
 * @returns {{ proof: string, serverSignature: Buffer, protocolKey: Buffer, authMessage: string }}
 */
export function computeProof({ username, password, clientNonce, start }) {
  const serverNonce = unb64(start.nonce);
  const salt = unb64(start.salt);
  const rounds = Number(start.rounds);
  if (!Number.isInteger(rounds) || rounds < 1 || salt.length === 0 || serverNonce.length === 0) {
    throw new Error('Unexpected answer to auth/start');
  }
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, rounds, 32, 'sha256');
  const clientKey = hmac(salted, 'Client Key');
  const storedKey = createHash('sha256').update(clientKey).digest();
  // Kostal's layout: the server nonce is repeated, and both nonces are
  // re-encoded from their bytes (pykoplenti does the same).
  const authMessage =
    `n=${username},r=${b64(clientNonce)},r=${b64(serverNonce)},` +
    `s=${b64(salt)},i=${rounds},c=biws,r=${b64(serverNonce)}`;
  const clientSignature = hmac(storedKey, authMessage);
  const proof = Buffer.alloc(clientKey.length);
  for (let i = 0; i < clientKey.length; i += 1) {
    proof[i] = clientKey[i] ^ clientSignature[i];
  }
  const serverKey = hmac(salted, 'Server Key');
  return {
    proof: b64(proof),
    serverSignature: hmac(serverKey, authMessage),
    protocolKey: hmac(storedKey, 'Session Key', authMessage, clientKey),
    authMessage,
  };
}

/**
 * The body of auth/create_session: the token encrypted with the protocol key.
 * @param {Buffer} protocolKey from computeProof
 * @param {string} token from auth/finish
 * @param {string} transactionId from auth/start, as received
 * @param {Buffer} [iv] 16 random bytes (fixed in the tests)
 */
export function sessionRequest(protocolKey, token, transactionId, iv = randomBytes(16)) {
  const cipher = createCipheriv('aes-256-gcm', protocolKey, iv);
  const payload = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return {
    iv: b64(iv),
    tag: b64(cipher.getAuthTag()),
    transactionId: b64(unb64(transactionId)),
    payload: b64(payload),
  };
}

/** True when the signature the inverter sent proves it knows the password too. */
export function isServerSignatureValid(expected, received) {
  const signature = unb64(received ?? '');
  return signature.length === expected.length && signature.equals(expected);
}

export const encodeBase64 = b64;
