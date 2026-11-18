# Dtruck Financeiro

Sistema de gestão financeira da Dtruck Center: entradas e saídas, importação de notas fiscais (NF-e, NFC-e, NFS-e), fluxo de caixa, DRE, painel, cadastro de clientes e de peças com controle de estoque.

- `public/`: telas (HTML/JS, sem etapa de build)
  - `index.html`: o sistema
  - `api-client.js`: sincroniza os dados com a API
- `src/index.js`: Worker (entrada); `src/api.js`: API com banco D1 e login pelo Cloudflare Access
- `wrangler.jsonc`: configuração do Worker (assets, D1)
- `DEPLOY.md`: passo a passo para colocar no ar

## API

| Método | Rota | Função |
|---|---|---|
| GET | `/api/me` | E-mail e perfil do usuário logado |
| GET | `/api/sync?since=N` | Registros alterados desde a versão N |
| PUT | `/api/docs/:colecao/:id` | Grava um registro (substitui) |
| PATCH | `/api/docs/:colecao/:id` | Altera campos de um registro |
| DELETE | `/api/docs/:colecao/:id` | Exclui um registro |

Coleções: `clientes`, `pecas`, `lancamentos`, `notas`, `config` (esta última só para administradores).
