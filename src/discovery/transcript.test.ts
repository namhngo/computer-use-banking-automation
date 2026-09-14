import { mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Target } from '../artifact/schema.js';
import { fileURLToPath } from 'node:url';
import { canonicalPagePath, loadPolicy } from '../policy/policy.js';
import { transcriptSchema, type DiscoveryRecord, type DiscoveryTranscript } from './contracts.js';
import { writeTranscript } from './transcript.js';

const memberId = '12345';
const policy = await loadPolicy(fileURLToPath(new URL('../../policy.yaml', import.meta.url)));
const canonicalPath = (path: string) => canonicalPagePath(policy, `http://localhost:4000${path}`, [memberId]);
const options = { inputs: { memberId }, secrets: ['private-password-98'], canonicalPath };
const goal = {
  name: 'get_member_savings_balance', description: 'Read the savings balance and currency for a member.',
  inputs: { memberId: { description: 'Member identifier.', format: 'digits', length: 5 } },
  outputs: {
    savingsBalanceCents: { parser: 'usd_cents', description: 'Savings balance in cents.', sensitive: true },
    currency: { parser: 'text', description: 'Currency code.', sensitive: false },
  },
} as const;
const input = { source: 'input', name: 'memberId' } as const;
const literal = (value: string) => ({ source: 'literal', value } as const);
const target = (text: string): Target => ({ strategies: [{ kind: 'label', text: literal(text) }] });

function transcript(records: DiscoveryRecord[] = [{
  turn: 1, tool: 'fill', reason: 'enter_input', status: 'succeeded',
  ref: 'e1_1', target: target('Member'), value: literal(memberId),
}]): DiscoveryTranscript {
  return {
    schemaVersion: 2, kind: 'discovery_transcript', source: 'test', provider: 'test-provider', modelId: 'authored-test-model',
    runId: `run_${'a'.repeat(32)}`, promptVersion: 2, goal: structuredClone(goal), status: 'SUCCESS',
    calls: [{ turn: 0, phase: 'intent', status: 'returned', modelId: 'authored-test-model', responseId: 'response-a', usage: { inputTokens: 12, outputTokens: 7 } }],
    records,
  };
}

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'discovery-transcript-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const persisted = async () => transcriptSchema.parse(JSON.parse(await readFile(join(directory, 'discovery.json'), 'utf8')) as unknown);

describe('writeTranscript', () => {
  it('preserves authored test metadata, writes only input names, and does not mutate input', async () => {
    const original = transcript();
    const before = structuredClone(original);
    expect(await writeTranscript(directory, original, options)).toBe('discovery.json');
    expect(await persisted()).toEqual({ ...before, records: [{ ...before.records[0], value: input }] });
    expect(original).toEqual(before);
    const serialized = await readFile(join(directory, 'discovery.json'), 'utf8');
    for (const known of [memberId, ...options.secrets]) expect(serialized).not.toContain(known);
    expect(serialized).not.toContain('[REDACTED]');
    expect(await readdir(directory)).toEqual(['discovery.json']);
  });

  it('parameterizes exact TextValues throughout targets, including frames, containers and table cells', async () => {
    const original = transcript([{
      turn: 1, tool: 'click', reason: 'locate_record', status: 'succeeded',
      target: {
        scope: {
          frames: [{ kind: 'text', text: literal(memberId) }, { kind: 'role', role: 'dialog', name: literal(memberId) }],
          container: { kind: 'label', text: literal(memberId) },
        },
        strategies: [
          { kind: 'role', role: 'row', name: literal(memberId) },
          { kind: 'label', text: literal(memberId) }, { kind: 'text', text: input },
          { kind: 'table_cell', row: literal(memberId), column: literal(memberId) },
          { kind: 'table_cell', row: literal(memberId), column: 1 },
        ],
      },
    }]);
    const before = structuredClone(original);
    await writeTranscript(directory, original, options);
    expect((await persisted()).records[0]?.target).toEqual({
      scope: { frames: [{ kind: 'text', text: input }, { kind: 'role', role: 'dialog', name: input }], container: { kind: 'label', text: input } },
      strategies: [
        { kind: 'role', role: 'row', name: input }, { kind: 'label', text: input }, { kind: 'text', text: input },
        { kind: 'table_cell', row: input, column: input }, { kind: 'table_cell', row: input, column: 1 },
      ],
    });
    expect(original).toEqual(before);
  });

  it('spells identifiers in both paths as :id and retains every allowed page', async () => {
    const paths = ['/', '/login', '/members/search', '/notice', '/members/12345', '/members/12345/accounts', '/members/98765/accounts'];
    const original = transcript(paths.map((path, i) => ({ turn: i + 1, tool: 'navigate', reason: 'locate_record', status: 'succeeded', path, framePath: path })));
    original.source = 'live';
    const before = structuredClone(original);
    await writeTranscript(directory, original, options);
    const result = await persisted();
    expect(result.source).toBe('live');
    expect(result.records.map(({ path }) => path)).toEqual(['/', '/login', '/members/search', '/notice', '/members/:id', '/members/:id/accounts', '/members/:id/accounts']);
    expect(result.records.every(({ path, framePath }) => path === framePath)).toBe(true);
    expect(JSON.stringify(result.records)).not.toContain(memberId);
    expect(original).toEqual(before);
  });

  it('refuses a path evidence cannot name rather than inventing a spelling, without mutating proposals', async () => {
    for (const path of ['[unavailable]', '[blocked]', '/members/:id', '/transfer', '/members/12345/sub-accounts']) {
      for (const key of ['path', 'framePath']) {
        const original = transcript([{ turn: 1, tool: 'fill', reason: 'enter_input', status: 'succeeded', target: target(memberId), value: literal(memberId), [key]: path }]);
        const before = structuredClone(original);
        await expect(writeTranscript(directory, original, options)).rejects.toThrow(/^TRANSCRIPT_UNSAFE$/);
        expect(original).toEqual(before);
      }
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it('allows a missing goal only for empty nonsuccess pre-intent transcripts, and inputs must match the goal', async () => {
    const preintent = { ...transcript([]), goal: null };
    preintent.status = 'CLARIFICATION_REQUIRED';
    const noInput = { inputs: {}, secrets: options.secrets, canonicalPath };
    for (const invalid of [
      { ...transcript([]), goal: null }, { ...preintent, records: transcript().records },
      { ...preintent, calls: [{ ...preintent.calls[0], phase: 'action' }] },
      { ...preintent, calls: [{ ...preintent.calls[0], turn: 1 }] },
      ...['/members/12345', '/members/12345/accounts'].flatMap((path) => ['path', 'framePath'].map((key) => ({
        ...preintent, records: [{ turn: 1, tool: 'navigate', reason: 'locate_record', status: 'succeeded', [key]: path }],
      }))),
    ]) await expect(writeTranscript(directory, invalid, noInput)).rejects.toThrow(/^TRANSCRIPT_UNSAFE$/);
    for (const inputs of [{ memberId: '' }, { memberId }, { Member: memberId }, { memberId, other: 'x' }]) {
      await expect(writeTranscript(directory, preintent, { ...options, inputs })).rejects.toThrow(/^TRANSCRIPT_UNSAFE$/);
    }
    for (const inputs of [{}, { member: memberId }, { memberId, extra: 'x' }]) {
      await expect(writeTranscript(directory, transcript(), { ...options, inputs })).rejects.toThrow(/^TRANSCRIPT_UNSAFE$/);
    }
    expect(await readdir(directory)).toEqual([]);
    await writeTranscript(directory, preintent, noInput);
    expect(await persisted()).toEqual(preintent);
  });

  it('rejects noncanonical paths rather than truncating or accepting arbitrary navigation', async () => {
    for (const path of ['/members/12345?secret=x', '/members/12345/other', '/members/%31%32%33%34%35', '/members/12345/', '//login', '/login#x', 'https://example.test/login', '/../login']) {
      for (const key of ['path', 'framePath']) {
        await expect(writeTranscript(directory, transcript([{ turn: 1, tool: 'navigate', reason: 'locate_record', status: 'succeeded', [key]: path }]), options)).rejects.toThrow('TRANSCRIPT_UNSAFE');
      }
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it('rejects credentials in raw, JSON, URL, form and mixed encodings without leaking errors', async () => {
    const secret = 'private /"pass+word';
    const unicode = secret.split('').map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const variants = [secret, JSON.stringify(secret).slice(1, -1), unicode, unicode.toUpperCase().replaceAll('\\U', '\\u'), encodeURIComponent(secret), encodeURIComponent(encodeURIComponent(secret)), new URLSearchParams({ x: secret }).toString().slice(2), encodeURIComponent(unicode), 'private%20/"pass+word'];
    for (const value of variants) {
      const data = transcript([{ turn: 1, tool: 'click', reason: 'inspect_state', status: 'succeeded', target: target(value) }]);
      const result = writeTranscript(directory, data, { ...options, secrets: [secret] });
      await expect(result).rejects.toThrow(/^TRANSCRIPT_UNSAFE$/);
      await expect(result).rejects.not.toHaveProperty('cause');
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it('rejects Base64, Base64URL, hex and mixed encoded credentials in targets and model metadata', async () => {
    const secret = 'credential-~??';
    const bytes = Buffer.from(secret);
    const base64 = bytes.toString('base64');
    const variants = [base64, bytes.toString('base64url'), bytes.toString('hex'), bytes.toString('hex').toUpperCase(),
      `\\u${base64.charCodeAt(0).toString(16).padStart(4, '0')}${Array.from(Buffer.from(base64.slice(1)), (byte) => `%${byte.toString(16)}`).join('')}`];
    const base = transcript();
    for (const encoded of variants) {
      const token = `model-${encoded}-token`;
      for (const extra of [
        { provider: token }, { modelId: token }, { calls: [{ ...base.calls[0], modelId: token }] },
        { calls: [{ ...base.calls[0], status: 'failed', usage: null, responseId: token }] },
        { records: [{ ...base.records[0], target: target(token) }] },
        { records: [{ ...base.records[0], target: { scope: { frames: [{ kind: 'css', selector: `[data-token="${token}"]` }] }, strategies: [{ kind: 'text', text: literal('Generic') }] } }] },
      ]) {
        const original = { ...base, ...extra };
        expect(transcriptSchema.safeParse(original).success).toBe(true);
        const before = structuredClone(original);
        const result = writeTranscript(directory, original, { ...options, secrets: [secret] });
        await expect(result).rejects.toThrow(/^TRANSCRIPT_UNSAFE$/);
        await expect(result).rejects.not.toHaveProperty('cause');
        expect(original).toEqual(before);
      }
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it('fails closed on member IDs embedded in CSS or non-exact text, including encoded IDs', async () => {
    for (const value of ['12345', '%31%32%33%34%35', '\\u0031\\u0032\\u0033\\u0034\\u0035', Buffer.from(memberId).toString('base64'), Buffer.from(memberId).toString('hex')]) {
      for (const unsafeTarget of [
        { strategies: [{ kind: 'css', selector: `[data-member="${value}"]` }] },
        { scope: { frames: [{ kind: 'css', selector: `#member-${value}` }] }, strategies: [{ kind: 'text', text: literal('Generic') }] },
        target(`Member ${value}`),
      ]) {
        await expect(writeTranscript(directory, transcript([{ turn: 1, tool: 'click', reason: 'locate_record', status: 'succeeded', target: unsafeTarget as Target }]), options)).rejects.toThrow('TRANSCRIPT_UNSAFE');
      }
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it('rejects known raw and parsed sensitive outputs, while retaining nonsensitive currency text', async () => {
    const sensitiveOptions = { ...options, sensitiveValues: ['$4,567.89', '456789'] };
    for (const value of ['$4,567.89', '456789', '%24' + '4%2C567.89', Buffer.from('456789').toString('base64'), Buffer.from('$4,567.89').toString('hex')]) {
      await expect(writeTranscript(directory, transcript([{ turn: 1, tool: 'extract', reason: 'read_value', status: 'succeeded', name: 'savingsBalanceCents', target: target(value) }]), sensitiveOptions)).rejects.toThrow('TRANSCRIPT_UNSAFE');
    }
    await writeTranscript(directory, transcript([{ turn: 1, tool: 'extract', reason: 'read_value', status: 'succeeded', name: 'currency', target: target('USD') }]), sensitiveOptions);
    expect((await persisted()).records[0]?.target).toEqual(target('USD'));
  });

  it('rejects output values and non-member fill literals even if not listed as sensitive', async () => {
    for (const [tool, value] of [['extract', literal('USD')], ['extract', input], ['fill', literal('unlisted-private-value')]] as const) {
      await expect(writeTranscript(directory, transcript([{ turn: 1, tool, reason: 'read_value', status: 'succeeded', value }]), options)).rejects.toThrow('TRANSCRIPT_UNSAFE');
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it('strictly rejects private extra fields, arbitrary reasons, and malformed field identifiers', async () => {
    const base = transcript();
    const invalid = [
      ...['goalType', 'modelText', 'reasoning', 'messages', 'observations', 'formValues', 'outputs', 'inputs'].map((key) => ({ ...base, [key]: 'private' })),
      { ...base, goal: { ...goal, inputs: { ...goal.inputs, [memberId]: goal.inputs.memberId } } },
      { ...base, goal: { ...goal, values: { memberId } } },
      ...[{ reason: 'freeform explanation' }, { name: 'password' }, { effect: '../private' }, { effect: 'click' }, { ref: 'raw-ref' }, { messages: ['private'] }, { target: { ...target('Member'), observations: 'private' } }].map((extra) => ({ ...base, records: [{ ...base.records[0], ...extra }] })),
      // A read must name something the goal declared, on an extract.
      { ...base, records: [{ turn: 1, tool: 'extract', reason: 'read_value', status: 'succeeded', name: 'password', target: target('x') }] },
      { ...base, records: [{ turn: 1, tool: 'click', reason: 'read_value', status: 'succeeded', name: 'currency', target: target('x') }] },
      { ...base, calls: [{ ...base.calls[0], messages: ['private'] }] },
    ];
    for (const value of invalid) await expect(writeTranscript(directory, value, options)).rejects.toThrow('TRANSCRIPT_UNSAFE');
    expect(await readdir(directory)).toEqual([]);
  });

  it('rejects undeclared input references, including scoped selectors', async () => {
    const unknownInput = { source: 'input', name: 'password' } as const;
    for (const extra of [
      { value: unknownInput },
      { target: { strategies: [{ kind: 'text', text: unknownInput }] } },
      { target: { scope: { frames: [{ kind: 'label', text: unknownInput }] }, strategies: [{ kind: 'text', text: literal('Generic') }] } },
    ]) {
      await expect(writeTranscript(directory, { ...transcript(), records: [{ turn: 1, tool: 'fill', reason: 'enter_input', status: 'succeeded', ...extra }] }, options)).rejects.toThrow('TRANSCRIPT_UNSAFE');
    }
  });

  it('rejects proposals on failed dispatches but permits finite-code error records without proposals', async () => {
    for (const status of ['rejected', 'blocked'] as const) {
      for (const proposal of [{ target: target('Generic') }, { value: input }, { path: '/login' }, { framePath: '/login' }, { effect: 'read' as const }]) {
        await expect(writeTranscript(directory, transcript([{ turn: 1, tool: 'click', reason: 'inspect_state', status, ...proposal }]), options)).rejects.toThrow('TRANSCRIPT_UNSAFE');
      }
    }
    const data = transcript([{ turn: 1, tool: 'click', reason: 'inspect_state', status: 'blocked', code: 'POLICY_BLOCKED', ref: 'e1_1' }]);
    data.status = 'BLOCKED';
    await writeTranscript(directory, data, options);
    expect(await persisted()).toEqual(data);
  });

  it('checks opaque metadata conservatively but does not treat numeric counters as output data', async () => {
    const base = transcript();
    for (const extra of [{ modelId: `model-${memberId}` }, { provider: 'private-password-98' }, { calls: [{ ...base.calls[0], responseId: `response-${memberId}` }] }, { runId: `run_${memberId}${'a'.repeat(27)}` }]) {
      await expect(writeTranscript(directory, { ...base, ...extra }, options)).rejects.toThrow('TRANSCRIPT_UNSAFE');
    }
    const data = transcript([]);
    data.calls = [{ turn: 0, phase: 'intent', status: 'returned', modelId: 'test-model', usage: { inputTokens: 12345, outputTokens: 456789 } }];
    await writeTranscript(directory, data, { ...options, sensitiveValues: ['456789'] });
    expect(await persisted()).toEqual(data);
  });

  it('retains failed call receipts with unknown usage without allowing unknown or malformed metadata', async () => {
    const data = transcript([]);
    data.status = 'FAILURE';
    data.calls = [
      { turn: 0, phase: 'intent', status: 'failed', modelId: 'test-model', usage: null },
      { turn: 0, phase: 'intent', status: 'failed', modelId: 'test-model', usage: { inputTokens: 12, outputTokens: 7 } },
    ];
    for (const extra of [{ status: undefined }, { status: 'succeeded' }, { usage: undefined }, { usage: { inputTokens: -1, outputTokens: 0 } }, { messages: ['private'] }, { error: 'private' }, { usage: { inputTokens: 12, outputTokens: 7, reasoning: 'private' } }]) {
      await expect(writeTranscript(directory, { ...data, calls: [{ ...data.calls[0], ...extra }] }, options)).rejects.toThrow(/^TRANSCRIPT_UNSAFE$/);
    }
    const before = structuredClone(data);
    await writeTranscript(directory, { ...data, goal: null }, { inputs: {}, secrets: options.secrets, canonicalPath });
    expect(await persisted()).toEqual({ ...before, goal: null });
    expect(data).toEqual(before);
  });

  it('bounds serialized UTF-8 bytes to 1 MiB before creating any file', async () => {
    const large = transcript(Array.from({ length: 50 }, (_, i) => ({
      turn: i + 1, tool: 'click', reason: 'inspect_state', status: 'succeeded',
      target: { strategies: Array.from({ length: 5 }, () => ({ kind: 'table_cell', row: literal('\u754c'.repeat(1000)), column: literal('\u754c'.repeat(1000)) })) },
    })));
    expect(transcriptSchema.safeParse(large).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(1024 * 1024);
    await expect(writeTranscript(directory, large, options)).rejects.toThrow('TRANSCRIPT_UNSAFE');
    expect(await readdir(directory)).toEqual([]);
  });

  it('publishes one complete private file under concurrent writes and never overwrites it', async () => {
    const results = await Promise.allSettled([writeTranscript(directory, transcript(), options), writeTranscript(directory, transcript([]), options)]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toEqual([{ status: 'rejected', reason: new Error('TRANSCRIPT_WRITE_FAILED') }]);
    const bytes = await readFile(join(directory, 'discovery.json'));
    expect(transcriptSchema.safeParse(JSON.parse(bytes.toString()) as unknown).success).toBe(true);
    expect((await stat(join(directory, 'discovery.json'))).mode & 0o777).toBe(0o600);
    await expect(writeTranscript(directory, transcript([]), options)).rejects.toThrow('TRANSCRIPT_WRITE_FAILED');
    expect(await readFile(join(directory, 'discovery.json'))).toEqual(bytes);
    expect(await readdir(directory)).toEqual(['discovery.json']);
  });

  it('does not follow an existing final symlink, cleans failed publication, and sanitizes filesystem errors', async () => {
    await symlink('untouched.json', join(directory, 'discovery.json'));
    const collision = writeTranscript(directory, transcript(), options);
    await expect(collision).rejects.toThrow(/^TRANSCRIPT_WRITE_FAILED$/);
    await expect(collision).rejects.not.toHaveProperty('cause');
    expect(await readdir(directory)).toEqual(['discovery.json']);
    await expect(stat(join(directory, 'untouched.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const missing = writeTranscript(join(directory, 'private-missing-directory'), transcript(), options);
    await expect(missing).rejects.toThrow(/^TRANSCRIPT_WRITE_FAILED$/);
    await expect(missing).rejects.not.toHaveProperty('cause');
  });
});
