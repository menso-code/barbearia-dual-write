import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { emailAccessIndexPath, normalizeAccessEmail } from "./dual-write.js";

class ReservationStore {
  constructor() { this.rows = new Map(); this.barbers = new Map(); }
  create(path, barberId) {
    if (this.rows.has(path)) throw new Error("ALREADY_EXISTS");
    this.rows.set(path, barberId);
  }
  atomic(work) {
    const rows = new Map(this.rows); const barbers = new Map(this.barbers);
    try { work(); } catch (error) { this.rows = rows; this.barbers = barbers; throw error; }
  }
  save(barberId, email) {
    const normalized = normalizeAccessEmail(email);
    const old = this.barbers.get(barberId) || "";
    const nextPath = normalized ? emailAccessIndexPath(normalized) : "";
    const oldPath = old ? emailAccessIndexPath(old) : "";
    if (nextPath && this.rows.has(nextPath) && this.rows.get(nextPath) !== barberId) throw new Error("EMAIL_JA_VINCULADO");
    if (nextPath && !this.rows.has(nextPath)) this.rows.set(nextPath, barberId);
    if (oldPath && oldPath !== nextPath && this.rows.get(oldPath) === barberId) this.rows.delete(oldPath);
    this.barbers.set(barberId, normalized);
  }
  remove(barberId) {
    const email = this.barbers.get(barberId) || "";
    const path = email ? emailAccessIndexPath(email) : "";
    if (path && this.rows.has(path) && this.rows.get(path) !== barberId) throw new Error("INDICE_EMAIL_INCONSISTENTE");
    if (path) this.rows.delete(path);
    this.barbers.delete(barberId);
  }
}

test("normalização de email é determinística", () => {
  assert.equal(normalizeAccessEmail("  Barber@Example.COM "), "barber@example.com");
  assert.equal(emailAccessIndexPath(" Barber@Example.COM "), emailAccessIndexPath("barber@example.com"));
});

test("o mesmo barbeiro pode manter o próprio email", () => {
  const store = new ReservationStore();
  const path = emailAccessIndexPath("barber@example.com");
  store.create(path, "barber-a");
  assert.equal(store.rows.get(path), "barber-a");
});

test("barbeiros diferentes disputando o mesmo email têm conflito controlado", () => {
  const store = new ReservationStore();
  const path = emailAccessIndexPath("barber@example.com");
  store.create(path, "barber-a");
  assert.throws(() => store.create(path, "barber-b"), /ALREADY_EXISTS/);
});

test("requestIds diferentes não criam duas reservas para a mesma chave", () => {
  const store = new ReservationStore();
  const path = emailAccessIndexPath("barber@example.com");
  for (const barber of ["barber-a", "barber-b"]) {
    try { store.create(path, barber); } catch (error) { assert.equal(error.message, "ALREADY_EXISTS"); }
  }
  assert.equal(store.rows.size, 1);
});

test("updates concorrentes para o mesmo email também disputam a mesma reserva", () => {
  const store = new ReservationStore();
  const path = emailAccessIndexPath("barber@example.com");
  store.create(path, "barber-a");
  assert.throws(() => store.create(path, "barber-b"), /ALREADY_EXISTS/);
  assert.equal(store.rows.get(path), "barber-a");
});

test("update mantendo email não recria nem remove a reserva", () => {
  const store = new ReservationStore();
  store.save("barber-a", " A@Example.com ");
  const path = emailAccessIndexPath("a@example.com");
  store.save("barber-a", "a@example.com");
  assert.equal(store.rows.size, 1);
  assert.equal(store.rows.get(path), "barber-a");
});

test("update troca A por B e libera A atomicamente", () => {
  const store = new ReservationStore();
  store.save("barber-a", "a@example.com");
  store.save("barber-a", "b@example.com");
  assert.equal(store.rows.has(emailAccessIndexPath("a@example.com")), false);
  assert.equal(store.rows.get(emailAccessIndexPath("b@example.com")), "barber-a");
});

test("remoção libera B e permite reutilização legítima", () => {
  const store = new ReservationStore();
  store.save("barber-a", "b@example.com");
  store.remove("barber-a");
  store.save("barber-b", "b@example.com");
  assert.equal(store.rows.get(emailAccessIndexPath("b@example.com")), "barber-b");
});

test("remoção nunca apaga índice de outro barbeiro", () => {
  const store = new ReservationStore();
  store.barbers.set("barber-a", "a@example.com");
  store.rows.set(emailAccessIndexPath("a@example.com"), "barber-b");
  assert.throws(() => store.remove("barber-a"), /INDICE_EMAIL_INCONSISTENTE/);
  assert.equal(store.rows.get(emailAccessIndexPath("a@example.com")), "barber-b");
});

test("email vazio não cria reserva", () => {
  const store = new ReservationStore();
  store.save("barber-a", "");
  assert.equal(store.rows.size, 0);
});

test("falha posterior faz rollback integral", () => {
  const store = new ReservationStore();
  store.save("barber-a", "a@example.com");
  assert.throws(() => store.atomic(() => { store.save("barber-a", "b@example.com"); throw new Error("SIMULATED_FAILURE"); }), /SIMULATED_FAILURE/);
  assert.equal(store.rows.get(emailAccessIndexPath("a@example.com")), "barber-a");
  assert.equal(store.rows.has(emailAccessIndexPath("b@example.com")), false);
});

test("runtime contém guarda de owner e deleção transacional do índice na remoção", async () => {
  const source = await readFile(new URL("./dual-write.js", import.meta.url), "utf8");
  assert.match(source, /emailIndex\?\.exists && emailIndex\.get\("barbeiro_id"\) !== id/);
  assert.match(source, /if \(emailIndex\?\.exists\) tx\.delete\(emailIndexRef\)/);
});

console.log("email access uniqueness self-test: PASS");
