import example from '../../examples/get-member-savings-balance.json' with { type: 'json' };
import { parseArtifact } from '../../src/artifact/schema.js';

export function makeArtifact() {
  return parseArtifact(structuredClone(example));
}
