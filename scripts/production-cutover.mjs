#!/usr/bin/env node
/**
 * Entrada protegida para o cutover V2 em produção.
 * A lógica é exatamente a mesma validada pela Shadow Migration, ativada com
 * metadados e travas específicas de produção.
 */
process.env.MIGRATION_ENVIRONMENT = "production";
await import("./shadow-migration.mjs");
