import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

const VARIANT = "finance";
const USER = {
  subject: "user-prefs-dup",
  tokenIdentifier: "clerk|user-prefs-dup",
  email: "u@example.com",
};

type Seed = {
  syncVersion: number;
  updatedAt: number;
  data?: Record<string, unknown>;
  userId?: string;
  variant?: string;
};

function seedRow(t: ReturnType<typeof convexTest>, s: Seed) {
  return t.run((ctx) =>
    ctx.db.insert("userPreferences", {
      userId: s.userId ?? USER.subject,
      variant: s.variant ?? VARIANT,
      data: s.data ?? { seededAt: s.syncVersion },
      schemaVersion: 2,
      updatedAt: s.updatedAt,
      syncVersion: s.syncVersion,
    }),
  );
}

function rowsFor(
  t: ReturnType<typeof convexTest>,
  userId = USER.subject,
  variant = VARIANT,
) {
  return t.run((ctx) =>
    ctx.db
      .query("userPreferences")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", userId).eq("variant", variant),
      )
      .collect(),
  );
}

async function countRows(
  t: ReturnType<typeof convexTest>,
  userId = USER.subject,
  variant = VARIANT,
) {
  return (await rowsFor(t, userId, variant)).length;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("userPreferences: duplicate-row tolerance (#4567)", () => {
  test("setPreferences heals duplicate rows instead of throwing on .unique()", async () => {
    const t = convexTest(schema, modules);
    await seedRow(t, { syncVersion: 3, updatedAt: 100 });
    await seedRow(t, { syncVersion: 5, updatedAt: 200 }); // canonical
    await seedRow(t, {
      userId: "other-user",
      variant: "tech",
      syncVersion: 9,
      updatedAt: 300,
    });
    expect(await countRows(t)).toBe(2);
    expect(await countRows(t, "other-user", "tech")).toBe(1);

    const asUser = t.withIdentity(USER);
    const result = await asUser.mutation(api.userPreferences.setPreferences, {
      variant: VARIANT,
      data: { theme: "dark" },
      expectedSyncVersion: 5,
      schemaVersion: 2,
    });

    expect(result).toEqual({ ok: true, syncVersion: 6 });
    expect(await countRows(t)).toBe(1); // stale duplicate deleted (self-heal)
    expect(await countRows(t, "other-user", "tech")).toBe(1);

    const got = await asUser.query(api.userPreferences.getPreferences, { variant: VARIANT });
    expect(got?.syncVersion).toBe(6);
    expect(got?.data).toEqual({ theme: "dark" });
  });

  test("getPreferences returns the canonical (max syncVersion) row when duplicates exist", async () => {
    const t = convexTest(schema, modules);
    await seedRow(t, { syncVersion: 2, updatedAt: 100 });
    await seedRow(t, { syncVersion: 7, updatedAt: 200 }); // canonical
    const got = await t.withIdentity(USER).query(api.userPreferences.getPreferences, {
      variant: VARIANT,
    });
    expect(got?.syncVersion).toBe(7);
  });

  test("canonical picker breaks syncVersion/updatedAt ties with the newest row", async () => {
    const t = convexTest(schema, modules);
    await seedRow(t, {
      syncVersion: 4,
      updatedAt: 100,
      data: { theme: "stale" },
    });
    await delay(2);
    const newestId = await seedRow(t, {
      syncVersion: 4,
      updatedAt: 100,
      data: { theme: "newest" },
    });

    const got = await t.withIdentity(USER).query(api.userPreferences.getPreferences, {
      variant: VARIANT,
    });
    expect(got?._id).toBe(newestId);
    expect(got?.data).toEqual({ theme: "newest" });
  });

  test("CAS conflict returns CONFLICT against the canonical duplicate row", async () => {
    const t = convexTest(schema, modules);
    await seedRow(t, { syncVersion: 3, updatedAt: 100 });
    await seedRow(t, { syncVersion: 5, updatedAt: 200 }); // canonical

    const result = await t.withIdentity(USER).mutation(api.userPreferences.setPreferences, {
      variant: VARIANT,
      data: { x: 1 },
      expectedSyncVersion: 3, // matches stale duplicate, not canonical
      schemaVersion: 2,
    });

    expect(result).toEqual({ ok: false, reason: "CONFLICT", actualSyncVersion: 5 });
    // Conflict is a no-op; healing waits for a valid write.
    expect(await countRows(t)).toBe(2);
  });

  test("happy path: no existing row inserts at syncVersion 1", async () => {
    const t = convexTest(schema, modules);
    const result = await t.withIdentity(USER).mutation(api.userPreferences.setPreferences, {
      variant: VARIANT,
      data: { a: 1 },
      expectedSyncVersion: 0,
      schemaVersion: 2,
    });
    expect(result).toEqual({ ok: true, syncVersion: 1 });
    expect(await countRows(t)).toBe(1);
  });
});
