# Como colocar o Dtruck Financeiro no ar (Cloudflare Workers)

Você não precisa programar nada, só clicar e copiar valores.
**Nunca cole senhas, tokens ou chaves no chat.** O "Database ID" e o "AUD Tag" não são senhas: são só identificadores.

O sistema usa 3 serviços da Cloudflare:

| Peça | Serviço | Para quê |
|---|---|---|
| Site e API | **Worker** (ligado ao GitHub) | Publica as telas e a API a cada atualização do repositório |
| Banco | **D1** | Guarda lançamentos, clientes, peças e notas |
| Login | **Zero Trust → Access** | Só entra quem estiver na lista de e-mails |

Os nomes dos menus mudam se o painel estiver em português, por exemplo *Settings* = *Configurações* e *Bindings* = *Vinculações*. Se não achar um menu, use a busca do painel (`Ctrl + K`).

---

## 1. Banco de dados (D1)

1. Abra **Storage & Databases → D1 SQL Database** ou use o link https://dash.cloudflare.com/?to=/:account/workers/d1
2. **Create**, com o nome `dtruck-financeiro`.
3. Abra o banco e copie o **Database ID**, um código parecido com `a1b2c3d4-...`.
4. Coloque esse código no arquivo `wrangler.jsonc` do repositório, no lugar de `COLE_AQUI_O_DATABASE_ID`. Também pode mandar o código no chat do Claude para ele fazer isso.

As tabelas são criadas sozinhas no primeiro acesso.

## 2. Worker ligado ao GitHub

O Worker `dtruck-financeiro` já foi criado e ligado ao repositório. Confira em **Worker → Settings → Build**:

- **Build command:** vazio
- **Deploy command:** `npx wrangler deploy`
- **Root directory:** `/`

O nome do Worker precisa ser **`dtruck-financeiro`**, igual ao campo `name` do `wrangler.jsonc`.

A cada alteração no GitHub, a Cloudflare publica sozinha. O endereço fica parecido com `https://dtruck-financeiro.SEU-SUBDOMINIO.workers.dev`. Ele vai mostrar "Não autenticado" até o passo 4 ficar pronto, e isso é esperado.

## 3. Variáveis

Em **Worker → Settings → Variables and Secrets → Add**, do tipo *Text*:

| Nome | Valor | Obrigatório |
|---|---|---|
| `ADMIN_EMAILS` | e-mails dos administradores, separados por vírgula | sim |
| `READONLY_EMAILS` | e-mails que só podem ver (ex.: contador) | não |

Perfis:
- **Administrador:** faz tudo, inclusive mudar saldo inicial e CNPJ.
- **Operador:** qualquer pessoa liberada no login que não esteja nas listas acima. Lança, edita, importa notas e cadastra.
- **Só leitura:** vê tudo e não altera nada.

## 4. Login da equipe (Cloudflare Access)

1. Abra **Zero Trust**. Na primeira vez, escolha:
   - um **nome de equipe**, por exemplo `dtruck`, que gera o endereço `dtruck.cloudflareaccess.com`;
   - o plano **Free**, que vale para até 50 usuários. Pode pedir cartão, mas não cobra.
2. Vá em **Access → Applications → Add an application → Self-hosted**.
3. **Application name:** `Dtruck Financeiro`.
4. **Domínios:** coloque o endereço `.workers.dev` do passo 2 e, depois do passo 5, também o domínio da Dtruck.
5. **Policy:**
   - nome `Equipe Dtruck`;
   - ação **Allow**;
   - regra **Include → Emails**, com o e-mail de cada pessoa da equipe.
6. **Login:** deixe **One-time PIN** ligado. A pessoa recebe um código por e-mail.
7. Salve, abra a aplicação e copie o **Application Audience (AUD) Tag**.

Volte em **Worker → Settings → Variables and Secrets** e adicione:

| Nome | Valor |
|---|---|
| `ACCESS_TEAM_DOMAIN` | `dtruck.cloudflareaccess.com`, com o seu nome de equipe |
| `ACCESS_AUD` | o AUD Tag copiado |

## 5. Domínio da Dtruck

Para usar um domínio próprio num Worker, o **DNS do domínio precisa estar na Cloudflare**:

1. No painel, clique em **Add a domain** e digite o domínio.
2. A Cloudflare mostra dois servidores DNS, com nomes parecidos com `xxx.ns.cloudflare.com`.
3. No **Registro.br**, ou onde o domínio estiver registrado, troque os servidores DNS por esses dois.
4. Espere a Cloudflare mostrar o domínio como **Active**. Pode levar algumas horas.

A Cloudflare copia os registros de DNS que já existem, então o e-mail e o site atuais continuam funcionando. Antes de trocar, confira na lista se estão lá os registros do e-mail (MX) e do site.

Depois que o domínio estiver ativo:
1. Em **Worker → Settings → Domains & Routes → Add → Custom domain**, coloque `financeiro.seudominio.com.br`.
2. Inclua esse mesmo domínio na aplicação do Access, no passo 4.4.

## 6. Testar

1. Abra o endereço.
2. Digite seu e-mail e o código que chegar.
3. No rodapé do menu deve aparecer "Conectado como …" com o seu perfil.

Para incluir ou tirar alguém da equipe, vá em **Zero Trust → Access → Applications → Dtruck Financeiro → Policies**.

---

## Segurança e backup

- **Login conferido a cada pedido:** o servidor confere a assinatura do login do Cloudflare Access em toda requisição. Sem login válido, nenhum dado sai do banco.
- **Histórico de alterações:** cada alteração fica registrada na tabela `audit`, com o e-mail de quem fez e o horário.
- **Backup:** o D1 tem **Time Travel**, que permite voltar o banco a um ponto no tempo. Guarda 7 dias no plano grátis e 30 dias no plano pago (US$ 5/mês).

## Rodar no computador (desenvolvimento)

```bash
npm install
```

```bash
npm run dev
```

O sistema abre em `http://localhost:8788`, com um banco local de teste e o usuário `dev@local` como administrador.
