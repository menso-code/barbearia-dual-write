import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  isTenantAdminMemberData,
  normalizeStudioIdentityData,
  STUDIO_IDENTITY_FIELDS,
} from "../functions/dual-write.js";

const runtime = await readFile(new URL("../functions/dual-write.js", import.meta.url), "utf8");
const validIdentity = {
  nome: "Estúdio A",
  nomeCurto: "A",
  logo: "https://cdn.example/tenant-a/logo.png",
  primaryColor: "#123abc",
  accentColor: "#ABCDEF",
  telefone: "(11) 99999-9999",
  whatsapp: "5511999999999",
  instagram: "@studio_a",
  endereco: "Rua A, 100",
  institucional: "Atendimento profissional.",
};

assert.match(runtime, /case "admin\.estudio\.identidade\.salvar"/);
assert.match(runtime, /v2Ref\(context, "configuracoes", STUDIO_IDENTITY_ID\)/);
assert.match(runtime, /context\.tenant\.id/);
assert.match(runtime, /requireTenantAdminMembership\(tx, uid, context\.tenant\.id\)/);
assert.match(runtime, /operationalPayloadFingerprint\(identity\)/);
assert.match(runtime, /updatedAt: nowTimestampField\(\)/);
assert.match(runtime, /updatedBy: uid/);
assert.doesNotMatch(runtime, /mirror(?:Set|Update)\(tx, "configuracoes", "identidade"/);
assert.doesNotMatch(runtime, /const resolvedTenantId = TENANT_ID/);
assert.deepEqual(new Set(STUDIO_IDENTITY_FIELDS), new Set(Object.keys(validIdentity)));
assert.equal(STUDIO_IDENTITY_FIELDS.includes("favicon"), false);

const normalized = normalizeStudioIdentityData(validIdentity);
assert.equal(normalized.primaryColor, "#123ABC");
assert.equal(normalized.accentColor, "#ABCDEF");
assert.equal(normalized.telefone, "5511999999999");
assert.equal(normalized.instagram, "@studio_a");
assert.equal("tenantId" in normalized, false);
assert.equal("updatedAt" in normalized, false);
assert.equal("updatedBy" in normalized, false);

assert.throws(() => normalizeStudioIdentityData({ ...validIdentity, tenantId: "tenant-b" }), /Campo não permitido/);
assert.throws(() => normalizeStudioIdentityData({ ...validIdentity, favicon: "/global/favicon.png" }), /Campo não permitido/);
assert.throws(() => normalizeStudioIdentityData({ ...validIdentity, unknown: true }), /Campo não permitido/);
assert.throws(() => normalizeStudioIdentityData({ ...validIdentity, nome: "x".repeat(121) }), /Texto inválido/);
assert.throws(() => normalizeStudioIdentityData({ ...validIdentity, institucional: "x".repeat(2001) }), /Texto inválido/);
assert.throws(() => normalizeStudioIdentityData({ ...validIdentity, primaryColor: "red" }), /Cor de identidade inválida/);
assert.throws(() => normalizeStudioIdentityData({ ...validIdentity, logo: "javascript:alert(1)" }), /Referência de identidade inválida/);
assert.throws(() => normalizeStudioIdentityData({ ...validIdentity, logo: "http://cdn.example/logo.png" }), /Referência de identidade inválida/);
assert.throws(() => normalizeStudioIdentityData({ ...validIdentity, instagram: "https://evil.example/studio" }), /Instagram inválido/);

assert.equal(isTenantAdminMemberData({ ativo: true, papeis: ["ADMIN"] }, "tenant-a", "tenant-a"), true);
assert.equal(isTenantAdminMemberData({ ativo: true, papeis: ["ADMIN"] }, "tenant-a", "tenant-b"), false);
assert.equal(isTenantAdminMemberData({ ativo: false, papeis: ["ADMIN"] }, "tenant-a", "tenant-a"), false);
assert.equal(isTenantAdminMemberData({ ativo: true, papeis: ["CLIENTE"] }, "tenant-a", "tenant-a"), false);

const partial = normalizeStudioIdentityData({ nome: "Somente nome" });
assert.deepEqual(partial, { nome: "Somente nome" });

console.log("studio identity persistence tests: PASS");
