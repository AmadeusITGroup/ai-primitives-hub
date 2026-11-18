import {
  expect,
  it,
  vi,
} from 'vitest';
import {
  HttpSnapshot,
} from '../../src/governance/http-snapshot';

const response = { statusCode: 200, body: new Uint8Array(), finalUrl: 'https://api.github.com/test', headers: {} };
const request = { url: response.finalUrl, headers: { Authorization: 'identity-a', Accept: 'application/json' } };

it('coalesces concurrent and later GETs only within the same run and credentials', async () => {
  const fetch = vi.fn().mockResolvedValue(response);
  const snapshot = new HttpSnapshot({ fetch });
  await Promise.all([snapshot.fetch(request), snapshot.fetch(request)]);
  await snapshot.fetch(request);
  expect(fetch).toHaveBeenCalledTimes(1);
  await snapshot.fetch({ ...request, headers: { ...request.headers, Authorization: 'identity-b' } });
  await snapshot.fetch({ ...request, headers: { ...request.headers, Accept: 'application/octet-stream' } });
  await new HttpSnapshot({ fetch }).fetch(request);
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('never retains errors or rate-limit responses and does not cache POSTs', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error('Timeout')).mockResolvedValueOnce({ ...response, statusCode: 429 }).mockResolvedValue(response);
  const snapshot = new HttpSnapshot({ fetch });
  await expect(snapshot.fetch(request)).rejects.toThrow('Timeout');
  expect((await snapshot.fetch(request)).statusCode).toBe(429);
  expect((await snapshot.fetch(request)).statusCode).toBe(200);
  await snapshot.fetch(request);
  expect(fetch).toHaveBeenCalledTimes(3);
  await snapshot.fetch({ ...request, method: 'POST' });
  await snapshot.fetch({ ...request, method: 'POST' });
  expect(fetch).toHaveBeenCalledTimes(5);
});
