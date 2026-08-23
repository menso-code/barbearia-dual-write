# Barbearia Antunes — Web App (Firebase)

Site responsivo para agendamento em barbearia, com tema preto/branco/verde.
Front-end estático (HTML + CSS + JavaScript modular, sem build) usando o
Firebase Web SDK v10 via CDN. Backend: **Firebase Authentication** +
**Cloud Firestore**.

> ⚠️ Este ambiente não tem acesso à internet, então não consegui rodar os
> comandos do Firebase CLI nem registrar o app Web diretamente no projeto
> `barber-a01e7`. Todo o código já está pronto — você só precisa rodar os
> comandos abaixo na sua máquina (com a CLI já logada na sua conta Google).

## 1. Estrutura do projeto

```
barbearia/
├── firebase.json          # Hosting + config de Auth (providers) + Firestore
├── .firebaserc             # aponta para o projeto barber-a01e7
├── firestore.rules         # regras de segurança
├── firestore.indexes.json  # índice usado por "Meus agendamentos"
└── public/
    ├── index.html           # login / cadastro por e-mail e senha
    ├── app.html              # área do cliente
    ├── admin.html             # painel administrativo (protegido)
    ├── css/style.css
    └── js/
        ├── firebase-config.js  # <-- preencher com os dados do seu app Web
        ├── auth.js
        ├── app.js
        └── admin.js
```

## 2. Registrar o app Web no projeto `barber-a01e7`

Na pasta `barbearia/`, com a Firebase CLI instalada e logada:

```bash
npx -y firebase-tools@latest login
npx -y firebase-tools@latest use barber-a01e7

# Registra um novo app Web no projeto
npx -y firebase-tools@latest apps:create WEB "Barbearia Antunes Web"

# Lista os apps e copia o SDK config do app recém-criado
npx -y firebase-tools@latest apps:sdkconfig WEB <APP_ID_RETORNADO_ACIMA>
```

Copie os valores retornados (`apiKey`, `appId`, `messagingSenderId`, etc.)
para `public/js/firebase-config.js`, no objeto `firebaseConfig`.

## 3. Ativar o método de login (e-mail e senha)

Ative **E-mail/senha** no Firebase Authentication. O sistema atual não
apresenta login por Google ou telefone; o WhatsApp é informado no cadastro e
armazenado no perfil do cliente para os lembretes via WhatsApp Web.

```bash
npx -y firebase-tools@latest deploy --only auth
```

Antes de rodar, edite `firebase.json` e troque `supportEmail` pelo e-mail de
suporte da barbearia.

Em Authentication > Settings > Authorized domains, confirme que `localhost`
e o domínio final do Hosting estão na lista.

## 4. Criar o banco Firestore e publicar as regras

```bash
# Se ainda não existir um banco Firestore no projeto:
npx -y firebase-tools@latest firestore:databases:create "(default)" --location=southamerica-east1

# Publicar regras de segurança e índices:
npx -y firebase-tools@latest deploy --only firestore:rules,firestore:indexes
```

### Coleções usadas

| Coleção        | Documento (id)                    | Campos |
|----------------|-------------------------------------|--------|
| `clientes`     | uid do usuário                     | nome, email, telefone, data_de_criacao |
| `barbeiros`    | auto-id (máx. 5 documentos)        | nome, foto, especialidade, descricao, ativo |
| `servicos`     | auto-id                            | nome, descricao, duracao, preco |
| `agendamentos` | `{barbeiroId}_{data}_{horario}`    | cliente_id, cliente_nome, barbeiro_id, barbeiro_nome, servico_id, servico_nome, data, horario, status, criado_em |
| `admins`       | uid do usuário administrador       | (documento vazio ou `{ "papel": "admin" }`) — dá acesso ao painel `/admin.html` |

**Por que o ID do agendamento é `{barbeiroId}_{data}_{horario}`?** Isso faz o
próprio Firestore impedir dois agendamentos ativos para o mesmo barbeiro no
mesmo horário — o app usa uma transação (`runTransaction`) que só grava se
esse documento não existir com status `agendado`.

## 5. Tornar um usuário administrador

O painel `/admin.html` só libera acesso para usuários com um documento em
`admins/{uid}`. Depois que a pessoa criar a conta normalmente pelo site,
adicione o documento pelo Console (Firestore > `admins` > "Adicionar
documento", ID = o `uid` do usuário, sem precisar de campos) — ou via CLI:

```bash
npx -y firebase-tools@latest firestore:documents create admins/<UID_DO_ADMIN> --data '{"papel":"admin"}'
```

## 6. Cadastrar os 3 barbeiros iniciais e os serviços

Depois de logar como admin em `/admin.html`, use o botão **"+ Novo
barbeiro"** para cadastrar os 3 primeiros barbeiros (até 5 no total).

Os **serviços** (usados no formulário de agendamento) ainda não têm tela de
CRUD no painel — cadastre os iniciais direto no Console ou via CLI, por
exemplo:

```bash
npx -y firebase-tools@latest firestore:documents create servicos/corte-classico \
  --data '{"nome":"Corte clássico","descricao":"Corte tesoura e máquina","duracao":30,"preco":45}'

npx -y firebase-tools@latest firestore:documents create servicos/barba \
  --data '{"nome":"Barba desenhada","descricao":"Toalha quente + navalha","duracao":25,"preco":35}'

npx -y firebase-tools@latest firestore:documents create servicos/combo \
  --data '{"nome":"Combo corte + barba","descricao":"O ritual completo","duracao":50,"preco":70}'
```

(Se quiser, posso adicionar uma tela de CRUD de serviços no painel admin —
é só pedir.)

## 7. Rodar localmente

```bash
npx -y firebase-tools@latest emulators:start --only hosting
# ou simplesmente sirva a pasta public/ com qualquer servidor estático
```

Abra `http://localhost:5000` (ou a porta indicada).

## 8. Deploy final

```bash
npx -y firebase-tools@latest deploy --only hosting,firestore
```

O site ficará disponível em `https://barber-a01e7.web.app`.

## Notas de segurança

- As regras (`firestore.rules`) garantem que cada cliente só vê/edita seus
  próprios dados em `clientes` e `agendamentos`, e que apenas usuários com
  documento em `admins` podem criar/editar/remover barbeiros e serviços.
- O limite de 5 barbeiros é validado no painel admin (client-side). Para uma
  garantia 100% à prova de burla no servidor, o ideal é mover essa checagem
  para uma Cloud Function (posso montar isso se você quiser evoluir o
  projeto).
- Senhas nunca são armazenadas pelo app — ficam somente no Firebase
  Authentication, que já cuida do hashing.
