import { z } from 'zod';

const environmentSchema = z.object({
  TARGET_URL: z.url({
    protocol: /^http$/,
    hostname: /^(localhost|127\.0\.0\.1|\[::1\])$/,
  }).refine((value) => {
    const url = URL.parse(value);
    return url !== null && !url.username && !url.password && !url.search && !url.hash;
  }).default('http://localhost:4000/'),
  HEADLESS: z.enum(['true', 'false']).default('true'),
});

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = environmentSchema.safeParse({
    TARGET_URL: env.TARGET_URL,
    HEADLESS: env.HEADLESS,
  });

  if (!result.success) {
    // Report field names only: invalid configuration may contain credentials.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid configuration: ${fields.join(', ')}. See .env.example.`);
  }

  return {
    targetUrl: new URL(result.data.TARGET_URL).href,
    headless: result.data.HEADLESS === 'true',
  };
}
