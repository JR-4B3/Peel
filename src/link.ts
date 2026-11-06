import { deflateRawSync, inflateRawSync } from "node:zlib";
import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual, type KeyObject } from "node:crypto";

// Paired Peels share group keys: random 32-byte secrets that never cross the network unencrypted.
// A session mixes one of them with a fresh X25519 exchange, so a recorded session cannot be
// decrypted later, and a device without the key learns nothing and cannot answer.

export interface GroupKey { id: string; key: string }

export function newGroupKey(): GroupKey {
  const key = randomBytes(32);
  return { id: keyId(key), key: key.toString("base64url") };
}

export function keyId(key: Buffer) {
  return createHash("sha256").update("peel group key 1").update(key).digest("base64url").slice(0, 16);
}

const hash = (...parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest();

export class Ephemeral {
  private privateKey: KeyObject;
  readonly public: string;
  readonly nonce = randomBytes(16).toString("base64url");
  constructor() {
    const pair = generateKeyPairSync("x25519");
    this.privateKey = pair.privateKey;
    this.public = (pair.publicKey.export({ format: "jwk" }) as { x: string }).x;
  }
  shared(other: string) {
    if (typeof other !== "string" || !/^[\w-]{43}$/.test(other)) throw new Error("Invalid key");
    return diffieHellman({ privateKey: this.privateKey, publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: other }, format: "jwk" }) });
  }
}

// AES-256-GCM in each direction, with the message count as nonce. TCP keeps messages in
// order, so a replayed, dropped, or reordered message fails to decrypt and ends the session.
export class Cipher {
  private sent = 0n;
  private received = 0n;
  constructor(private sendKey: Buffer, private receiveKey: Buffer) {}
  private static nonce(count: bigint) { const nonce = Buffer.alloc(12); nonce.writeBigUInt64BE(count, 4); return nonce; }
  // Large messages, such as a queue of a few hundred songs, are compressed before they are
  // encrypted, which makes them about fifteen times smaller. compress is false for anything that
  // carries a secret, since compressed sizes can reveal parts of it. A compressed message starts
  // with "z", which JSON never does.
  seal(value: unknown, compress = false) {
    const json = JSON.stringify(value);
    const plain = compress && json.length > 2048 ? Buffer.concat([Buffer.from("z"), deflateRawSync(json)]) : Buffer.from(json);
    const cipher = createCipheriv("aes-256-gcm", this.sendKey, Cipher.nonce(this.sent++));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([body, cipher.getAuthTag()]).toString("base64url");
  }
  open(text: string): any {
    const data = Buffer.from(text, "base64url");
    if (data.length < 16) throw new Error("Invalid message");
    const decipher = createDecipheriv("aes-256-gcm", this.receiveKey, Cipher.nonce(this.received++));
    decipher.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
    // A small message cannot unpack into more than a paired device may send anyway.
    return JSON.parse((plain[0] === 0x7a ? inflateRawSync(plain.subarray(1), { maxOutputLength: 16 * 1024 * 1024 }) : plain).toString());
  }
}

function keys(material: Buffer, salt: Buffer, info: string, length: number) {
  return Buffer.from(hkdfSync("sha256", material, salt, info, length));
}

const mac = (key: Buffer, label: string) => createHmac("sha256", key).update(label).digest("base64url");
function sameMac(a: unknown, b: string) {
  if (typeof a !== "string") return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// The session handshake, in three messages:
//   client: hello {id, name, keys, e, n}
//   server: hello {id, name, key, e, n, mac}  proves the server holds the chosen group key
//   client: auth {mac}                         proves the client holds it too
export interface Hello { t: "hello"; v: 1; id: string; name: string; e: string; n: string; keys?: string[]; key?: string; mac?: string }

function sessionKeys(ephemeral: Ephemeral, client: Hello, server: Hello, group: GroupKey) {
  const transcript = hash("peel session 1", client.id, client.name, client.e, client.n, server.id, server.name, server.key, server.e, server.n);
  const material = keys(ephemeral.shared(ephemeral.public === client.e ? server.e : client.e), Buffer.concat([Buffer.from(group.key, "base64url"), transcript]), "peel session keys", 128);
  return { client: material.subarray(0, 32), server: material.subarray(32, 64), clientToServer: material.subarray(64, 96), serverToClient: material.subarray(96, 128) };
}

export function clientHello(ephemeral: Ephemeral, id: string, name: string, groups: GroupKey[]): Hello {
  return { t: "hello", v: 1, id, name, keys: groups.map(group => group.id), e: ephemeral.public, n: ephemeral.nonce };
}

export function serverHello(ephemeral: Ephemeral, id: string, name: string, groups: GroupKey[], client: Hello) {
  const group = groups.find(group => client.keys?.includes(group.id));
  if (!group) return undefined;
  const hello: Hello = { t: "hello", v: 1, id, name, key: group.id, e: ephemeral.public, n: ephemeral.nonce };
  const derived = sessionKeys(ephemeral, client, hello, group);
  hello.mac = mac(derived.server, "server");
  return { hello, expect: mac(derived.client, "client"), cipher: new Cipher(derived.serverToClient, derived.clientToServer) };
}

export function clientFinish(ephemeral: Ephemeral, groups: GroupKey[], client: Hello, server: Hello) {
  const group = groups.find(group => group.id === server.key);
  if (!group) throw new Error("The other Peel chose a key this one does not have.");
  const derived = sessionKeys(ephemeral, client, server, group);
  if (!sameMac(server.mac, mac(derived.server, "server"))) throw new Error("The other Peel could not prove it is paired.");
  return { auth: { t: "auth", mac: mac(derived.client, "client") }, cipher: new Cipher(derived.clientToServer, derived.serverToClient) };
}

export function checkAuth(message: { mac?: unknown }, expected: string) { return sameMac(message.mac, expected); }

// Pairing compares a six-digit code on both screens, like Bluetooth's numeric comparison. The
// device that asks commits to its key before it sees the other's, so a device in between cannot
// pick keys that make the two codes match. It succeeds by chance once in a million attempts.
//   initiator: pair {id, name, commit}
//   responder: pair {id, name, e, n}
//   initiator: reveal {e, n}
// Both then show the code. Group keys follow only after both people accept, encrypted.
export interface PairOffer { t: "pair"; v: 1; id: string; name: string; commit?: string; e?: string; n?: string }

export const commitment = (ephemeral: Ephemeral) => hash("peel commit 1", ephemeral.public, ephemeral.nonce).toString("base64url");

export function pairingKeys(ephemeral: Ephemeral, initiator: PairOffer, responder: PairOffer, reveal: { e: string; n: string }) {
  if (commitment({ public: reveal.e, nonce: reveal.n } as Ephemeral) !== initiator.commit) throw new Error("The other Peel changed its pairing key.");
  const transcript = hash("peel pair 1", initiator.id, initiator.name, initiator.commit, responder.id, responder.name, responder.e, responder.n, reveal.e, reveal.n);
  const material = keys(ephemeral.shared(ephemeral.public === reveal.e ? responder.e! : reveal.e), transcript, "peel pairing keys", 68);
  const code = String(material.readUInt32BE(64) % 1_000_000).padStart(6, "0");
  const initiatorToResponder = material.subarray(0, 32), responderToInitiator = material.subarray(32, 64);
  return {
    code,
    cipher: (role: "initiator" | "responder") => role === "initiator" ? new Cipher(initiatorToResponder, responderToInitiator) : new Cipher(responderToInitiator, initiatorToResponder),
  };
}
