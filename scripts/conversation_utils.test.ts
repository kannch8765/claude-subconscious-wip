import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.stubGlobal('fetch', fetchMock);

describe('createConversation', () => {
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses trailing-slash conversations endpoint with agent_id query', async () => {
    vi.stubEnv('LETTA_BASE_URL', 'https://letta.example.com');

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'conversation-123' }),
    });

    const { createConversation } = await import('./conversation_utils.js');
    const conversationId = await createConversation('test-key', 'agent-123');

    expect(conversationId).toBe('conversation-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://letta.example.com/v1/conversations/?agent_id=agent-123',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
      }),
    );
  });


  it('retries one transient 5xx only when explicitly enabled', async () => {
    vi.stubEnv('LETTA_BASE_URL', 'https://letta.example.com');
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => '{"detail":"temporary"}' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'conversation-recovered' }) });

    const { createConversation } = await import('./conversation_utils.js');
    const conversationId = await createConversation('test-key', 'agent-123', () => {}, { transientRetries: 1, retryDelayMs: 0 });

    expect(conversationId).toBe('conversation-recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a transient 5xx by default', async () => {
    vi.stubEnv('LETTA_BASE_URL', 'https://letta.example.com');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => '{"detail":"temporary"}' });

    const { createConversation } = await import('./conversation_utils.js');
    await expect(createConversation('test-key', 'agent-123')).rejects.toThrow('Failed to create conversation: 500');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
