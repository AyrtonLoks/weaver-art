# Referências

## Obra de referência

### Petros Vrellis — _A new way to knit_ (2016)

<https://artof01.com/vrellis/works/knit.html> · vídeo: <https://vimeo.com/175653201>

Fatos publicados pelo artista e adotados como especificação:

| Aspecto       | Descrição do artista                                        | Como o Weaver Art trata                           |
| ------------- | ----------------------------------------------------------- | ------------------------------------------------- |
| Tear          | aro de alumínio de 28″ com 200 pinos                        | `VRELLIS_LOOM`: 711,2 mm, 200 pinos               |
| Padrão        | um único fio, de pino a pino, seguindo cordas do círculo    | um fio contínuo por cor; continuidade testada     |
| Quantidade    | 3 000 – 4 000 cordas, 1 – 2 km de fio                       | `maxLines = 4000`; comprimento exato reportado    |
| Tom           | branco sem fio; escurece com densidade e interseções        | modelo de transmitância `Π(1 − cᵢ)` em luz linear |
| Cor           | paleta limitada: preto, azul, magenta, amarelo, verde       | preset `vrellis-color` (cores a calibrar)         |
| Transparência | a malha pode ser vista dos dois lados                       | — (fora do escopo do software)                    |
| Execução      | à mão, com instruções passo a passo ditadas pelo computador | instruções `.txt` + modo tecelagem com voz        |
| Algoritmo     | openFrameworks; > 2 bilhões de cálculos por padrão          | ≈ mesma ordem de grandeza (ver ALGORITHM.md §6)   |
| Tema          | retratos; primeira série baseada em El Greco                | presets pensados para retratos                    |

Outras informações (Obsessed with Art, <https://obsessedwithart.com/algorithmic-art-petros-vrellis/>):
o artista é engenheiro eletricista (MEng) e mestre em Art Sciences; trabalha com C++ e
openFrameworks; o projeto foi inspirado na obra de Kumi Yamashita; obras em alumínio de
25″ × 25″ × 1,4″ e, mais tarde, em madeira de 48,4″.

> Os valores de **diâmetro do pino**, **largura aparente do fio** e **cores exatas dos fios** não
> são publicados. Os padrões do projeto são estimativas e devem ser calibrados.

## Projetos abertos usados como inspiração

### alyyousuf7/Weaver

<https://github.com/alyyousuf7/Weaver> — Processing (Java).

- Entradas: imagem, número de pinos `P`, número de linhas `L`.
- Converte para cinza, recorta quadrado, distribui `P` pinos num aro virtual e, a partir do pino 0,
  escolhe repetidamente a linha mais escura, desenhando-a e clareando a imagem de trabalho.
- Suporta molduras circular e quadrada e **várias cores** (separação de cores feita pelo
  usuário ou pelo próprio algoritmo).
- Resultado de exemplo: 254 pinos, 4 000 linhas, ≈ 1,75 km de fio.

**Herdado:** ideia de camadas de cor e de moldura configurável; ordem de grandeza dos parâmetros.

### MarginallyClever/weaving_algorithm

<https://github.com/MarginallyClever/weaving_algorithm> — Processing 3.

- 200 pontos no círculo; encontra a linha mais escura entre dois pontos, adiciona-a à imagem de
  saída, subtrai-a da imagem de entrada; repete 2 000 vezes.
- Imprime a sequência final de pinos.

**Herdado:** formulação gulosa básica e a saída como sequência de pinos.

### O que mudamos em relação a ambos

Ver a tabela “O que há de diferente” no [README](../README.md) e a discussão em
[ALGORITHM.md §6](ALGORITHM.md#por-que-redução-de-erro-em-vez-de-linha-mais-escura).

## Literatura técnica

- **Birsak, M., Rist, F., Wonka, P., Musialski, P.** _String Art: Towards Computational Fabrication
  of String Images._ Computer Graphics Forum (Proc. Eurographics 2018), 37(2):263–274.
  DOI [10.1111/cgf.13359](https://doi.org/10.1111/cgf.13359).
  Formula string art como otimização discreta, trata os lados tangentes dos pinos, fundamenta o
  modelo de distância de observação e inspira o refinamento iterativo com conservação de continuidade física.
- **Wang, Z., Bovik, A. C., Sheikh, H. R., & Simoncelli, E. P.** _Image quality assessment: from error visibility to structural similarity._ IEEE Transactions on Image Processing, 13(4):600–612, 2004.
  DOI [10.1109/TIP.2003.819861](https://doi.org/10.1109/TIP.2003.819861).
  Fundamentação matemática do SSIM implementado em `metrics.ts`.
- **Zuiderveld, K.** _Contrast Limited Adaptive Histogram Equalization._ In: P. Heckbert (Ed.), Graphics Gems IV, Academic Press, pp. 474–485, 1994.
  DOI [10.1016/B978-0-12-336156-1.50061-6](https://doi.org/10.1016/B978-0-12-336156-1.50061-6).
  Fundamentação matemática do algoritmo CLAHE em grade e interpolação bilinear contínua em `clahe.ts`.
- **CIE (1976) / ISO/CIE 11664-4** — Espaço de cor uniforme $L^_a^*b^*$ e cálculo da diferença euclidiana de cor $\Delta E\_{ab}^_$.
- **IEC 61966-2-1** — Espaço de cor sRGB (funções de transferência usadas em `color.ts`).
- **ITU-R BT.709** — Coeficientes de luminância para conversão fotométrica.
- **Andrew, A. M.** _Another efficient algorithm for convex hulls in two dimensions._ Information Processing Letters, 9(5):216–219, 1979. DOI [10.1016/0020-0190(79)90072-3](<https://doi.org/10.1016/0020-0190(79)90072-3>). Base matemática da envoltória convexa de pinos em `geometry.ts`.
- **EIA RS-274-D / ISO 6983-1** — _Numerical control of machines — Program format and definition of address words._ Padrão industrial para comandos G-code de máquinas CNC implementado em `gcode.ts`.
- **Adobe Systems Incorporated** — _PDF Reference, third edition: Adobe Portable Document Format Version 1.4._ Addison-Wesley, 2001. Especificação de objetos, operadores vetoriais e tabela `xref` implementada em `pdf.ts`.
