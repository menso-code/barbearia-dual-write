import { getBarbeariaAtual, getSlugBarbeariaAtual } from "./tenant.js";

// ============================================================================
// CONFIGURAÇÃO DO FIREBASE — projeto: teste-483f6
// ============================================================================
// Preencha os valores abaixo com os dados do seu app Web.
// Como obter: Console do Firebase > teste-483f6 > Configurações do projeto
// > Seus apps > (ícone Web) > "Config".
// Ou via CLI (ver README.md, passo 2) — o comando já registra o app web
// e você só precisa copiar o resultado para cá.
// GERADO PARA HOMOLOGAÇÃO — teste-483f6. Não editar manualmente.
const firebaseConfig = {
  "apiKey": "AIzaSyB3GtGg7NtoQtFOdlpcOk_pxyBpSGVUqLw",
  "authDomain": "teste-483f6.firebaseapp.com",
  "projectId": "teste-483f6",
  "storageBucket": "teste-483f6.firebasestorage.app",
  "messagingSenderId": "755076593522",
  "appId": "1:755076593522:web:b5f202e62f666803794feb",
  "measurementId": "G-32YNSSLZZN"
};

// Reexportado pelo módulo comum para que todos os fluxos possam usar a mesma
// referência quando cada coleção for migrada, sem criar fontes paralelas.
export { getBarbeariaAtual };
export const BARBEARIA_ATUAL_ID = getBarbeariaAtual();
export { getSlugBarbeariaAtual };
export const BARBEARIA_ATUAL_SLUG = getSlugBarbeariaAtual();

// ============================================================================
// Inicialização (SDK modular do Firebase v10, via CDN — sem necessidade de build)
// ============================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js";

export const app = initializeApp(firebaseConfig);
// Identificador do projeto em execução. Em homologação este valor é trocado
// pelo gerador de pacote HML; a fonte de produção permanece inalterada.
export const FIREBASE_PROJECT_ID = firebaseConfig.projectId;
export const auth = getAuth(app);
export const db = getFirestore(app);
// Os comandos operacionais autenticados rodam na mesma região da Cloud Function.
export const functions = getFunctions(app, "southamerica-east1");

// Descomente as linhas abaixo para rodar contra os emuladores locais
// (útil para testar sem custos/limites antes de ir para produção):
//
// import { connectAuthEmulator } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
// import { connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
// if (location.hostname === "localhost") {
//   connectAuthEmulator(auth, "http://localhost:9099");
//   connectFirestoreEmulator(db, "localhost", 8080);
// }
