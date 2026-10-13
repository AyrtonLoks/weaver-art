# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e
[Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [0.1.0] — 2026-10-13

### Adicionado

- Monorepo com `@weaver-art/core`, `@weaver-art/cli` e `@weaver-art/web` (npm workspaces).
- Core: tear circular em mm, pinos com diâmetro (segmentos tangentes, lados, arcos),
  rasterização por cobertura de área, modelo de tom em luz linear, otimização gulosa por redução
  de erro, múltiplos fios coloridos, presets `vrellis-mono` e `vrellis-color`.
- Exportação: instruções `.txt` (pt-BR), `.csv`, `.json`, `.svg` em escala real.
- CLI com `sharp` (respeita orientação EXIF) e progresso no terminal.
- Estúdio web (Vite + Web Worker) com simulação ao vivo e exportações.
- Modo tecelagem com voz (Web Speech API, pt-BR), avanço automático e progresso persistente.
- Documentação: README, algoritmo, arquitetura, referências, roadmap e guia de contribuição.
- Testes (Vitest), ESLint, Prettier e GitHub Actions.
