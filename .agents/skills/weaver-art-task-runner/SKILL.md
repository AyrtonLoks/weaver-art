---
name: weaver-art-task-runner
description: >-
  Executa procedimentos de desenvolvimento, calibração, benchmarks visuais e testes
  no projeto Weaver Art. Use sempre que for modificar o algoritmo de tecelagem, rodar
  experimentos com fotos reais ou implementar tarefas do roadmap.
---

# Weaver Art Task Runner

Runbook para desenvolvimento e verificação no ecossistema Weaver Art.

## 1. Verificação Rápida de Ambiente

Certifique-se de que o Node.js em execução seja >= 22.12:

```bash
node --version
```

Execute o checklist de qualidade completo:

```bash
npm run check
```

## 2. Roteiro para Alterações no Algoritmo Core

Ao alterar `packages/core/src`:

1. Mantenha os testes existentes em `packages/core/test/` passando.
2. Adicione testes para novas invariantes matemáticas (ex.: conservação de continuidade, limites de tolerância).
3. Compile o core:
   ```bash
   npm run build --workspace @weaver-art/core
   ```
4. Compile o CLI:
   ```bash
   npm run build --workspace @weaver-art/cli
   ```

## 3. Validação Visual Ponta a Ponta

Para verificar se uma alteração melhorou ou piorou a qualidade visual:

1. Use uma imagem de referência de teste (ex.: retrato ou imagem em escala de cinza em `scratch/`).
2. Execute o CLI salvando em pasta de saída temporária:
   ```bash
   node packages/cli/dist/index.js caminho/imagem.jpg -o output/teste --resolution 400
   ```
3. Inspecione o PNG gerado (`output/teste/*.weave.png`) e verifique RMSE e metros de fio informados.
4. Compare os SVGs em escala real se a mudança envolver geometria, rotação ou lados de pinos.

## 4. Testes do App Web

Ao tocar em `apps/web`:

1. Verifique tipos:
   ```bash
   npm run typecheck --workspace @weaver-art/web
   ```
2. Teste o build de produção Vite:
   ```bash
   npm run build --workspace @weaver-art/web
   ```
3. Para validar interativamente, instrua o usuário a rodar `npm run dev`.
