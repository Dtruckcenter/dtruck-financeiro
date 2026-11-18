# Como colocar o Dtruck Financeiro no ar (Cloudflare)

Tempo estimado: 30 a 40 minutos. Você não precisa programar nada, só clicar e copiar valores.
**Nunca cole senhas ou chaves no chat.** Tudo abaixo é feito no painel da Cloudflare.

O sistema tem 3 peças na Cloudflare:

| Peça | Serviço | Para quê |
|---|---|---|
| Site | **Pages** | Publica as telas a partir do GitHub |
| Banco | **D1** | Guarda lançamentos, clientes, peças e notas |
| Login | **Zero Trust → Access** | Só entra quem estiver na lista de e-mails |

---

## 1. Criar o banco de dados (D1)

1. Entre em **dash.cloudflare.com**.
2. Menu lateral: **Storage & Databases → D1 SQL Database → Create**.
3. Nome: `dtruck-financeiro` → **Create**.

As tabelas são criadas sozinhas no primeiro acesso.

## 2. Publicar o site (Pages) ligado ao GitHub

1. Menu lateral: **Workers & Pages → Create**.
2. Escolha a aba/opção **Pages** → **Connect to Git** (Importar um repositório existente).
3. Autorize o GitHub e escolha o repositório `dtruck-financeiro`.
4. Configuração do build:
   - **Framework preset:** `None`
   - **Build command:** deixe vazio
   - **Build output directory:** `public`
5. **Save and Deploy**.

Ao final aparece um endereço `https://dtruck-financeiro.pages.dev`. Ainda vai mostrar "Não autenticado". Isso é esperado até o passo 5.

## 3. Ligar o banco ao site

No projeto do Pages: **Settings → Bindings → Add → D1 database**

- **Variable name:** `DB`
- **D1 database:** `dtruck-financeiro`

Salve.

## 4. Definir quem é administrador

No projeto do Pages: **Settings → Variables and Secrets → Add** (ambiente **Production**):

| Nome | Valor | Obrigatório |
|---|---|---|
| `ADMIN_EMAILS` | e-mails dos administradores, separados por vírgula | sim |
| `READONLY_EMAILS` | e-mails que só podem ver (ex.: contador) | não |

Perfis:
- **Administrador:** faz tudo, inclusive mudar saldo inicial e CNPJ.
- **Operador** (qualquer pessoa liberada no login que não esteja nas listas acima): lança, edita, importa notas e cadastra.
- **Só leitura:** vê tudo e não altera nada.

## 5. Ativar o login da equipe (Cloudflare Access)

1. Menu lateral: **Zero Trust**. Na primeira vez:
   - escolha um **nome de equipe** (ex.: `dtruck`). Isso cria o endereço `dtruck.cloudflareaccess.com`;
   - escolha o plano **Free** (até 50 usuários). Pode pedir cartão, mas não cobra.
2. **Access → Applications → Add an application → Self-hosted**.
3. **Application name:** `Dtruck Financeiro`.
4. **Domínios**, adicione os dois:
   - `dtruck-financeiro.pages.dev`
   - o seu domínio, ex. `financeiro.seudominio.com.br` (depois do passo 6, se ainda não existir)
5. **Policy:** nome `Equipe Dtruck`, ação **Allow**, regra **Include → Emails**. Coloque o e-mail de cada pessoa da equipe.
6. **Login methods:** deixe **One-time PIN** marcado (a pessoa recebe um código no e-mail). Se quiserem, adicione Google.
7. Salve. Abra a aplicação criada e copie o **Application Audience (AUD) Tag**.

Volte ao projeto do Pages → **Settings → Variables and Secrets** e adicione:

| Nome | Valor |
|---|---|
| `ACCESS_TEAM_DOMAIN` | `dtruck.cloudflareaccess.com` (o seu nome de equipe) |
| `ACCESS_AUD` | o AUD Tag copiado |

Depois: **Deployments → … no último deploy → Retry deployment**, para aplicar as variáveis.

## 6. Usar o domínio da Dtruck

No projeto do Pages: **Custom domains → Set up a custom domain** → `financeiro.seudominio.com.br`.

- **Se o domínio já está na Cloudflare:** ela cria o registro sozinha.
- **Se o DNS continua no Registro.br ou em outro lugar:** crie lá um registro **CNAME**:
  - nome `financeiro`
  - valor `dtruck-financeiro.pages.dev`

Depois confira se esse domínio está na lista de domínios da aplicação do Access (passo 5.4).

## 7. Testar

1. Abra `https://financeiro.seudominio.com.br`.
2. Digite seu e-mail, receba o código e entre.
3. No canto inferior do menu aparece "Conectado como …" com o seu perfil.

Para incluir ou tirar alguém da equipe: **Zero Trust → Access → Applications → Dtruck Financeiro → Policies → Equipe Dtruck**.

---

## Segurança e backup

- **Acesso:** o servidor confere a assinatura do token do Cloudflare Access em toda requisição. Sem login válido, nenhum dado sai do banco, mesmo pelo endereço `.pages.dev`.
- **Registro de alterações:** cada criação, edição ou exclusão fica gravada na tabela `audit` com o e-mail de quem fez e o horário.
- **Backup:** o D1 guarda o histórico do banco (**Time Travel**) e permite voltar a um ponto no tempo. São 7 dias no plano gratuito e 30 dias no plano Workers Paid (US$ 5/mês).

## Atualizações

Toda alteração enviada ao GitHub (branch `main`) é publicada automaticamente pela Cloudflare em cerca de 1 minuto.

## Rodar no computador (desenvolvimento)

```bash
npm install
```

```bash
npm run dev
```

Abre em `http://localhost:8788` com um banco local de teste e o usuário `dev@local` como administrador.
