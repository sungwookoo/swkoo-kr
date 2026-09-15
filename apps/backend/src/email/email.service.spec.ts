jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
import axios from 'axios';
import { EmailService } from './email.service';

describe('EmailService delivery', () => {
  const service = new EmailService({ enabled: true, resendApiKey: 'test',
    from: 'test@example.com', appBaseUrl: 'https://example.com' } as never);
  const payload = { to: 'alice@example.com', login: 'alice', repo: 'app',
    liveUrl: 'https://example.com', imageDigest: 'sha256:abc' };

  it('passes a stable idempotency key to Resend', async () => {
    (axios.post as jest.Mock).mockResolvedValue({ status: 200 });
    expect(await service.sendDeploySuccess(payload, 'deploy-success/test')).toBe(true);
    expect(axios.post).toHaveBeenCalledWith('https://api.resend.com/emails',
      expect.objectContaining({ to: ['alice@example.com'] }),
      expect.objectContaining({ headers: expect.objectContaining({ 'Idempotency-Key': 'deploy-success/test' }) }));
  });

  it('reports a transient failure to the retry worker', async () => {
    (axios.post as jest.Mock).mockRejectedValue(new Error('timeout'));
    expect(await service.sendDeploySuccess(payload, 'deploy-success/test')).toBe(false);
  });
});
