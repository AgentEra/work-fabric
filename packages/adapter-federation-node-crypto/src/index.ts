import {
  sign as ed25519Sign,
  verify as ed25519Verify,
  type KeyObject,
} from "node:crypto";

import type {
  FederationSigner,
  FederationTrustResolver,
} from "@work-fabric/federation-spi";

export interface NodeEd25519FederationTrustEntry {
  readonly source_exchange_id: string;
  readonly target_exchange_id: string;
  readonly key_id: string;
  readonly public_key: KeyObject;
}

function trustKey(input: {
  readonly source_exchange_id: string;
  readonly target_exchange_id: string;
  readonly key_id: string;
}): string {
  return JSON.stringify([
    input.source_exchange_id,
    input.target_exchange_id,
    input.key_id,
  ]);
}

function requireEd25519(key: KeyObject, type: "private" | "public"): void {
  if (key.type !== type || key.asymmetricKeyType !== "ed25519") {
    throw new TypeError(`expected an Ed25519 ${type} key`);
  }
}

function decodeCanonicalBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]{86}$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 64 || decoded.toString("base64url") !== value) return undefined;
  return decoded;
}

export class NodeEd25519FederationSigner implements FederationSigner {
  constructor(
    readonly key_id: string,
    private readonly privateKey: KeyObject,
  ) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key_id)) {
      throw new TypeError("key_id must be a bounded base64url identifier");
    }
    requireEd25519(privateKey, "private");
  }

  async sign(canonical: Uint8Array): Promise<string> {
    return ed25519Sign(null, canonical, this.privateKey).toString("base64url");
  }
}

export class NodeEd25519FederationTrustResolver implements FederationTrustResolver {
  private readonly entries = new Map<string, KeyObject>();

  constructor(entries: readonly NodeEd25519FederationTrustEntry[]) {
    for (const entry of entries) {
      requireEd25519(entry.public_key, "public");
      const key = trustKey(entry);
      if (this.entries.has(key)) throw new TypeError("duplicate federation trust entry");
      this.entries.set(key, entry.public_key);
    }
  }

  async verify(input: {
    readonly source_exchange_id: string;
    readonly target_exchange_id: string;
    readonly key_id: string;
    readonly canonical: Uint8Array;
    readonly signature: string;
  }): Promise<boolean> {
    const publicKey = this.entries.get(trustKey(input));
    const signature = decodeCanonicalBase64Url(input.signature);
    if (publicKey === undefined || signature === undefined) return false;
    return ed25519Verify(null, input.canonical, publicKey, signature);
  }
}
