import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { AuthorizationError } from '@/lib/auth/authorization';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), submit: vi.fn(), cancel: vi.fn(), conversations: vi.fn(), questions: vi.fn(), answer: vi.fn(), result: vi.fn(), chart: vi.fn(), live: vi.fn() }));
vi.mock('./authorization', () => ({ authenticateBiAgent: mocks.auth }));
vi.mock('./requests', () => ({ submitBiAgentQuestion: mocks.submit, cancelBiAgentQuestion: mocks.cancel,
  listBiAgentConversations: mocks.conversations, listBiAgentQuestions: mocks.questions }));
vi.mock('./results', () => ({ readBiAgentAnswer: mocks.answer, readBiAgentResultPage: mocks.result, readBiAgentChart: mocks.chart }));
vi.mock('@/lib/services/pi-agent-worker-registry', () => ({ hasLivePiAgentWorker: mocks.live }));
import { GET, POST } from '@/app/api/bi/assistant/route';
const auth = { actorId: 'member-a', sessionId: 'private-session', workspaceId: 'account:member-a' };
const question = () => ({ dataset_id: 'official', dataset_version: 2, workspace_id: auth.workspaceId,
  conversation_id: randomUUID(), expected_conversation_version: 0, idempotency_key: randomUUID(),
  model: 'deepseek-v4-flash', instruction: '当前净销售额是多少？', page_scope: { module: 'overview' } });
const post = (body: unknown, headers: Record<string, string> = {}) => new NextRequest('http://shopgate.test/api/bi/assistant',
  { method: 'POST', headers: { origin: 'http://shopgate.test', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const get = (query: string) => new NextRequest(`http://shopgate.test/api/bi/assistant?${query}`);
describe('BI assistant HTTP boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.auth.mockResolvedValue(auth); mocks.live.mockResolvedValue(true);
    mocks.submit.mockImplementation(async (_auth, _question, deps) => { await deps.assertAvailable(); return { replayed: false }; });
  });
  afterEach(() => vi.unstubAllEnvs());
  it('uses server session authority and admits only same-origin bounded strict input', async () => {
    const q = question();
    const response = await POST(post({ action: 'submit', question: q }));
    expect(response.status).toBe(202); expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.auth).toHaveBeenCalledWith(expect.any(Headers), auth.workspaceId, 'run');
    expect(mocks.submit.mock.calls[0][0]).toEqual(auth);
    for (const body of [{ action: 'submit', question: { ...q, actor_id: 'other' } },
      { action: 'submit', question: { ...q, sessionId: 'other' } },
      { action: 'submit', question: { ...q, page_scope: { module: 'overview', sql: 'SELECT private' } } },
      { action: 'submit', question: { ...q, instruction: 'x'.repeat(8001) } }]) {
      expect((await POST(post(body))).status).toBe(422);
    }
    expect((await POST(post({ action: 'submit', question: q }, { origin: 'https://foreign.invalid' }))).status).toBe(403);
    expect((await POST(post({ action: 'submit', question: q }, { 'content-length': '999999' }))).status).toBe(413);
    expect((await POST(post({ action: 'submit', question: q }, { 'content-encoding': 'gzip' }))).status).toBe(415);
    expect(mocks.submit).toHaveBeenCalledTimes(1);
  });
  it('supports private historical reads and cancel without granting model execution', async () => {
    const conversation = randomUUID(), run = randomUUID(), result = randomUUID();
    mocks.questions.mockResolvedValue({ rows: [] }); mocks.answer.mockResolvedValue({ answer: null });
    mocks.result.mockResolvedValue({ rows: [] }); mocks.cancel.mockResolvedValue({ id: run, status: 'cancelled' });
    expect((await GET(get(`action=questions&conversation_id=${conversation}&page=2`))).status).toBe(200);
    expect(mocks.questions).toHaveBeenCalledWith(auth, conversation, 2);
    expect((await GET(get(`action=questions&conversation_id=${conversation}`))).status).toBe(200);
    expect(mocks.questions).toHaveBeenLastCalledWith(auth, conversation, 1);
    expect((await GET(get(`action=answer&run_id=${run}`))).status).toBe(200);
    expect((await GET(get(`action=result&run_id=${run}&result_id=${result}&page=2`))).status).toBe(200);
    expect(mocks.result).toHaveBeenCalledWith(auth, run, result, 2);
    mocks.chart.mockResolvedValue({ rows: [] });
    expect((await GET(get(`action=chart&run_id=${run}&result_id=${result}`))).status).toBe(200);
    expect(mocks.chart).toHaveBeenCalledWith(auth, run, result);
    expect((await POST(post({ action: 'cancel', run_id: run }))).status).toBe(200);
    expect(mocks.auth).toHaveBeenLastCalledWith(expect.any(Headers), undefined, 'read');
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('rejects duplicate, unknown, unbounded and foreign input before querying history', async () => {
    for (const params of ['action=conversations&dataset_id=a&page=0', 'action=conversations&dataset_id=a&page=1000001',
      'action=conversations&dataset_id=a&dataset_id=b', 'action=answer&run_id=not-a-uuid',
      'action=conversations&dataset_id=a&actor_id=other']) expect((await GET(get(params))).status).toBe(422);
    expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.conversations).not.toHaveBeenCalled();
    mocks.auth.mockRejectedValueOnce(new AuthorizationError('FORBIDDEN', 403, 'private policy text'));
    const response = await POST(post({ action: 'submit', question: question() }));
    expect(response.status).toBe(403); expect(JSON.stringify(await response.json())).not.toContain('private policy text');
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('reports live availability without calling models or disclosing keys and rejects offline new work', async () => {
    vi.stubEnv('SHOPGATE_LLM_AGENT_ENABLED', '1'); vi.stubEnv('DEEPSEEK_API_KEY', 'private-test-key');
    mocks.live.mockResolvedValue(false);
    const response = await GET(get('action=availability'));
    expect(response.status).toBe(200); const body = await response.json();
    expect(body.data.worker_available).toBe(false);
    expect(body.data.models).toContainEqual(expect.objectContaining({ id: 'deepseek-v4-flash' }));
    expect(JSON.stringify(body)).not.toContain('private-test-key'); expect(mocks.submit).not.toHaveBeenCalled();
    expect((await POST(post({ action: 'submit', question: question() }))).status).toBe(503);
    // Replay is decided in the inbox before checking worker availability.
    mocks.submit.mockResolvedValueOnce({ replayed: true });
    expect((await POST(post({ action: 'submit', question: question() }))).status).toBe(200);
  });
  it('never returns arbitrary database or provider errors', async () => {
    mocks.questions.mockRejectedValueOnce(new Error('SELECT secret FROM private_database'));
    const response = await GET(get(`action=questions&conversation_id=${randomUUID()}`));
    expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain('private_database');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
});
