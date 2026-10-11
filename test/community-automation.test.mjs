import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileEffectReceiptJournal, InMemoryEffectReceiptJournal, evaluateReactionRoleBinding, executeRoleEffect, importEffectReceiptJournal, rollbackPlan } from "../src/index.mjs";

const at = "2026-08-29T00:00:00.000Z";
const event = () => ({ type: "DiscordReactionEvent", version: 1, eventId: "event", occurredAt: at, kind: "add", guildId: "guild", channelId: "channel", messageId: "message", actorId: "actor", emoji: { name: "wave" } });
const binding = () => ({ type: "DiscordReactionRoleBinding", version: 1, id: "role", revision: 2, guildId: "guild", channelId: "channel", messageId: "message", emoji: { name: "wave" }, onAdd: ["add-role"], onRemove: ["remove-role"], roleId: "member" });
const state = (roles = [], observedAt = at, patch = {}) => ({ type: "DiscordReactionPolicyState", version: 1, observedAt, sourceRevision: "snapshot-1", messagePresent: true, role: { exists: true, managed: false, position: 2, botHighestPosition: 3 }, actorRoleIds: roles, ...patch });

test("rejects duplicate and contradictory actions, stale state, managed roles, and hierarchy drift", () => {
  assert.throws(() => evaluateReactionRoleBinding(event(), { ...binding(), onAdd: ["add-role", "add-role"] }, state(), new Date(at)));
  assert.throws(() => evaluateReactionRoleBinding(event(), { ...binding(), onAdd: ["add-role", "remove-role"] }, state(), new Date(at)));
  assert.equal(evaluateReactionRoleBinding(event(), binding(), state([], "2026-08-28T00:00:00.000Z")).kind, "refuse");
  assert.equal(evaluateReactionRoleBinding(event(), binding(), state([], at, { role: { exists: true, managed: true, position: 2, botHighestPosition: 3 } })).kind, "refuse");
  assert.equal(evaluateReactionRoleBinding(event(), binding(), state([], at, { role: { exists: true, managed: false, position: 3, botHighestPosition: 3 } })).kind, "refuse");
});
test("rechecks state immediately before execution and records drift without mutation", async () => {
  const proposed = evaluateReactionRoleBinding(event(), binding(), state(), new Date(at)); assert.equal(proposed.kind, "propose"); if (proposed.kind !== "propose") return;
  let reads = 0, calls = 0;
  const receipt = await executeRoleEffect(proposed.plans[0], new InMemoryEffectReceiptJournal(), { async addRole() { calls += 1; }, async removeRole() {} }, async () => (++reads === 1 ? state() : state(["member"])), at);
  assert.equal(receipt.status, "failed"); assert.equal(calls, 0);
});
test("recovery prevents crash replay and imported journals reject duplicate plans", async () => {
  const decision = evaluateReactionRoleBinding(event(), binding(), state(), new Date(at)); if (decision.kind !== "propose") throw new Error("proposal expected");
  const journal = new InMemoryEffectReceiptJournal(); await journal.reserve(decision.plans[0], at);
  assert.equal((await journal.recover("2026-08-29T00:01:00.000Z"))[0]?.status, "recoverable");
  assert.equal((await journal.reserve(decision.plans[0], at)).status, "duplicate");
  const portable = await journal.export(); assert.throws(() => importEffectReceiptJournal({ ...portable, receipts: [...portable.receipts, ...portable.receipts] }));
});
test("rollback is conditional, revalidated, and journaled", async () => {
  const decision = evaluateReactionRoleBinding(event(), binding(), state(), new Date(at)); if (decision.kind !== "propose") throw new Error("proposal expected");
  const journal = new InMemoryEffectReceiptJournal(); let calls = 0;
  const executor = { async addRole() { calls += 1; }, async removeRole() { calls += 1; } };
  const applied = await executeRoleEffect(decision.plans[0], journal, executor, async () => state(), at);
  const rollback = rollbackPlan(applied); assert.equal(applied.status, "applied"); assert.ok(rollback);
  assert.equal((await executeRoleEffect(rollback, journal, executor, async () => state(["member"]), "2026-08-29T00:01:00.000Z")).status, "applied");
  assert.equal(calls, 2);
});
test("filesystem journal persists a validated reservation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "discord-journal-")), file = path.join(root, "journal.json");
  const decision = evaluateReactionRoleBinding(event(), binding(), state(), new Date(at)); if (decision.kind !== "propose") throw new Error("proposal expected");
  const journal = await FileEffectReceiptJournal.open(file); await journal.reserve(decision.plans[0], at);
  assert.equal((await (await FileEffectReceiptJournal.open(file)).export()).receipts.length, 1);
  assert.match(await readFile(file, "utf8"), /DiscordCommunityEffectReceiptJournal/);
});
