export const dynamic = 'force-dynamic';

export function GET(): Response {
  const revision = process.env.BUILD_REVISION;
  return Response.json({ revision: /^[a-f0-9]{40}$/.test(revision ?? '') ? revision : null },
    { headers: { 'Cache-Control': 'no-store' } });
}
