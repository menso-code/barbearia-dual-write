// ============================================================================
// CONFIGURAÇÃO DO FIREBASE — projeto: barber-a01e7
// ============================================================================
// Preencha os valores abaixo com os dados do seu app Web.
// Como obter: Console do Firebase > barber-a01e7 > Configurações do projeto
// > Seus apps > (ícone Web) > "Config".
// Ou via CLI (ver README.md, passo 2) — o comando já registra o app web
// e você só precisa copiar o resultado para cá.
const firebaseConfig = {
  apiKey: "AIzaSyBkD7g9PjI1sktBnSYAO-qj87iVXdqrV5g",
  authDomain: "barber-a01e7.firebaseapp.com",
  projectId: "barber-a01e7",
  storageBucket: "barber-a01e7.firebasestorage.app",
  messagingSenderId: "324113336959",
  appId: "1:324113336959:web:6f53ea89169c194f744d4a",
  measurementId: "G-ZRD0V83BXW",
};

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
