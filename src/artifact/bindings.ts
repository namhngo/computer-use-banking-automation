import { z } from 'zod';
import { capabilityKeySchema, parseArtifact, textValueSchema } from './schema.js';
import type { ExtractionParser, FieldDefinition, TextValue } from './schema.js';

const invocationContextSchema = capabilityKeySchema.pick({ appId: true, appVersion: true }).extend({
  mode: z.enum(['verification', 'replay']),
});

export function prepareInvocation(artifact: unknown, values: unknown, context: unknown) {
  const parsed = parseArtifact(artifact);
  const target = invocationContextSchema.safeParse(context);
  if (!target.success || target.data.appId !== parsed.app.appId || target.data.appVersion !== parsed.app.appVersion) {
    throw new Error('Invocation target does not match the capability.');
  }
  if (parsed.risk !== 'read_only' || (target.data.mode === 'replay' && parsed.identity.status !== 'verified')) {
    throw new Error('Capability is not eligible for this execution mode.');
  }
  // Metadata eligibility is not authorization: Phase 3 must check each resolved UI action.
  return { artifact: parsed, inputs: validateValues(parsed.inputs, values) };
}

export function validateValues(definitions: Record<string, FieldDefinition>, values: unknown) {
  const fields = Object.fromEntries(Object.entries(definitions).map(([name, field]) => {
    let schema: z.ZodType<string | number | boolean>;
    switch (field.type) {
      case 'string': {
        const text = z.string().min(field.minLength).max(field.maxLength);
        schema = field.format === 'digits' ? text.regex(/^[0-9]+$/) : text;
        break;
      }
      case 'number': {
        let number = field.integer ? z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER) : z.number().finite();
        if (field.minimum !== undefined) number = number.min(field.minimum);
        if (field.maximum !== undefined) number = number.max(field.maximum);
        schema = number;
        break;
      }
      case 'boolean': schema = z.boolean(); break;
    }
    return [name, schema];
  }));
  const result = z.strictObject(fields).safeParse(values);
  if (!result.success) throw new Error('Values do not match the declared contract.');
  return result.data;
}

export function bindText(value: TextValue, inputs: Record<string, string | number | boolean>): string {
  const parsed = textValueSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid value reference.');
  if (parsed.data.source === 'literal') return parsed.data.value;
  if (!Object.hasOwn(inputs, parsed.data.name)) throw new Error('Missing input for value reference.');
  const input = inputs[parsed.data.name];
  if (!['string', 'number', 'boolean'].includes(typeof input) || (typeof input === 'number' && !Number.isFinite(input))) {
    throw new Error('Invalid input for value reference.');
  }
  return String(input);
}

export function parseExtraction(raw: string, parser: ExtractionParser): string | number | boolean {
  if (raw.length > 10_000) throw new Error('Invalid extracted value.');
  const text = raw.trim();
  if (parser === 'text') return text;
  if (parser === 'boolean' && (text === 'true' || text === 'false')) return text === 'true';
  let value: bigint;
  if (parser === 'integer' && /^-?[0-9]+$/.test(text)) {
    value = BigInt(text);
  } else if (parser === 'usd_cents' && /^-?\$(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\.[0-9]{2}$/.test(text)) {
    // Integer arithmetic avoids rounding money through a floating-point dollar amount.
    value = BigInt(text.replace(/[$,.]/g, ''));
  } else {
    throw new Error('Invalid extracted value.');
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error('Extracted value exceeds safe integer range.');
  }
  return Number(value);
}
