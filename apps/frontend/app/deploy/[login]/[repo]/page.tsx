import { StatusClient } from './page.client';

// Next 15+: dynamic route params are async. The server component must
// await the Promise before reading individual fields.
export default async function DeployStatusPage({
  params,
}: {
  params: Promise<{ login: string; repo: string }>;
}) {
  const { login, repo } = await params;
  return <StatusClient login={login} repo={repo} />;
}
