# Como contribuir

Obrigado pelo interesse! Este guia resume o fluxo de trabalho.

## Ambiente

- Node.js **≥ 22.12** (`.nvmrc`). Verifique com `node --version` **e** `npm exec -c "node --version"`
  — se o npm estiver usando outro Node mais antigo, dependências nativas (rolldown, sharp) podem não
  ser instaladas.
- `npm install` na raiz instala todos os workspaces.

## Fluxo

1. Crie um branch a partir de `main`: `feat/…`, `fix/…`, `docs/…`.
2. Faça commits pequenos seguindo [Conventional Commits](https://www.conventionalcommits.org/pt-br/):
   `feat(core): …`, `fix(web): …`, `docs: …`, `test: …`, `chore: …`.
3. Rode `npm run check` (typecheck + lint + formatação + testes) antes de abrir o PR.
4. Descreva no PR **o efeito visual** da mudança quando ela tocar o algoritmo — de preferência com
   imagens antes/depois geradas pela CLI com os mesmos parâmetros.

## Onde mexer

| Quero…                             | Arquivo                         |
| ---------------------------------- | ------------------------------- |
| mudar a geometria do tear / pinos  | `packages/core/src/geometry.ts` |
| mudar como o fio cobre os pixels   | `packages/core/src/raster.ts`   |
| mudar a função objetivo ou a busca | `packages/core/src/engine.ts`   |
| mudar o preparo da foto            | `packages/core/src/image.ts`    |
| adicionar um formato de saída      | `packages/core/src/export.ts`   |
| adicionar opção na CLI             | `packages/cli/src/index.ts`     |
| mexer na interface                 | `apps/web/src/*`                |

## Princípios

- **Fidelidade física primeiro**: grandezas em mm, luz linear, nada de "constantes mágicas" em
  pixels. Se um parâmetro é uma estimativa, documente-o como tal.
- **Core sem dependências** e sem APIs de plataforma (DOM, `fs`, `Buffer`).
- **Testes para invariantes**: toda mudança no motor deve manter (ou acrescentar) testes de
  continuidade do fio, restrições de pinos e redução de erro.
- Documentação e interface em português; código e comentários em inglês.
