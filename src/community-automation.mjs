import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileText } from "@red-cup-engineering/computer-file-engineering-services-section/write-file";
import { semanticHex } from "@red-cup-engineering/computer-content-address-engineering-services-section/semiotic-content-address";

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
function required(value, label) { if (!identifier.test(value)) throw new TypeError(`${label} must be a nonempty identifier`); return value; }
function instant(value, label) { if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${label} must be an ISO timestamp`); return new Date(value).toISOString(); }
function emoji(value) { const name = value.name?.trim(), id = value.id?.trim(); if (!name && !id) throw new TypeError("emoji needs a name or id"); if (id) required(id, "emoji id"); return Object.freeze({ ...(name ? { name } : {}), ...(id ? { id } : {}) }); }
function sameEmoji(a, b) { const left = emoji(a), right = emoji(b); return left.id !== undefined || right.id !== undefined ? left.id === right.id : left.name === right.name; }
function freezeReceipt(receipt) { return Object.freeze({ ...receipt, plan: Object.freeze({ ...receipt.plan }) }); }

export function normalizeReactionEvent(input) {
  if (input.type !== "DiscordReactionEvent" || input.version !== 1 || !["add", "remove"].includes(input.kind)) throw new TypeError("unsupported reaction event");
  return Object.freeze({ ...input, eventId: required(input.eventId, "event id"), occurredAt: instant(input.occurredAt, "occurredAt"), guildId: required(input.guildId, "guild id"), channelId: required(input.channelId, "channel id"), messageId: required(input.messageId, "message id"), actorId: required(input.actorId, "actor id"), emoji: emoji(input.emoji) });
}
export function normalizeReactionRoleBinding(input) {
  if (input.type !== "DiscordReactionRoleBinding" || input.version !== 1 || !Number.isSafeInteger(input.revision) || input.revision < 1) throw new TypeError("unsupported reaction role binding");
  const actions = (value) => { if (!Array.isArray(value) || value.some((action) => action !== "add-role" && action !== "remove-role")) throw new TypeError("binding effects must be role effects"); if (new Set(value).size !== value.length) throw new TypeError("binding effects must not contain duplicates"); if (value.length > 1) throw new TypeError("binding effects must not contain contradictory role actions"); return Object.freeze([...value]); };
  return Object.freeze({ ...input, id: required(input.id, "binding id"), guildId: required(input.guildId, "guild id"), channelId: required(input.channelId, "channel id"), messageId: required(input.messageId, "message id"), roleId: required(input.roleId, "role id"), emoji: emoji(input.emoji), onAdd: actions(input.onAdd), onRemove: actions(input.onRemove) });
}
export function normalizeReactionPolicyState(input, now = new Date(), maxAgeMs = 60_000) {
  if (input.type !== "DiscordReactionPolicyState" || input.version !== 1) throw new TypeError("unsupported policy state");
  const observedAt = instant(input.observedAt, "observedAt"); required(input.sourceRevision, "source revision");
  if (Date.parse(observedAt) > now.getTime() + 5_000 || now.getTime() - Date.parse(observedAt) > maxAgeMs) throw new TypeError("policy state is not fresh");
  if (!Number.isInteger(input.role.position) || !Number.isInteger(input.role.botHighestPosition)) throw new TypeError("policy state role positions must be integers");
  return Object.freeze({ ...input, observedAt, actorRoleIds: Object.freeze([...new Set(input.actorRoleIds.map((id) => required(id, "actor role id")))]) });
}
export function reactionEventKey(event) { const item = normalizeReactionEvent(event); return `discord-reaction:${semanticHex({ guildId: item.guildId, channelId: item.channelId, messageId: item.messageId, actorId: item.actorId, kind: item.kind, emoji: item.emoji, eventId: item.eventId })}`; }
export function evaluateReactionRoleBinding(eventInput, bindingInput, stateInput, now = new Date(), maxAgeMs = 60_000) {
  const event = normalizeReactionEvent(eventInput), binding = normalizeReactionRoleBinding(bindingInput);
  if (event.guildId !== binding.guildId || event.channelId !== binding.channelId || event.messageId !== binding.messageId || !sameEmoji(event.emoji, binding.emoji)) return Object.freeze({ kind: "ignore", reason: "reaction does not match binding" });
  let state; try { state = normalizeReactionPolicyState(stateInput, now, maxAgeMs); } catch (error) { return Object.freeze({ kind: "refuse", bindingId: binding.id, reason: error instanceof Error ? error.message : "invalid policy state" }); }
  if (!state.messagePresent) return Object.freeze({ kind: "refuse", bindingId: binding.id, reason: "bound message is absent" });
  if (!state.role.exists) return Object.freeze({ kind: "refuse", bindingId: binding.id, reason: "bound role is absent" });
  if (state.role.managed) return Object.freeze({ kind: "refuse", bindingId: binding.id, reason: "bound role is integration-managed" });
  if (state.role.position <= 0 || state.role.position >= state.role.botHighestPosition) return Object.freeze({ kind: "refuse", bindingId: binding.id, reason: "bound role is not below the executor role hierarchy" });
  const actions = event.kind === "add" ? binding.onAdd : binding.onRemove; if (actions.length === 0) return Object.freeze({ kind: "observe", bindingId: binding.id, reason: "binding intentionally has no effect for this reaction" });
  const actorHasRole = state.actorRoleIds.includes(binding.roleId), action = actions[0];
  if ((action === "add-role" && actorHasRole) || (action === "remove-role" && !actorHasRole)) return Object.freeze({ kind: "observe", bindingId: binding.id, reason: "role already has the requested state" });
  const eventKey = reactionEventKey(event), material = { eventKey, bindingId: binding.id, bindingRevision: binding.revision, action, guildId: event.guildId, channelId: event.channelId, messageId: event.messageId, actorId: event.actorId, emoji: event.emoji, roleId: binding.roleId };
  const plan = Object.freeze({ type: "DiscordRoleEffectPlan", version: 1, id: `discord-role-effect:${semanticHex(material)}`, ...material, expected: Object.freeze({ messagePresent: true, roleManaged: false, roleBelowBot: true, actorHasRole }) });
  return Object.freeze({ kind: "propose", bindingId: binding.id, plans: Object.freeze([plan]) });
}
function satisfies(plan, state) { const actorHasRole = state.actorRoleIds.includes(plan.roleId); return state.role.exists && !state.role.managed && state.role.position > 0 && state.role.position < state.role.botHighestPosition && (plan.type === "DiscordRoleEffectRollbackPlan" ? actorHasRole === plan.expectedActorHasRole : state.messagePresent && actorHasRole === plan.expected.actorHasRole); }
function effectInput(plan) { return { guildId: plan.guildId, actorId: plan.actorId, roleId: plan.roleId }; }

export class InMemoryEffectReceiptJournal {
 #receipts = new Map();
  constructor(initial) { if (initial) for (const receipt of importEffectReceiptJournal(initial).receipts) this.#receipts.set(receipt.plan.id, receipt); }
  async reserve(plan, recordedAt) { const prior = this.#receipts.get(plan.id); if (prior) return freezeReceipt({ ...prior, status: "duplicate" }); const receipt = freezeReceipt({ type: "DiscordCommunityEffectReceipt", version: 2, plan, status: "reserved", recordedAt: instant(recordedAt, "recordedAt") }); this.#receipts.set(plan.id, receipt); return receipt; }
  async complete(planId, status, recordedAt, reason) { const prior = this.#receipts.get(planId); if (!prior) throw new Error("effect plan was not reserved"); if (prior.status !== "reserved") return freezeReceipt({ ...prior, status: "duplicate" }); const receipt = freezeReceipt({ ...prior, status, recordedAt: instant(recordedAt, "recordedAt"), ...(reason ? { reason } : {}) }); this.#receipts.set(planId, receipt); return receipt; }
  async recover(recordedAt, reason = "interrupted before completion") { const at = instant(recordedAt, "recordedAt"), out = []; for (const [id, prior] of this.#receipts) if (prior.status === "reserved") { const receipt = freezeReceipt({ ...prior, status: "recoverable", recordedAt: at, reason }); this.#receipts.set(id, receipt); out.push(receipt); } return Object.freeze(out); }
  async get(planId) { return this.#receipts.get(planId); }
  async export() { return Object.freeze({ type: "DiscordCommunityEffectReceiptJournal", version: 2, receipts: Object.freeze([...this.#receipts.values()]) }); }
}
export class FileEffectReceiptJournal extends InMemoryEffectReceiptJournal {
 #file; constructor(file, initial) { super(initial); this.#file = file; }
  static async open(file) { try { return new FileEffectReceiptJournal(file, importEffectReceiptJournal(JSON.parse(await readFile(file, "utf8")))); } catch (error) { if ((error).code === "ENOENT") return new FileEffectReceiptJournal(file); throw error; } }
  async #persist() { await writeFileText(this.#file, `${JSON.stringify(await super.export())}\n`, { mode: 0o600 }); }
 async reserve(plan, at) { const receipt = await super.reserve(plan, at); if (receipt.status !== "duplicate") await this.#persist(); return receipt; }
 async complete(id, status, at, reason) { const receipt = await super.complete(id, status, at, reason); if (receipt.status !== "duplicate") await this.#persist(); return receipt; }
 async recover(at, reason) { const receipts = await super.recover(at, reason); if (receipts.length) await this.#persist(); return receipts; }
}
export function importEffectReceiptJournal(record) {
  if (record.type !== "DiscordCommunityEffectReceiptJournal" || record.version !== 2 || !Array.isArray(record.receipts)) throw new TypeError("unsupported effect receipt journal");
  const seen = new Set(), statuses = new Set(["reserved", "applied", "failed", "recoverable", "duplicate"]);
  const receipts = record.receipts.map((receipt) => { if (receipt.type !== "DiscordCommunityEffectReceipt" || receipt.version !== 2 || !statuses.has(receipt.status) || seen.has(receipt.plan.id)) throw new TypeError("receipt journal has an invalid or duplicate receipt"); seen.add(receipt.plan.id); if (receipt.plan.type === "DiscordRoleEffectPlan") { const plan = receipt.plan; required(plan.bindingId, "binding id"); required(plan.roleId, "role id"); emoji(plan.emoji); if (plan.bindingRevision < 1 || plan.id !== `discord-role-effect:${semanticHex({ eventKey: plan.eventKey, bindingId: plan.bindingId, bindingRevision: plan.bindingRevision, action: plan.action, guildId: plan.guildId, channelId: plan.channelId, messageId: plan.messageId, actorId: plan.actorId, emoji: plan.emoji, roleId: plan.roleId })}`) throw new TypeError("receipt plan is invalid"); } else if (receipt.plan.type !== "DiscordRoleEffectRollbackPlan" || receipt.plan.version !== 1 || receipt.plan.bindingRevision < 1 || receipt.plan.id !== `discord-role-rollback:${semanticHex({ sourcePlanId: receipt.plan.sourcePlanId, action: receipt.plan.action, bindingRevision: receipt.plan.bindingRevision })}`) throw new TypeError("receipt plan is invalid"); return freezeReceipt({ ...receipt, recordedAt: instant(receipt.recordedAt, "recordedAt") }); });
  return Object.freeze({ type: "DiscordCommunityEffectReceiptJournal", version: 2, receipts: Object.freeze(receipts) });
}
export async function executeRoleEffect(plan, journal, executor, readFreshState, recordedAt, maxAgeMs = 60_000) {
  const reservation = await journal.reserve(plan, recordedAt); if (reservation.status === "duplicate") return reservation;
  try { const before = normalizeReactionPolicyState(await readFreshState(), new Date(recordedAt), maxAgeMs); if (!satisfies(plan, before)) return journal.complete(plan.id, "failed", recordedAt, "precondition changed before execution"); const finalState = normalizeReactionPolicyState(await readFreshState(), new Date(recordedAt), maxAgeMs); if (!satisfies(plan, finalState)) return journal.complete(plan.id, "failed", recordedAt, "precondition changed immediately before execution"); if (plan.action === "add-role") await executor.addRole(effectInput(plan)); else await executor.removeRole(effectInput(plan)); return journal.complete(plan.id, "applied", recordedAt); } catch (error) { return journal.complete(plan.id, "failed", recordedAt, error instanceof Error ? error.message : String(error)); }
}
export function rollbackPlan(receipt) { if (receipt.status !== "applied" || receipt.plan.type !== "DiscordRoleEffectPlan") return undefined; const action = receipt.plan.action === "add-role" ? "remove-role" : "add-role"; return Object.freeze({ type: "DiscordRoleEffectRollbackPlan", version: 1, id: `discord-role-rollback:${semanticHex({ sourcePlanId: receipt.plan.id, action, bindingRevision: receipt.plan.bindingRevision })}`, sourcePlanId: receipt.plan.id, bindingId: receipt.plan.bindingId, bindingRevision: receipt.plan.bindingRevision, action, guildId: receipt.plan.guildId, actorId: receipt.plan.actorId, roleId: receipt.plan.roleId, expectedActorHasRole: receipt.plan.action === "add-role" }); }
export function projectDurableEffectReceipt(receipt, pseudonymKey) { if (pseudonymKey.length < 32) throw new TypeError("pseudonym key must contain at least 32 characters"); const actorPseudonym = `urn:discord-community-automation:actor:${createHmac("sha256", pseudonymKey).update(`v2\0${receipt.plan.guildId}\0${receipt.plan.actorId}`).digest("hex")}`; return Object.freeze({ type: "DiscordCommunityEffectReceiptProjection", version: 2, planId: receipt.plan.id, bindingId: receipt.plan.bindingId, bindingRevision: receipt.plan.bindingRevision, action: receipt.plan.action, status: receipt.status, recordedAt: receipt.recordedAt, actorPseudonym, privacy: Object.freeze({ retained: Object.freeze(["planId", "bindingId", "bindingRevision", "action", "status", "recordedAt", "actorPseudonym"]), omitted: Object.freeze(["eventId", "guildId", "channelId", "messageId", "actorId", "emoji", "roleId", "messageContent"]) }) }); }
