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

## 4. Login da equipe (e-mail e senha)

O sistema tem login próprio, com e-mail e senha.

1. Em **Worker → Settings → Variables and Secrets**, a variável `ADMIN_EMAILS` define qual e-mail pode criar o **primeiro administrador**.
2. No primeiro acesso, o sistema mostra a tela **"Primeiro acesso"**. O administrador informa nome, e-mail e cria a própria senha.
3. Depois disso, o administrador cadastra a equipe no menu **Usuários**:
   - cada pessoa recebe uma **senha provisória**;
   - no primeiro login, o sistema obriga a pessoa a criar uma senha pessoal.
4. **Esqueceu a senha?** O administrador clica em **Redefinir senha** na tela de usuários e passa a nova senha provisória.

Segurança:
- **Senhas:** são guardadas com criptografia PBKDF2-SHA256 e ninguém consegue ver a senha original.
- **Tentativas erradas:** depois de 5 erros seguidos, o e-mail fica bloqueado por 15 minutos.
- **Sessão:** dura 30 dias no aparelho e o botão **Sair** encerra na hora.
- **Troca de senha:** desconecta os outros aparelhos da pessoa.

Opcional: para uma camada extra, dá para colocar o **Cloudflare Access** na frente do sistema (Zero Trust → Access → Applications). Assim, só os e-mails da lista chegam até a tela de login.

## 4b. Notas dos fornecedores direto da Receita (certificado digital A1)

O robô `.github/workflows/sefaz-dfe.yml` roda **de hora em hora** no GitHub Actions. A cada rodada ele:
1. consulta a **Distribuição DF-e** da Receita (Ambiente Nacional) com o certificado A1 da Dtruck;
2. registra a **Ciência da Operação** nas notas novas, porque sem ela a Receita só entrega o resumo da nota;
3. busca o XML completo e as chaves bipadas na tela **Entrada de mercadoria**;
4. envia tudo ao sistema, onde as notas aparecem como **Pronta para entrada**.

Configuração, uma vez só, em **GitHub → repositório → Settings → Secrets and variables → Actions**:

| Tipo | Nome | Valor |
|---|---|---|
| Secret | `CERT_PFX_BASE64` | o arquivo `.pfx` do certificado convertido em base64 (veja abaixo) |
| Secret | `CERT_PASSWORD` | a senha do certificado |
| Secret | `DFE_TOKEN` | o token do robô (o mesmo gravado no Worker) |
| Variable | `DTRUCK_UF` | a sigla do estado da Dtruck, ex.: `RS` |

**Converter o certificado em base64 no Windows:** abra o **PowerShell** na pasta do certificado e rode o comando abaixo, trocando o nome do arquivo:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("certificado.pfx")) | Set-Clipboard
```

O texto fica copiado na área de transferência. Cole no segredo `CERT_PFX_BASE64`.

Para testar sem esperar a próxima hora: **Actions → Notas da Receita (DF-e) → Run workflow**.

Quando o certificado for renovado, atualize só os segredos `CERT_PFX_BASE64` e `CERT_PASSWORD`. A tela de entrada avisa quando faltarem menos de 30 dias para o certificado vencer.

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

Para incluir ou tirar alguém da equipe, use o menu **Usuários**, que só aparece para administradores.

---

## Segurança e backup

- **Login conferido a cada pedido:** o servidor confere a sessão em toda requisição. Sem login válido, nenhum dado sai do banco.
- **Histórico de alterações:** cada alteração fica registrada na tabela `audit`, com o e-mail de quem fez e o horário.
- **Backup:** o D1 tem **Time Travel**, que permite voltar o banco a um ponto no tempo. Guarda 7 dias no plano grátis e 30 dias no plano pago (US$ 5/mês).

## Rodar no computador (desenvolvimento)

```bash
npm install
```

```bash
npm run dev
```

O sistema abre em `http://localhost:8788`, com um banco local de teste. No primeiro acesso, crie o administrador com o e-mail `admin@local.test`.
