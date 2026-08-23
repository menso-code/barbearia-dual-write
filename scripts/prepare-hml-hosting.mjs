/**
 * Gera um diretório public-hml isolado para teste-483f6.
 *
 * Uso:
 *   node scripts/prepare-hml-hosting.mjs C:\caminho-seguro\teste-483f6-web-config.json
 *
 * O arquivo de configuração fica fora do repositório. O script rejeita qualquer
 * configuração que não seja do projeto de homologação, impedindo que o Hosting
 * de teste aponte acidentalmente para barber-a01e7.
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = path.join(ROOT, "public");
const TARGET_DIR = path.join(ROOT, "public-hml");
const REQUIRED_FIELDS = [
  "apiKey",
  "authDomain",
  "projectId",
  "storageBucket",
  "messagingSenderId",
  "appId",
];

function fail(message) {
  console.error(`HML build recusado: ${message}`);
  process.exitCode = 1;
}

const configPath = process.argv[2];
if (!configPath) {
  fail("informe o caminho do firebaseConfig da aplicação Web teste-483f6.");
} else {
  let firebaseConfig;
  try {
    firebaseConfig = JSON.parse(await readFile(path.resolve(configPath), "utf8"));
  } catch (error) {
    fail(`não foi possível ler a configuração Web: ${error.message}`);
  }

  if (firebaseConfig) {
    const missing = REQUIRED_FIELDS.filter((field) => !firebaseConfig[field]);
    const serialized = JSON.stringify(firebaseConfig).toLowerCase();
    if (missing.length) {
      fail(`campos obrigatórios ausentes: ${missing.join(", ")}.`);
    } else if (firebaseConfig.projectId !== "teste-483f6") {
      fail(`projectId deve ser teste-483f6, recebido: ${firebaseConfig.projectId}.`);
    } else if (serialized.includes("barber-a01e7")) {
      fail("a configuração contém referência à produção barber-a01e7.");
    } else {
      await rm(TARGET_DIR, { recursive: true, force: true });
      await cp(SOURCE_DIR, TARGET_DIR, {
        recursive: true,
        filter: (source) => !source.includes("node_modules"),
      });

      const configModulePath = path.join(TARGET_DIR, "js", "firebase-config.js");
      const original = await readFile(configModulePath, "utf8");
      const replacement = `// GERADO PARA HOMOLOGAÇÃO — teste-483f6. Não editar manualmente.\nconst firebaseConfig = ${JSON.stringify(firebaseConfig, null, 2)};`;
      const configured = original.replace(
        /const firebaseConfig = \{[\s\S]*?\n\};/m,
        replacement,
      );
      // O pacote de homologação não deve manter sequer referências documentais
      // ao projeto de produção; isso facilita a verificação antes do deploy.
      const updated = configured.replaceAll("barber-a01e7", "teste-483f6");
      if (configured === original) {
        fail("não foi possível localizar firebaseConfig no módulo fonte.");
      } else {
        await writeFile(configModulePath, updated, "utf8");
        await mkdir(TARGET_DIR, { recursive: true });
        await writeFile(
          path.join(TARGET_DIR, ".hml-build-manifest.json"),
          JSON.stringify(
            {
              projectId: firebaseConfig.projectId,
              authDomain: firebaseConfig.authDomain,
              generatedAt: new Date().toISOString(),
              source: "public",
            },
            null,
            2,
          ),
          "utf8",
        );
        console.log("Pacote HML preparado para teste-483f6.");
      }
    }
  }
}
