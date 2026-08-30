/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { useRealtimeCollection } from "@/lib/supabase/useRealtimeCollection";
import { getSupabaseClient, isSupabaseConfigured, requireAuthenticatedClient } from "@/lib/supabase/client";
import { useAccessToken, useSessionWallet } from "@/lib/supabase/useSession";

jest.mock("@/lib/supabase/client", () => ({
  isSupabaseConfigured: jest.fn(),
  getSupabaseClient: jest.fn(),
  requireSupabaseClient: jest.fn(),
  requireAuthenticatedClient: jest.fn(),
  resetSupabaseClient: jest.fn(),
  supabase: null,
}));
jest.mock("@/lib/supabase/useSession");

interface TestItem {
  id: string;
  title: string;
  version: number;
  updatedAt: string;
}

describe("useRealtimeCollection — Version Monotonicity & Out-of-Order Delivery (Issue #157 / Epic #51)", () => {
  const WALLET = "GAALICEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  let realtimeCallbacks: Record<string, Function>;
  let mockChannel: any;

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    realtimeCallbacks = {};

    mockChannel = {
      on: jest.fn((event: string, opts: any, callback: Function) => {
        realtimeCallbacks[opts.event] = callback;
        return mockChannel;
      }),
      subscribe: jest.fn((cb: Function) => {
        if (cb) cb("SUBSCRIBED");
        return mockChannel;
      }),
    };

    jest.mocked(isSupabaseConfigured).mockReturnValue(true);
    const mockClient = {
      channel: jest.fn(() => mockChannel),
      removeChannel: jest.fn(),
    };
    jest.mocked(getSupabaseClient).mockReturnValue(mockClient as any);
    jest.mocked(requireAuthenticatedClient).mockReturnValue(mockClient as any);

    jest.mocked(useAccessToken).mockReturnValue("test-token");
    jest.mocked(useSessionWallet).mockReturnValue(WALLET);
  });

  it("Invariant 5: Applies newer version events and ignores stale out-of-order events", async () => {
    const fetchAll = jest.fn().mockResolvedValue([
      { id: "item-1", title: "Original Title", version: 1, updatedAt: "2026-01-01T00:00:00Z" },
    ]);

    const { result } = renderHook(() =>
      useRealtimeCollection<TestItem>({
        table: "expenses",
        cacheKey: "test_expenses",
        fetchAll,
        fromRow: (row) => row as TestItem,
        getId: (item) => item.id,
        connectedWallet: WALLET,
      }),
    );

    await act(async () => {});

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].version).toBe(1);

    // 1. Receive UPDATE event for version 3 (newer event)
    await act(async () => {
      realtimeCallbacks["UPDATE"]({
        new: { id: "item-1", title: "Version 3 Update", version: 3, updatedAt: "2026-01-01T00:03:00Z" },
      });
    });

    expect(result.current.items[0].title).toBe("Version 3 Update");
    expect(result.current.items[0].version).toBe(3);

    // 2. Receive delayed out-of-order UPDATE event for version 2 (older event arrives late)
    await act(async () => {
      realtimeCallbacks["UPDATE"]({
        new: { id: "item-1", title: "Stale Version 2", version: 2, updatedAt: "2026-01-01T00:02:00Z" },
      });
    });

    // Stale version 2 MUST be discarded: local state remains version 3!
    expect(result.current.items[0].title).toBe("Version 3 Update");
    expect(result.current.items[0].version).toBe(3);

    // 3. Receive self-echo UPDATE event for version 3 (same version duplicate)
    await act(async () => {
      realtimeCallbacks["UPDATE"]({
        new: { id: "item-1", title: "Version 3 Update", version: 3, updatedAt: "2026-01-01T00:03:00Z" },
      });
    });

    expect(result.current.items[0].version).toBe(3);
  });
});
