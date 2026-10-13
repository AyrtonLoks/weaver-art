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
  Formula string art como otimização discreta, compara em resolução reduzida (modelo de
  percepção), trata os lados dos pinos e fabrica com braço robótico. Base para o roadmap de
  refinamento global e modelo de distância de observação.
- **IEC 61966-2-1** — espaço de cor sRGB (funções de transferência usadas em `color.ts`).
- **ITU-R BT.709** — coeficientes de luminância.
