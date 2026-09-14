import { readFileSync } from 'node:fs';
import * as ai from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { intentSchema, ModelCallError } from './contracts.js';
import { DISCOVERY_INSTRUCTIONS, INTENT_INSTRUCTIONS, PROMPT_VERSION, createDiscoveryModel, readDiscoveryModel } from './model.js';

vi.mock('ai', { spy: true });

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
const signal = () => new AbortController().signal;
const privateValue = 'private-test-key-98';
const spec = {
  name: 'get_member_savings_balance', description: 'Read the savings balance and currency for a member.',
  inputs: { memberId: { value: '12345', description: 'Member identifier.' } },
  outputs: {
    savingsBalanceCents: { parser: 'usd_cents', description: 'Savings balance in cents.', sensitive: true },
    currency: { parser: 'text', description: 'Currency code.', sensitive: false },
  },
} as const;
const ready = { status: 'ready', goal: spec };
const click = { ref: 'e1_2', reason: 'inspect_state' };
const mockReceipt = { usage: { inputTokens: 12, outputTokens: 7 }, modelId: 'served-model-v1', responseId: 'response-1' };

function toolCall(name: string, input: unknown): GenerateResult['content'][number] {
  return { type: 'tool-call', toolCallId: 'call-1', toolName: name, input: JSON.stringify(input) };
}

function response(content = [toolCall('click', click)]): GenerateResult {
  return {
    content,
    finishReason: { unified: 'tool-calls', raw: 'completed' },
    usage: {
      inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 7, text: 7, reasoning: 0 },
    },
    response: { modelId: 'served-model-v1', id: 'response-1' },
    warnings: [],
  };
}

function setup(result = response(), secretValues: readonly string[] = []) {
  const sdk = new MockLanguageModelV4({ modelId: 'requested-model', doGenerate: result });
  const client = createDiscoveryModel({ model: sdk, modelId: 'requested-model', provider: 'test-provider', source: 'test', secretValues });
  return { sdk, client };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createDiscoveryModel', () => {
  it('uses the real SDK for one forced intent call with bounded, private options', async () => {
    const { sdk, client } = setup(response([toolCall('plan_goal', ready)]));
    const abortSignal = signal();
    expect(await client.intent('Read savings for member 12345', abortSignal)).toEqual({
      value: ready, usage: { inputTokens: 12, outputTokens: 7 }, modelId: 'served-model-v1', responseId: 'response-1',
    });
    expect(client).toMatchObject({ source: 'test', provider: 'test-provider', modelId: 'requested-model', secretValues: [] });
    expect(sdk.doGenerateCalls).toHaveLength(1);
    expect(sdk.doStreamCalls).toHaveLength(0);
    expect(sdk.doGenerateCalls[0]).toMatchObject({
      maxOutputTokens: 512, temperature: 0, toolChoice: { type: 'tool', toolName: 'plan_goal' },
      providerOptions: { openai: { parallelToolCalls: false, store: false } },
      prompt: [
        { role: 'system', content: INTENT_INSTRUCTIONS },
        { role: 'user', content: [{ type: 'text', text: JSON.stringify({ goal: 'Read savings for member 12345' }) }] },
      ],
    });
    const options = vi.mocked(ai.generateText).mock.calls[0]?.[0];
    expect(options).toMatchObject({
      instructions: INTENT_INSTRUCTIONS, maxRetries: 0, maxOutputTokens: 512, abortSignal,
      telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
      include: { requestBody: false, requestMessages: false, responseBody: false },
    });
    expect(options).not.toHaveProperty('system');
    expect(options).not.toHaveProperty('reasoning');
    expect(Object.keys(options?.tools ?? {})).toEqual(['plan_goal']);
    expect(options?.tools?.plan_goal?.description).toEqual(expect.any(String));
    expect(options?.tools?.plan_goal?.inputSchema).toBe(intentSchema);
    expect(ai.isStepCount).toHaveBeenCalledWith(1);
  });

  it('returns all valid intent statuses without heuristics or conversation carryover', async () => {
    const values = [ready, { status: 'clarify', goal: null }, { status: 'unsupported', goal: null }];
    const sdk = new MockLanguageModelV4({ doGenerate: values.map((value) => response([toolCall('plan_goal', value)])) });
    const client = createDiscoveryModel({ model: sdk, modelId: 'neutral-model', provider: 'neutral', source: 'test' });
    for (const value of values) {
      expect((await client.intent('A goal interpreted by the model', signal())).value).toEqual(value);
    }
    expect(sdk.doGenerateCalls).toHaveLength(3);
    for (const call of sdk.doGenerateCalls) expect(call.prompt.map((message) => message.role)).toEqual(['system', 'user']);
  });

  it('maps all seven decisions independently and never supplies or executes tool handlers', async () => {
    const decisions = [
      ['fill', { ref: 'e1_1', input: 'memberId', reason: 'enter_input' }],
      ['click', click],
      ['extract', { ref: 'e1_3', name: 'currency', reason: 'read_value' }],
      ['extract', { ref: 'e1_3', name: 'memberId', reason: 'read_value' }],
      ['navigate', { path: '/observed', reason: 'locate_record' }],
      ['wait', { ms: 50, reason: 'wait_for_ui' }],
      ['complete', { outcome: 'success', code: null, ref: null, reason: 'confirm_completion' }],
      // A live model attaches the evidence ref to a success claim; the engine ignores it.
      ['complete', { outcome: 'success', code: null, ref: 'e1_3', reason: 'confirm_completion' }],
      ['complete', { outcome: 'business_outcome', code: 'MEMBER_NOT_FOUND', ref: 'e1_4', reason: 'confirm_completion' }],
      ['request_human', { code: 'stuck', reason: 'ask_human' }],
    ] as const;
    const context = { observation: { refs: [{ ref: 'e1_2', role: 'button', name: 'Observed control' }] } };
    for (const [name, input] of decisions) {
      const { sdk, client } = setup(response([toolCall(name, input)]));
      expect((await client.decide(spec, context, signal())).value).toEqual({ tool: name, input });
      expect(sdk.doGenerateCalls).toHaveLength(1);
      expect(sdk.doGenerateCalls[0]).toMatchObject({ toolChoice: { type: 'required' } });
    }
    for (const [options] of vi.mocked(ai.generateText).mock.calls) {
      expect(options.prompt).toBe(JSON.stringify(context));
      expect(Object.keys(options.tools ?? {}).sort()).toEqual([...new Set(decisions.map(([name]) => name))].sort());
      for (const definition of Object.values(options.tools ?? {})) {
        expect(Object.keys(definition).sort()).toEqual(['description', 'inputSchema']);
      }
    }
  });

  it('keeps prompts observational and contains no application recipe or source access', async () => {
    const { sdk, client } = setup();
    await client.decide(spec, { observation: { refs: [] } }, signal());
    const captured = JSON.stringify(sdk.doGenerateCalls[0]?.prompt);
    expect(PROMPT_VERSION).toBe(2);
    expect(sdk.doGenerateCalls[0]?.prompt[0]).toEqual({ role: 'system', content: DISCOVERY_INSTRUCTIONS });
    expect(DISCOVERY_INSTRUCTIONS).toMatch(/extract every declared input from the page or frame that displays the outputs/);
    expect(`${INTENT_INSTRUCTIONS}\n${DISCOVERY_INSTRUCTIONS}`).not.toMatch(/\bsavings\b|\bbalance\b|\bmember\b/i);
    expect(DISCOVERY_INSTRUCTIONS).toMatch(/actual successful extracts/);
    expect(captured).not.toMatch(/Harbor|data-testid|querySelector|\/members|\/accounts|mock-app|\.html|\.tsx|Step [0-9]|first click|then click/i);
    const source = readFileSync(new URL('./model.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/node:fs|readFile|playwright|\.execute\b|execute\s*:|webFetch|webSearch|\.tools\.|Harbor|data-testid|querySelector/);
  });

  it('rejects zero, multiple, and unknown calls rather than choosing one', async () => {
    for (const content of [[], [toolCall('click', click), toolCall('click', click)], [toolCall('undeclared', {})]]) {
      const { sdk, client } = setup(response(content));
      await expect(client.decide(spec, {}, signal())).rejects.toMatchObject({ name: 'ModelCallError', receipt: mockReceipt });
      expect(sdk.doGenerateCalls).toHaveLength(1);
    }
  });

  it('rejects malformed JSON, extra properties, wrong inputs, and cross-field violations', async () => {
    const invalid = [
      toolCall('fill', { ref: 'e1_1', input: 'password', reason: 'enter_input' }),
      toolCall('click', { ...click, selector: '#invented' }),
      toolCall('click', { ...click, ref: 'invented' }),
      toolCall('complete', { outcome: 'business_outcome', code: 'MEMBER_NOT_FOUND', ref: null, reason: 'confirm_completion' }),
      toolCall('complete', { outcome: 'business_outcome', code: null, ref: 'e1_4', reason: 'confirm_completion' }),
      toolCall('complete', { outcome: 'success', code: 'DONE', ref: null, reason: 'confirm_completion' }),
      toolCall('extract', { ref: 'e1_3', name: 'checkingBalance', reason: 'read_value' }),
      toolCall('fill', { ref: 'e1_1', input: 'currency', reason: 'enter_input' }),
      { type: 'tool-call', toolCallId: 'bad-json', toolName: 'click', input: '{' } as const,
    ];
    for (const content of invalid) {
      await expect(setup(response([content])).client.decide(spec, {}, signal())).rejects.toMatchObject({ name: 'ModelCallError', receipt: mockReceipt });
    }
    for (const content of [
      toolCall('plan_goal', { status: 'ready', goal: null }),
      toolCall('plan_goal', { status: 'clarify', goal: spec }),
      toolCall('plan_goal', { status: 'ready', goal: { ...spec, outputs: {} } }),
      toolCall('plan_goal', { status: 'ready', goal: { ...spec, inputs: { savingsBalanceCents: spec.inputs.memberId } } }),
      toolCall('plan_goal', { status: 'ready', goal: { ...spec, name: 'Get Balance' } }),
      toolCall('plan_goal', { ...ready, plan: ['invented'] }),
      toolCall('click', click),
    ]) {
      await expect(setup(response([content])).client.intent('Read savings', signal())).rejects.toMatchObject({ name: 'ModelCallError', receipt: mockReceipt });
    }
  });

  it('rejects truncation, refusal, errors, and ambiguous finish reasons even with a valid tool', async () => {
    for (const unified of ['length', 'content-filter', 'error', 'other', 'stop'] as const) {
      const result = response();
      result.finishReason = { unified, raw: privateValue };
      await expect(setup(result).client.decide(spec, {}, signal())).rejects.toMatchObject({ name: 'ModelCallError', receipt: mockReceipt });
    }
  });

  it('rejects mixed text, reasoning, and provider-executed output', async () => {
    const call = toolCall('click', click);
    const contents: GenerateResult['content'][] = [
      [call, { type: 'text', text: `Refusal: ${privateValue}` }],
      [call, { type: 'reasoning', text: privateValue }],
      [{ ...call, providerExecuted: true } as GenerateResult['content'][number]],
    ];
    for (const content of contents) {
      await expect(setup(response(content)).client.decide(spec, {}, signal())).rejects.toMatchObject({ name: 'ModelCallError', receipt: mockReceipt });
    }
  });

  it('requires reported nonnegative integer usage, without filling missing totals from details', async () => {
    for (const field of ['inputTokens', 'outputTokens'] as const) {
      for (const total of [undefined, -1, 1.5, Infinity, NaN]) {
        const result = response();
        result.usage[field].total = total;
        await expect(setup(result).client.decide(spec, {}, signal())).rejects.toMatchObject({ name: 'ModelCallError', receipt: undefined });
      }
    }
    const result = response();
    result.usage.inputTokens.total = 0;
    result.usage.outputTokens.total = 0;
    expect((await setup(result).client.decide(spec, {}, signal())).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('requires bounded served model metadata and does not invent absent response IDs', async () => {
    for (const metadata of [
      {}, { modelId: '' }, { modelId: 'x'.repeat(101) }, { modelId: 'bad\nmodel' },
      { modelId: 'served', id: '' }, { modelId: 'served', id: 'x'.repeat(201) },
    ]) {
      const result = response();
      result.response = metadata;
      const expected = {
        usage: mockReceipt.usage,
        ...(metadata.modelId === 'served' ? { modelId: 'served' } : {}),
      };
      await expect(setup(result).client.decide(spec, {}, signal())).rejects.toMatchObject({ name: 'ModelCallError', receipt: expected });
    }
    const result = response();
    result.response = { modelId: 'served-without-id' };
    expect(await setup(result).client.decide(spec, {}, signal())).toEqual({
      value: { tool: 'click', input: click }, usage: { inputTokens: 12, outputTokens: 7 }, modelId: 'served-without-id',
    });
  });

  it('scrubs known secrets from served metadata and rejects them in decisions', async () => {
    const result = response();
    result.response = { modelId: `served-${privateValue}`, id: `response-${Buffer.from(privateValue).toString('base64url')}` };
    expect(await setup(result, [privateValue]).client.decide(spec, {}, signal())).toMatchObject({
      modelId: '[REDACTED]', responseId: '[REDACTED]',
    });
    result.finishReason = { unified: 'length', raw: 'max_output_tokens' };
    await expect(setup(result, [privateValue]).client.decide(spec, {}, signal())).rejects.toMatchObject({
      receipt: { usage: mockReceipt.usage, modelId: '[REDACTED]', responseId: '[REDACTED]' },
    });
    const unsafe = response([toolCall('navigate', { path: `/${privateValue}`, reason: 'inspect_state' })]);
    await expect(setup(unsafe, [privateValue]).client.decide(spec, {}, signal())).rejects.toThrow('Discovery model call failed.');
  });

  it('blocks raw and encoded API or UI secrets in goals and nested context before any call', async () => {
    const uiSecret = 'private ui / pass"word';
    const malformedUnicodeSecret = 'private\uD800ui';
    const values = [privateValue, uiSecret, malformedUnicodeSecret];
    const { sdk, client } = setup(response(), values);
    values.length = 0;
    expect(client.secretValues).toEqual([privateValue, uiSecret, malformedUnicodeSecret]);
    for (const secret of client.secretValues) {
      const forms = [secret, encodeURIComponent(Buffer.from(secret).toString('utf8')), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url'), Buffer.from(secret).toString('hex'),
        Buffer.from(secret).toString('hex').toUpperCase(), new URLSearchParams({ v: secret }).toString().slice(2),
        secret.split('').map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
        encodeURIComponent(JSON.stringify(secret)).replaceAll('private', '%70rivate'),
        JSON.stringify(encodeURIComponent(Buffer.from(secret).toString('base64'))),
      ];
      for (const form of forms) {
        await expect(client.decide(spec, { observation: [{ text: form }] }, signal())).rejects.toThrow('Discovery model call failed.');
        await expect(client.intent(`Read savings ${form}`, signal())).rejects.toThrow('Discovery model call failed.');
      }
    }
    expect(sdk.doGenerateCalls).toHaveLength(0);
    expect(ai.generateText).not.toHaveBeenCalled();
  });

  it('sanitizes serialization failures before calling the SDK', async () => {
    const { sdk, client } = setup();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const context of [undefined, circular, { toJSON: () => { throw new Error(privateValue); } }]) {
      await expect(client.decide(spec, context, signal())).rejects.toThrow('Discovery model call failed.');
    }
    expect(sdk.doGenerateCalls).toHaveLength(0);
  });

  it('sanitizes SDK exceptions without causes, logs, retries, or fallback decisions', async () => {
    const sdk = new MockLanguageModelV4({ doGenerate: () => { throw new Error(`Private response ${privateValue}`); } });
    const client = createDiscoveryModel({ model: sdk, modelId: 'model', provider: 'provider', source: 'live', secretValues: [privateValue] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = await client.decide(spec, {}, signal()).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ModelCallError);
    expect(error).toMatchObject({ message: 'Discovery model call failed.', receipt: undefined });
    expect(error).not.toHaveProperty('cause');
    expect(sdk.doGenerateCalls).toHaveLength(1);
    const result = response();
    result.warnings = [{ type: 'other', message: privateValue }];
    await expect(setup(result).client.decide(spec, {}, signal())).rejects.toMatchObject({ name: 'ModelCallError', receipt: mockReceipt });
    expect(warn).not.toHaveBeenCalled();
  });

  it('honors pre-call and in-flight cancellation without exposing the abort reason', async () => {
    const controller = new AbortController();
    controller.abort(new Error(privateValue));
    const { sdk, client } = setup();
    await expect(client.decide(spec, {}, controller.signal)).rejects.toMatchObject({ name: 'ModelCallError', receipt: undefined });
    expect(sdk.doGenerateCalls).toHaveLength(0);
    const inFlight = new AbortController();
    const cancelingSdk = new MockLanguageModelV4({ doGenerate: (options) => {
      expect(options.abortSignal?.aborted).toBe(false);
      inFlight.abort(new Error(privateValue));
      expect(options.abortSignal?.aborted).toBe(true);
      return Promise.resolve(response());
    } });
    const cancelingClient = createDiscoveryModel({ model: cancelingSdk, modelId: 'model', provider: 'provider', source: 'test' });
    await expect(cancelingClient.decide(spec, {}, inFlight.signal)).rejects.toMatchObject({ name: 'ModelCallError', receipt: mockReceipt });
    expect(cancelingSdk.doGenerateCalls).toHaveLength(1);
  });
});

describe('readDiscoveryModel', () => {
  it('validates configuration without network access and always selects a live OpenAI client', () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    for (const env of [{}, { OPENAI_API_KEY: '' }, { OPENAI_API_KEY: ' \t\n' }]) {
      expect(() => readDiscoveryModel(env)).toThrow('OPENAI_API_KEY is required.');
    }
    for (const modelId of ['', 'other-model', '../model', 'gpt-bad/model', 'gpt-4.1\n', `gpt-${'x'.repeat(97)}`, privateValue,
      'gpt-5', 'gpt-4o', 'gpt-4.1-mini-nano', 'gpt-4.1-2026-01-01']) {
      expect(() => readDiscoveryModel({ OPENAI_API_KEY: privateValue, DISCOVERY_MODEL: modelId })).toThrow('Invalid discovery model configuration: DISCOVERY_MODEL.');
    }
    for (const modelId of [undefined, 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
      'gpt-4.1-2025-04-14', 'gpt-4.1-mini-2025-04-14', 'gpt-4.1-nano-2025-04-14']) {
      const env = { OPENAI_API_KEY: privateValue, ...(modelId === undefined ? {} : { DISCOVERY_MODEL: modelId }) };
      expect(readDiscoveryModel(env)).toMatchObject({
        source: 'live', provider: 'openai', modelId: modelId ?? 'gpt-4.1', secretValues: [privateValue],
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends a non-stored OpenAI Responses request with one named tool and preserves served metadata', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
      id: 'resp-served', object: 'response', created_at: 1, status: 'completed', model: 'gpt-4.1-served-version',
      output: [{ type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'plan_goal', arguments: JSON.stringify(ready), status: 'completed' }],
      incomplete_details: null, error: null, usage: { input_tokens: 21, output_tokens: 9, total_tokens: 30 },
    }));
    vi.stubGlobal('fetch', fetch);
    const client = readDiscoveryModel({ OPENAI_API_KEY: privateValue });
    expect(await client.intent('Read savings for 12345', signal())).toEqual({
      value: ready, modelId: 'gpt-4.1-served-version', responseId: 'resp-served', usage: { inputTokens: 21, outputTokens: 9 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${privateValue}`);
    expect(typeof init?.body).toBe('string');
    const body: unknown = JSON.parse(init?.body as string);
    expect(body).toMatchObject({
      model: 'gpt-4.1', max_output_tokens: 512, temperature: 0, store: false, parallel_tool_calls: false,
      tool_choice: { type: 'function', name: 'plan_goal' },
      tools: [{ type: 'function', name: 'plan_goal', parameters: { type: 'object', additionalProperties: false } }],
    });
    expect(body).toHaveProperty('input', expect.arrayContaining([
      { role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ goal: 'Read savings for 12345' }) }] },
    ]));
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('previous_response_id');
    expect(JSON.stringify(body)).not.toContain(privateValue);
  });

  it('does not retry a provider HTTP error or expose its private response body', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
      error: { type: 'server_error', code: 'server_error', param: null, message: `Private response ${privateValue}` },
    }, { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    const client = readDiscoveryModel({ OPENAI_API_KEY: privateValue });
    const error = await client.decide(spec, {}, signal()).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ModelCallError);
    expect(error).toMatchObject({ message: 'Discovery model call failed.', receipt: undefined });
    expect(error).not.toHaveProperty('cause');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves receipts for rejected OpenAI wire responses, including SDK-unparseable failures', async () => {
    const base = {
      id: 'resp-rejected', object: 'response', created_at: 1, status: 'completed', model: 'gpt-4.1-served-version',
      output: [{ type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'click', arguments: JSON.stringify(click), status: 'completed' }],
      usage: { input_tokens: 21, output_tokens: 9, total_tokens: 30 },
    };
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const client = readDiscoveryModel({ OPENAI_API_KEY: privateValue });
    const dispatch = vi.fn();
    const rejected = [
      { ...base, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      { ...base, status: 'incomplete', incomplete_details: { reason: 'unknown_stop' } },
      { ...base, status: 'in_progress' },
      { ...base, status: undefined },
      { ...base, incomplete_details: { reason: 'unknown_stop' } },
      { ...base, output: [{ ...base.output[0], status: 'incomplete' }] },
      { ...base, output: [{ ...base.output[0], status: undefined }] },
      { ...base, output: [{ type: 'message', id: 'msg-refused', role: 'assistant', content: [{ type: 'refusal', refusal: privateValue }] }] },
      { ...base, status: 'failed', error: { code: 'server_error', message: privateValue } },
      { ...base, error: { code: 'server_error', message: privateValue } },
      { ...base, output: [{ ...base.output[0], arguments: '{' }] },
      { ...base, output: [{ ...base.output[0], arguments: JSON.stringify({ ref: 'invalid' }) }] },
    ];
    for (const body of rejected) {
      fetch.mockResolvedValueOnce(Response.json(body));
      const error = await client.decide(spec, {}, signal()).then((reply) => { dispatch(reply); }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ModelCallError);
      expect(error).toMatchObject({ message: 'Discovery model call failed.', receipt: body.status === 'in_progress' || body.status === undefined ? undefined : {
        usage: { inputTokens: 21, outputTokens: 9 }, modelId: base.model, responseId: base.id,
      } });
      expect(error).not.toHaveProperty('cause');
      expect(JSON.stringify(error)).not.toContain(privateValue);
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(rejected.length);
  });

  it('isolates concurrent call receipts and never reuses one for a later transport failure', async () => {
    let release: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(Response.json({
        id: 'resp-second', model: 'gpt-4.1-mini', status: 'completed',
        output: [{ type: 'function_call', id: 'fc-2', call_id: 'call-2', name: 'click', arguments: JSON.stringify(click), status: 'completed' }],
        usage: { input_tokens: 4, output_tokens: 2 },
      }))
      .mockRejectedValueOnce(new Error(privateValue));
    vi.stubGlobal('fetch', fetch);
    const client = readDiscoveryModel({ OPENAI_API_KEY: privateValue });
    const first = client.decide(spec, {}, signal()).catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(await client.decide(spec, {}, signal())).toMatchObject({
      modelId: 'gpt-4.1-mini', responseId: 'resp-second', usage: { inputTokens: 4, outputTokens: 2 },
    });
    release?.(Response.json({
      id: `resp-${encodeURIComponent(privateValue).replace('private', '%70rivate')}`, model: `gpt-${privateValue}`, status: 'failed',
      error: { code: 'server_error', message: privateValue }, usage: { input_tokens: 17, output_tokens: 3 },
    }));
    expect(await first).toMatchObject({ name: 'ModelCallError', receipt: {
      modelId: '[REDACTED]', responseId: '[REDACTED]', usage: { inputTokens: 17, outputTokens: 3 },
    } });
    await expect(client.decide(spec, {}, signal())).rejects.toMatchObject({ name: 'ModelCallError', receipt: undefined });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
