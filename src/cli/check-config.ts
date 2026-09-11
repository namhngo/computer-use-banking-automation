import { readConfig } from '../config.js';

try {
  const config = readConfig();
  console.log(`Configuration valid: local web target, headless=${String(config.headless)}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Configuration validation failed.');
  process.exitCode = 1;
}
