/* eslint preserve-caught-error: "off" -- Filesystem error causes expose private paths. */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { capabilityKeySchema, parseArtifact } from './schema.js';
import type { CapabilityArtifact, CapabilityKey } from './schema.js';

const maxBytes = 1024 * 1024;
const appSchema = capabilityKeySchema.pick({ appId: true, appVersion: true }).strip();

function artifactKey(artifact: CapabilityArtifact): CapabilityKey {
  return {
    appId: artifact.app.appId,
    appVersion: artifact.app.appVersion,
    name: artifact.identity.name,
    version: artifact.identity.version,
  };
}

function filename(key: CapabilityKey): string {
  return `${key.appId}--${key.appVersion}--${key.name}--${key.version}.json`;
}

/** A trusted local directory, supplied by application configuration, never by a model. */
export class FileCapabilityRegistry {
  constructor(private readonly directory = 'artifacts/capabilities') {}

  /**
   * Revisions are immutable, including status. Verification must publish a new revision.
   * Rejects known sensitive values without changing executable content. This is not an
   * arbitrary PII detector: callers must supply invocation values and known secrets.
   */
  async save(value: unknown, sensitiveValues: readonly string[] = []): Promise<CapabilityKey> {
    let artifact: CapabilityArtifact;
    let serialized: string;
    let sensitive: boolean;
    try {
      artifact = parseArtifact(value);
      serialized = JSON.stringify(artifact);
      sensitive = sensitiveValues.some((secret) => {
        if (secret === '') return false;
        return [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), encodeURI(secret)]
          .some((representation) => serialized.includes(representation));
      });
    } catch {
      throw new Error('Invalid capability artifact or sensitive values.');
    }
    if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
      throw new Error('Capability artifact exceeds the size limit.');
    }
    if (sensitive) throw new Error('Capability artifact contains a known sensitive value.');
    const key = artifactKey(artifact);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, `.${randomUUID()}.tmp`);
      const file = await open(temporary, 'wx', 0o600);
      try {
        try {
          await file.writeFile(serialized, 'utf8');
        } finally {
          await file.close();
        }
        // Hard linking publishes the complete file atomically without replacing a revision.
        await link(temporary, join(this.directory, filename(key)));
      } finally {
        await unlink(temporary);
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new Error('Capability revision already exists.');
      }
      throw new Error('Unable to save capability artifact.');
    }
    return key;
  }

  async load(key: unknown): Promise<CapabilityArtifact> {
    let parsed: CapabilityKey;
    try {
      parsed = capabilityKeySchema.parse(key);
    } catch {
      throw new Error('Invalid capability key.');
    }
    return this.readArtifact(filename(parsed));
  }

  async list(app: { appId: string; appVersion: string }): Promise<CapabilityArtifact[]> {
    let parsed: { appId: string; appVersion: string };
    try {
      parsed = appSchema.parse(app);
    } catch {
      throw new Error('Invalid capability app identity.');
    }
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw new Error('Unable to list capability artifacts.');
    }
    const artifacts: CapabilityArtifact[] = [];
    for (const entry of entries.filter((entry) => entry.endsWith('.json')).sort()) {
      const artifact = await this.readArtifact(entry);
      if (artifact.app.appId === parsed.appId && artifact.app.appVersion === parsed.appVersion) {
        artifacts.push(artifact);
      }
    }
    return artifacts;
  }

  private async readArtifact(entry: string): Promise<CapabilityArtifact> {
    try {
      // NONBLOCK lets fstat reject FIFOs without waiting for a writer.
      const file = await open(join(this.directory, entry),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > maxBytes) throw new Error();
        // Bound the read too, in case a local writer grows the file after fstat.
        const buffer = Buffer.alloc(maxBytes + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
          if (bytesRead === 0) break;
          size += bytesRead;
        }
        if (size > maxBytes) throw new Error();
        const artifact = parseArtifact(JSON.parse(buffer.toString('utf8', 0, size)) as unknown);
        if (filename(artifactKey(artifact)) !== entry) throw new Error();
        return artifact;
      } finally {
        await file.close();
      }
    } catch {
      throw new Error('Invalid or unreadable capability artifact.');
    }
  }
}
