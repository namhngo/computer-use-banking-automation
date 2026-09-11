import { z } from 'zod';

const credentialsSchema = z.object({
  MOCK_USERNAME: z.string().trim().min(1).max(100),
  MOCK_PASSWORD: z.string().min(8).max(200).refine((value) => value.trim().length > 0),
});

export function readMockCredentials(env: NodeJS.ProcessEnv = process.env) {
  const result = credentialsSchema.safeParse({
    MOCK_USERNAME: env.MOCK_USERNAME,
    MOCK_PASSWORD: env.MOCK_PASSWORD,
  });
  if (!result.success) {
    throw new Error('Set MOCK_USERNAME and MOCK_PASSWORD in .env; see .env.example.');
  }
  return { username: result.data.MOCK_USERNAME, password: result.data.MOCK_PASSWORD };
}
