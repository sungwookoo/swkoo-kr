import { registerAs } from '@nestjs/config';

export const githubConfig = registerAs('github', () => ({
  token: process.env.GITHUB_TOKEN ?? null,
}));

