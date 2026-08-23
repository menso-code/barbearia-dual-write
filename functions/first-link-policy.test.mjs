import assert from "node:assert/strict";
import test from "node:test";
import { emailAutorizado, unirPapeisPrimeiroVinculo } from "./first-link-policy.mjs";

test("cliente não verificado com e-mail autorizado recebe CLIENTE + BARBEIRO", () => {
  assert.deepEqual(unirPapeisPrimeiroVinculo(["CLIENTE"]), ["BARBEIRO", "CLIENTE"]);
});

test("CLIENTE + ADMIN preserva ADMIN", () => {
  assert.deepEqual(unirPapeisPrimeiroVinculo(["CLIENTE", "ADMIN"]), ["ADMIN", "BARBEIRO", "CLIENTE"]);
});

test("e-mail autorizado usa comparação normalizada", () => {
  assert.equal(emailAutorizado("  MENSO333+SAMUELHML@GMAIL.COM ", "menso333+samuelhml@gmail.com"), true);
});

test("e-mail diferente é rejeitado", () => {
  assert.equal(emailAutorizado("outro@example.com", "menso333+samuelhml@gmail.com"), false);
});

test("repetição mantém conjunto idempotente", () => {
  assert.deepEqual(unirPapeisPrimeiroVinculo(["BARBEIRO", "CLIENTE", "BARBEIRO"]), ["BARBEIRO", "CLIENTE"]);
});
