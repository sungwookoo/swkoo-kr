import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class TokenCipher {
  private readonly key: Buffer;
  constructor(encoded = process.env.TOKEN_ENCRYPTION_KEY) {
    if (!encoded && process.env.NODE_ENV !== 'test') throw new Error('TOKEN_ENCRYPTION_KEY is required');
    // In-memory tests never reuse this ephemeral key in production.
    this.key = encoded ? Buffer.from(encoded, 'base64') : randomBytes(32);
    if (this.key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must contain 32 bytes');
  }
  encrypt(value: string, context: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ['enc1', nonce.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
  }
  decrypt(value: string, context: string): string {
    const [version, nonce, tag, encrypted] = value.split(':');
    if (version !== 'enc1' || !nonce || !tag || !encrypted) throw new Error('Invalid encrypted token');
    const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(nonce, 'base64'));
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([cipher.update(Buffer.from(encrypted, 'base64')), cipher.final()]).toString('utf8');
  }
}
