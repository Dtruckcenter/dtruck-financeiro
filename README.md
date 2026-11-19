# Dtruck Financeiro

Sistema de gestão financeira da Dtruck Center: entradas e saídas, importação de notas fiscais (NF-e, NFC-e, NFS-e), fluxo de caixa, DRE, painel, cadastro de clientes e de peças com controle de estoque.

- `public/`: telas (embutidas no Worker no deploy)
  - `index.html`: o sistema
  - `api-client.txt`: sincroniza os dados com a API (servido como /api-client.js)
- `src/index.js`: Worker (entrada); `src/api.js`: API com banco D1 e login com e-mail e senha
- `wrangler.jsonc`: configuração do Worker (D1, arquivos embutidos)
- `DEPLOY.md`: passo a passo para colocar no ar

## API

| Método | Rota | Função |
|---|---|---|
| GET/POST | `/api/setup` | Situação e criação do primeiro administrador |
| POST | `/api/login`, `/api/logout` | Entrar e sair |
| POST | `/api/password` | Trocar a própria senha |
| GET | `/api/me` | E-mail e perfil do usuário logado |
| GET/POST/PATCH/DELETE | `/api/users[/email]` | Gestão de usuários (só administradores) |
| GET | `/api/sync?since=N` | Registros alterados desde a versão N |
| PUT | `/api/docs/:colecao/:id` | Grava um registro (substitui) |
| PATCH | `/api/docs/:colecao/:id` | Altera campos de um registro |
| DELETE | `/api/docs/:colecao/:id` | Exclui um registro |

Toda requisição que altera dados precisa do cabeçalho `x-dtruck: 1`.

Coleções: `clientes`, `pecas`, `lancamentos`, `notas`, `config` (esta última só para administradores).
