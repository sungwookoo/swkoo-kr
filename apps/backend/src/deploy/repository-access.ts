import { ForbiddenException } from '@nestjs/common';
import axios from 'axios';

export interface SourceRepository {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  language: string | null;
  default_branch: string;
  html_url: string;
  updated_at: string;
  fork: boolean;
  private: boolean;
  visibility: 'public' | 'private' | 'internal';
  owner: { login: string; type: string };
  permissions?: { admin?: boolean };
}

export const sourceNamePattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

export function canDeploySource(
  githubLogin: string, repository: SourceRepository, allowPrivate: boolean,
): boolean {
  if (!sourceNamePattern.test(repository.full_name) || !repository.owner) return false;
  if ((repository.private || repository.visibility !== 'public') && !allowPrivate) return false;
  return repository.owner.type === 'User'
    ? repository.owner.login.toLowerCase() === githubLogin.toLowerCase()
    : repository.owner.type === 'Organization' && repository.permissions?.admin === true;
}

export async function sourceRepository(
  token: string, githubLogin: string, fullName: string, allowPrivate: boolean,
): Promise<SourceRepository> {
  const denied = new ForbiddenException({
    reason: 'NOT_REPO_OWNER',
    message: '본인 계정의 저장소 또는 GitHub에서 관리 권한을 가진 조직 저장소를 선택해 주세요.',
  });
  if (!sourceNamePattern.test(fullName)) throw denied;
  const response = await axios.get<SourceRepository>(`https://api.github.com/repos/${fullName}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    timeout: 5000, maxRedirects: 0,
    validateStatus: status => [200, 403, 404, 451].includes(status),
  });
  if (response.status !== 200 || response.data.full_name.toLowerCase() !== fullName.toLowerCase()
    || !canDeploySource(githubLogin, response.data, allowPrivate)) throw denied;
  return response.data;
}
