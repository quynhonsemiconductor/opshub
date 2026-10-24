import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/shared/api/client';
import type { components } from '@/shared/api/types';

type CreateTerminalBody = components['schemas']['CreateTerminalDto'];
type CreateCardBody = components['schemas']['CreateCardDto'];
type UpdateCardBody = components['schemas']['UpdateCardDto'];

export function useTerminals() {
  return useQuery({
    queryKey: ['door', 'terminals'],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/door/terminals');
      if (error || !data) throw new Error('Failed to load terminals');
      return data;
    },
  });
}

export function useCards(status: string, limit: number, offset: number) {
  return useQuery({
    queryKey: ['door', 'cards', status, limit, offset],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/door/cards', {
        params: { query: { status: (status || undefined) as never, limit, offset } },
      });
      if (error || !data) throw new Error('Failed to load cards');
      return data;
    },
    placeholderData: (prev) => prev,
  });
}

export function useUnknownCards() {
  return useQuery({
    queryKey: ['door', 'unknown-cards'],
    queryFn: async () => {
      const { data, error } = await api.GET('/v1/door/unknown-cards');
      if (error || !data) throw new Error('Failed to load unknown cards');
      return data;
    },
  });
}

/**
 * The writes. The token-bearing responses (create / regenerate) return the token string so the
 * caller can show it ONCE — the invalidate happens after the reveal dialog is dismissed, so a
 * re-render mid-dialog can never blank the only copy of the credential.
 */
export function useDoorWrites() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['door'] });

  async function createTerminal(body: CreateTerminalBody) {
    const { data, error } = await api.POST('/v1/door/terminals', { body });
    if (error || !data) throw new Error('Failed to register the terminal');
    await invalidate();
    return data;
  }

  async function regenerateTerminalToken(id: string) {
    const { data, error } = await api.POST('/v1/door/terminals/{id}/token', {
      params: { path: { id } },
    });
    if (error || !data) throw new Error('Failed to regenerate the token');
    await invalidate();
    return data;
  }

  async function revokeTerminal(id: string) {
    const { error } = await api.POST('/v1/door/terminals/{id}/revoke', {
      params: { path: { id } },
    });
    if (error) throw new Error('Failed to revoke the terminal');
    await invalidate();
  }

  async function createCard(body: CreateCardBody) {
    const { error } = await api.POST('/v1/door/cards', { body });
    if (error) throw new Error('Failed to enrol the card');
    await invalidate();
  }

  async function updateCard(id: string, body: UpdateCardBody) {
    const { error } = await api.PATCH('/v1/door/cards/{id}', { params: { path: { id } }, body });
    if (error) throw new Error('Failed to update the card');
    await invalidate();
  }

  return { createTerminal, regenerateTerminalToken, revokeTerminal, createCard, updateCard };
}
