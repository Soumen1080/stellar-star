/** @jest-environment jsdom */

/**
 * useRealtimeCollection channel de-duplication (#448): consumers share one
 * channel per wallet/table, callback identity changes and remounts never open
 * another, and a recovered channel triggers a resync fetch.
 */

import { act, renderHook } from "@testing-library/react";
import { useRealtimeCollection } from "@/lib/supabase/useRealtimeCollection";
import { getSupabaseClient, isSupabaseConfigured, requireAuthenticatedClient } from "@/lib/supabase/client";
import { useAccessToken, useSessionWallet } from "@/lib/supabase/useSession";
import { configureRealtimeRegistry, getRealtimeTelemetry, resetRealtimeChannels } from "@/lib/supabase/realtimeRegistry";

jest.mock("@/lib/supabase/client", () => ({
  isSupabaseConfigured: jest.fn(),
  getSupabaseClient: jest.fn(),
  requireSupabaseClient: jest.fn(),
  requireAuthenticatedClient: jest.fn(),
  resetSupabaseClient: jest.fn(),
  supabase: null,
}));
jest.mock("@/lib/supabase/useSession");

interface Item {
  id: string;
  version: number;
}

const WALLET = "GAALICEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("useRealtimeCollection — shared channels (#448)", () => {
  let channels: Array<{ callbacks: Record<string, Function>; status?: Function; removed: boolean }>;
  let mockClient: { channel: jest.Mock; removeChannel: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    configureRealtimeRegistry({ teardownGraceMs: 1_000, random: () => 0 });
    channels = [];

    mockClient = {
      channel: jest.fn(() => {
        const record = { callbacks: {} as Record<string, Function>, status: undefined as Function | undefined, removed: false };
        channels.push(record);
        const channel: any = {
          on: jest.fn((_type: string, opts: any, cb: Function) => {
            record.callbacks[opts.event] = cb;
            return channel;
          }),
          subscribe: jest.fn((cb: Function) => {
            record.status = cb;
            cb("SUBSCRIBED");
            return channel;
          }),
          __record: record,
        };
        return channel;
      }),
      removeChannel: jest.fn((channel: any) => {
        channel.__record.removed = true;
        return Promise.resolve("ok");
      }),
    };

    jest.mocked(isSupabaseConfigured).mockReturnValue(true);
    jest.mocked(getSupabaseClient).mockReturnValue(mockClient as any);
    jest.mocked(requireAuthenticatedClient).mockReturnValue(mockClient as any);
    jest.mocked(useAccessToken).mockReturnValue("test-token");
    jest.mocked(useSessionWallet).mockReturnValue(WALLET);
  });

  afterEach(() => {
    resetRealtimeChannels();
  });

  const render = (fetchAll: () => Promise<Item[]>) =>
    renderHook(() =>
      useRealtimeCollection<Item>({
        table: "expenses",
        cacheKey: "dedupe_expenses",
        fetchAll,
        // Deliberately inline: a new identity every render must not re-subscribe.
        fromRow: (row) => row as Item,
        getId: (item) => item.id,
        connectedWallet: WALLET,
      }),
    );

  it("two consumers of the same wallet and table share one channel and both receive events", async () => {
    const fetchAll = jest.fn().mockResolvedValue([]);
    const a = render(fetchAll);
    const b = render(fetchAll);
    await act(async () => {});

    expect(mockClient.channel).toHaveBeenCalledTimes(1);

    act(() => {
      channels[0].callbacks["INSERT"]({ new: { id: "e1", version: 1 } });
    });
    expect(a.result.current.items.map((i) => i.id)).toEqual(["e1"]);
    expect(b.result.current.items.map((i) => i.id)).toEqual(["e1"]);
  });

  it("re-renders and unmount/remount during navigation never open another channel", async () => {
    const fetchAll = jest.fn().mockResolvedValue([]);
    let hook = render(fetchAll);
    await act(async () => {});

    for (let i = 0; i < 10; i++) {
      hook.rerender();
      hook.unmount();
      hook = render(fetchAll);
      await act(async () => {});
    }

    expect(mockClient.channel).toHaveBeenCalledTimes(1);
    expect(channels.filter((c) => !c.removed)).toHaveLength(1);
    expect(getRealtimeTelemetry().peakLiveChannels).toBe(1);
  });

  it("applies deletes and ignores stale versions through the shared channel", async () => {
    const fetchAll = jest.fn().mockResolvedValue([{ id: "e1", version: 2 }]);
    const { result } = render(fetchAll);
    await act(async () => {});

    act(() => {
      channels[0].callbacks["UPDATE"]({ new: { id: "e1", version: 1 } });
    });
    expect(result.current.items[0].version).toBe(2);

    act(() => {
      channels[0].callbacks["DELETE"]({ old: { id: "e1" } });
    });
    expect(result.current.items).toEqual([]);
  });

  it("refetches after the channel recovers from an error", async () => {
    jest.useFakeTimers();
    try {
      const fetchAll = jest.fn().mockResolvedValue([]);
      render(fetchAll);
      await act(async () => {});
      const callsBefore = fetchAll.mock.calls.length;

      act(() => {
        channels[0].status?.("CHANNEL_ERROR");
      });
      await act(async () => {
        jest.advanceTimersByTime(0);
      });

      expect(mockClient.channel).toHaveBeenCalledTimes(2);
      expect(channels[0].removed).toBe(true);
      expect(fetchAll.mock.calls.length).toBeGreaterThan(callsBefore);
    } finally {
      jest.useRealTimers();
    }
  });
});
