import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeArtifact } from '../../tests/fixtures/capability.js';
import { FileCapabilityRegistry } from './registry.js';
import { parseArtifact } from './schema.js';
import type { CapabilityArtifact, CapabilityKey } from './schema.js';

function keyOf(artifact: CapabilityArtifact): CapabilityKey {
  return {
    appId: artifact.app.appId, appVersion: artifact.app.appVersion,
    name: artifact.identity.name, version: artifact.identity.version,
  };
}

function filename(key: CapabilityKey): string {
  return `${key.appId}--${key.appVersion}--${key.name}--${key.version}.json`;
}

describe('FileCapabilityRegistry', () => {
  let temporary: string;
  let directory: string;
  let registry: FileCapabilityRegistry;

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'capability-registry-'));
    directory = join(temporary, 'private', 'capabilities');
    registry = new FileCapabilityRegistry(directory);
  });

  afterEach(async () => {
    await rm(temporary, { recursive: true, force: true });
  });

  it('round trips a validated artifact with private permissions and no temporary files', async () => {
    const artifact = makeArtifact();
    const key = await registry.save(artifact);
    expect(key).toEqual(keyOf(artifact));
    expect(await registry.load(key)).toEqual(artifact);
    expect(await registry.list({ appId: key.appId, appVersion: key.appVersion })).toEqual([artifact]);
    expect(await readdir(directory)).toEqual([filename(key)]);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, filename(key)))).mode & 0o777).toBe(0o600);
    artifact.identity.description = 'Changed after save';
    expect((await registry.load(key)).identity.description).not.toBe(artifact.identity.description);
  });

  it('returns an empty list for a missing directory without creating it', async () => {
    const { appId, appVersion } = makeArtifact().app;
    expect(await registry.list({ appId, appVersion })).toEqual([]);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never overwrites a revision, including status-only changes', async () => {
    const artifact = makeArtifact();
    const key = await registry.save(artifact);
    await expect(registry.save(artifact)).rejects.toThrow('Capability revision already exists.');
    artifact.identity.status = 'verified';
    artifact.verification = { runId: 'verification_run', verifiedAt: '2026-09-11T00:00:00.000Z' };
    await expect(registry.save(artifact)).rejects.toThrow('Capability revision already exists.');
    expect((await registry.load(key)).identity.status).toBe('draft');
    artifact.identity.version += 1;
    const verifiedKey = await registry.save(artifact);
    expect((await registry.load(verifiedKey)).identity.status).toBe('verified');
    expect(await readdir(directory)).toHaveLength(2);
  });

  it('allows exactly one concurrent publisher and leaves a complete winning artifact', async () => {
    const artifacts = Array.from({ length: 8 }, (_, index) => {
      const artifact = makeArtifact();
      artifact.identity.description = `Publisher ${index}`;
      return artifact;
    });
    const results = await Promise.allSettled(artifacts.map((artifact) => registry.save(artifact)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toEqual(new Error('Capability revision already exists.'));
    }
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    expect(await registry.load(keyOf(artifacts[winner]!))).toEqual(artifacts[winner]);
    expect(await readdir(directory)).toEqual([filename(keyOf(artifacts[winner]!))]);
  });

  it('keeps full keys distinct and lists exact app versions in deterministic filename order', async () => {
    const artifacts = [10, 2, 1].map((version) => {
      const artifact = makeArtifact();
      artifact.identity.version = version;
      return artifact;
    });
    const otherVersion = makeArtifact();
    otherVersion.app.appVersion = '2.0';
    const otherApp = makeArtifact();
    otherApp.app.appId = 'other_app';
    const otherName = makeArtifact();
    otherName.identity.name = 'other_capability';
    for (const artifact of [...artifacts, otherVersion, otherApp, otherName]) {
      expect(await registry.load(await registry.save(artifact))).toEqual(artifact);
    }
    const expected = [...artifacts, otherName].sort((a, b) => {
      const left = filename(keyOf(a));
      const right = filename(keyOf(b));
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const app = { appId: artifacts[0]!.app.appId, appVersion: artifacts[0]!.app.appVersion };
    expect(await registry.list(app)).toEqual(expected);
    expect(await registry.list({ ...app, appVersion: '2.0' })).toEqual([otherVersion]);
    expect(await registry.list({ ...app, appVersion: '9.9' })).toEqual([]);
    await expect(registry.load({ ...keyOf(makeArtifact()), version: 99 })).rejects.toThrow('Invalid or unreadable capability artifact.');
  });

  it.each([
    { schemaVersion: 999 }, { schemaVersion: '1' }, { steps: [] },
    { credentials: 'private-payload' }, { identity: { name: '../private-payload' } },
  ])('rejects schema and type tampering on save and load', async (change) => {
    const artifact = makeArtifact();
    const tampered = { ...artifact, ...change };
    await expect(registry.save(tampered)).rejects.toThrow(/^Invalid capability artifact or sensitive values\.$/);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, filename(keyOf(artifact))), JSON.stringify(tampered));
    await expect(registry.load(keyOf(artifact))).rejects.toThrow(/^Invalid or unreadable capability artifact\.$/);
    await expect(registry.list({ appId: artifact.app.appId, appVersion: artifact.app.appVersion }))
      .rejects.toThrow(/^Invalid or unreadable capability artifact\.$/);
  });

  it.each([
    { appId: '../private-path' }, { name: '../../private-path' }, { appVersion: '../1.0' },
    { name: 'a--b' }, { version: '../private-path' }, { version: 0 }, { version: '1' },
    { directory: '/private-path' },
  ])('rejects unsafe or invalid keys before filesystem access', async (change) => {
    await expect(registry.load({ ...keyOf(makeArtifact()), ...change })).rejects.toThrow(/^Invalid capability key\.$/);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('validates list filters without leaking rejected input', async () => {
    await expect(registry.list({ appId: '../private-path', appVersion: '1.0' }))
      .rejects.toThrow(/^Invalid capability app identity\.$/);
  });

  it('ignores non-JSON files and temporary files, but fails closed for corrupt candidates', async () => {
    const artifact = makeArtifact();
    const key = await registry.save(artifact);
    await writeFile(join(directory, 'notes.txt'), 'not an artifact');
    await writeFile(join(directory, '.interrupted.tmp'), '{');
    const app = { appId: artifact.app.appId, appVersion: artifact.app.appVersion };
    expect(await registry.list(app)).toEqual([artifact]);
    await writeFile(join(directory, filename(key)), '{"secret":"private-payload"');
    await expect(registry.load(key)).rejects.toThrow(/^Invalid or unreadable capability artifact\.$/);
    await expect(registry.list(app)).rejects.toThrow(/^Invalid or unreadable capability artifact\.$/);
    await writeFile(join(directory, filename(key)), JSON.stringify(artifact));
    await writeFile(join(directory, 'unrelated.json'), 'private-payload');
    await expect(registry.list({ appId: 'other_app', appVersion: '9.9' }))
      .rejects.toThrow(/^Invalid or unreadable capability artifact\.$/);
  });

  it.each(['appId', 'appVersion', 'name', 'version'] as const)('rejects a loaded %s that disagrees with its filename', async (field) => {
    const artifact = makeArtifact();
    const key = await registry.save(artifact);
    if (field === 'appId') artifact.app.appId = 'different_app';
    if (field === 'appVersion') artifact.app.appVersion = '9.9';
    if (field === 'name') artifact.identity.name = 'different_name';
    if (field === 'version') artifact.identity.version += 1;
    await writeFile(join(directory, filename(key)), JSON.stringify(artifact));
    await expect(registry.load(key)).rejects.toThrow(/^Invalid or unreadable capability artifact\.$/);
    await expect(registry.list({ appId: key.appId, appVersion: key.appVersion }))
      .rejects.toThrow(/^Invalid or unreadable capability artifact\.$/);
  });

  it('rejects symlinks for load/list and never overwrites their outside targets', async () => {
    const artifact = makeArtifact();
    const key = keyOf(artifact);
    const outside = join(temporary, 'outside-private-path.json');
    const contents = JSON.stringify(artifact);
    await writeFile(outside, contents);
    await mkdir(directory, { recursive: true });
    await symlink(outside, join(directory, filename(key)));
    await expect(registry.load(key)).rejects.toThrow(/^Invalid or unreadable capability artifact\.$/);
    await expect(registry.list({ appId: key.appId, appVersion: key.appVersion }))
      .rejects.toThrow(/^Invalid or unreadable capability artifact\.$/);
    await expect(registry.save(artifact)).rejects.toThrow(/^Capability revision already exists\.$/);
    expect(await readFile(outside, 'utf8')).toBe(contents);
    expect(await readdir(directory)).toEqual([filename(key)]);
  });

  it('rejects nonregular and oversized files', async () => {
    const artifact = makeArtifact();
    const key = keyOf(artifact);
    const path = join(directory, filename(key));
    await mkdir(path, { recursive: true });
    await expect(registry.load(key)).rejects.toThrow(/^Invalid or unreadable capability artifact\.$/);
    await expect(registry.list({ appId: key.appId, appVersion: key.appVersion }))
      .rejects.toThrow(/^Invalid or unreadable capability artifact\.$/);
    await rm(path, { recursive: true });
    await writeFile(path, Buffer.alloc(1024 * 1024 + 1, ' '));
    await expect(registry.load(key)).rejects.toThrow(/^Invalid or unreadable capability artifact\.$/);
  });

  it.each([
    ['private-secret', 'private-secret'],
    ['private-"quoted"\nsecret', 'private-"quoted"\nsecret'],
    ['private-"quoted"\nsecret', encodeURIComponent('private-"quoted"\nsecret')],
    ['private/path?secret=yes', encodeURI('private/path?secret=yes')],
  ])('rejects known raw, JSON-escaped, and URL-encoded values without redacting them', async (secret, content) => {
    const artifact = makeArtifact();
    artifact.identity.description = content;
    await expect(registry.save(artifact, ['', secret])).rejects.toThrow(/^Capability artifact contains a known sensitive value\.$/);
    expect(artifact.identity.description).toBe(content);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects secrets in executable selectors, not only metadata', async () => {
    const artifact = makeArtifact();
    artifact.steps.push({
      id: 'secret_check', action: 'wait', risk: 'read_only',
      condition: { kind: 'visible', target: { strategies: [
        { kind: 'text', text: { source: 'literal', value: 'private-"quoted"\nsecret' } },
      ] } },
    });
    await expect(registry.save(artifact, ['private-"quoted"\nsecret']))
      .rejects.toThrow(/^Capability artifact contains a known sensitive value\.$/);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects schema-valid serialization larger than one MiB before creating the root', async () => {
    const artifact = makeArtifact();
    const condition = {
      kind: 'any' as const,
      conditions: Array.from({ length: 10 }, () => ({
        kind: 'visible' as const,
        target: { strategies: Array.from({ length: 5 }, () => ({
          kind: 'text' as const, text: { source: 'literal' as const, value: 'x'.repeat(1000) },
        })) },
      })),
    };
    for (const step of artifact.steps) step.postcondition = condition;
    while (artifact.steps.length < 40) {
      artifact.steps.push({ id: `size_check_${artifact.steps.length}`, action: 'wait', risk: 'read_only', condition });
    }
    expect(parseArtifact(artifact)).toEqual(artifact);
    expect(Buffer.byteLength(JSON.stringify(artifact))).toBeGreaterThan(1024 * 1024);
    await expect(registry.save(artifact)).rejects.toThrow(/^Capability artifact exceeds the size limit\.$/);
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ignores empty sensitive values and does not claim to detect unknown PII', async () => {
    const artifact = makeArtifact();
    artifact.identity.description = 'unknown@example.test';
    expect(await registry.load(await registry.save(artifact, ['', 'absent-secret']))).toEqual(artifact);
  });

  it('sanitizes getter failures and filesystem errors without retaining causes or paths', async () => {
    const value = { get schemaVersion() { throw new Error('private-payload'); } };
    await expect(registry.save(value)).rejects.toEqual(new Error('Invalid capability artifact or sensitive values.'));
    await expect(registry.load({ get appId() { throw new Error('private-key'); } }))
      .rejects.toEqual(new Error('Invalid capability key.'));
    const blockedPath = join(temporary, 'private-path');
    await writeFile(blockedPath, 'private-payload');
    const blocked = new FileCapabilityRegistry(join(blockedPath, 'capabilities'));
    await expect(blocked.save(makeArtifact())).rejects.toEqual(new Error('Unable to save capability artifact.'));
    await expect(blocked.list({ appId: 'some_app', appVersion: '1.0' }))
      .rejects.toEqual(new Error('Unable to list capability artifacts.'));
  });
});
