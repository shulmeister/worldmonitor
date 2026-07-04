// @vitest-environment node

import { describe, expect, test } from "vitest";

import {
  DIRECT_LLM_DAILY_QUOTA_LIMIT,
  directLlmDailyQuotaKey,
  reserveDirectLlmQuota,
} from "../_shared/direct-llm-quota";

describe("direct LLM daily quota", () => {
  test("uses a UTC daily key in the direct-LLM namespace", () => {
    const key = directLlmDailyQuotaKey("user_123", new Date(Date.UTC(2026, 6, 4, 23, 59, 0)));
    expect(key).toBe("llm:direct-usage:user_123:2026-07-04");
  });

  test("reserves with INCR-first semantics and sets the 48h TTL", async () => {
    const calls: Array<Array<Array<string | number>>> = [];
    const result = await reserveDirectLlmQuota({
      userId: "user_123",
      date: new Date(Date.UTC(2026, 6, 4, 12, 0, 0)),
      pipeline: async (cmds) => {
        calls.push(cmds);
        return [{ result: 1 }, { result: "OK" }];
      },
    });

    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual([
      ["INCR", "llm:direct-usage:user_123:2026-07-04"],
      ["EXPIRE", "llm:direct-usage:user_123:2026-07-04", 172800],
    ]);
  });

  test("rolls back and returns cap-exceeded on the first over-limit reservation", async () => {
    const calls: Array<Array<Array<string | number>>> = [];
    const result = await reserveDirectLlmQuota({
      userId: "user_123",
      date: new Date(Date.UTC(2026, 6, 4, 12, 0, 0)),
      pipeline: async (cmds) => {
        calls.push(cmds);
        if (cmds[0]?.[0] === "DECR") return [{ result: DIRECT_LLM_DAILY_QUOTA_LIMIT }];
        return [{ result: DIRECT_LLM_DAILY_QUOTA_LIMIT + 1 }, { result: "OK" }];
      },
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "cap-exceeded",
      floor: DIRECT_LLM_DAILY_QUOTA_LIMIT,
    });
    expect(calls.at(-1)).toEqual([["DECR", "llm:direct-usage:user_123:2026-07-04"]]);
  });

  test("fails closed when Redis reservation cannot be proven", async () => {
    const result = await reserveDirectLlmQuota({
      userId: "user_123",
      pipeline: async () => [],
    });

    expect(result).toMatchObject({ ok: false, reason: "redis-unavailable" });
  });
});
