import { ForbiddenException } from '@nestjs/common';
import axios from 'axios';
import { canDeploySource, sourceRepository, SourceRepository } from './repository-access';

const repo = (owner: string, type: string, visibility: SourceRepository['visibility'], admin = false) => ({
  full_name: `${owner}/app`, owner: { login: owner, type }, visibility,
  private: visibility === 'private', permissions: { admin },
} as SourceRepository);

afterEach(() => jest.restoreAllMocks());

it('shows private and internal repos only after opt-in, and never admits third-party personal repos', () => {
  for (const source of [repo('Alice', 'User', 'private'), repo('team', 'Organization', 'internal', true)]) {
    expect(canDeploySource('alice', source, false)).toBe(false);
    expect(canDeploySource('alice', source, true)).toBe(true);
  }
  expect(canDeploySource('alice', repo('bob', 'User', 'public', true), true)).toBe(false);
});

it('requires GitHub repository admin rights for both public and private organization repos', async () => {
  const get = jest.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: repo('team', 'Organization', 'public') });
  await expect(sourceRepository('user-token', 'alice', 'team/app', true)).rejects.toThrow(ForbiddenException);
  get.mockResolvedValueOnce({ status: 200, data: repo('team', 'Organization', 'public', true) });
  await expect(sourceRepository('user-token', 'alice', 'team/app', false)).resolves.toMatchObject({ full_name: 'team/app' });
});

it('rejects an unexpected resolved repository identity and an invalid path', async () => {
  const get = jest.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: repo('alice', 'User', 'public') });
  await expect(sourceRepository('user-token', 'alice', 'alice/renamed', true)).rejects.toThrow(ForbiddenException);
  get.mockClear();
  await expect(sourceRepository('user-token', 'alice', 'alice/..', true)).rejects.toThrow(ForbiddenException);
  expect(get).not.toHaveBeenCalled();
});
