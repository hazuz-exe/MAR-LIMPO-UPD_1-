# Mar Limpo 3.0

Plataforma educativa sobre poluição marinha: mapa ambiental do Brasil, escolha de onde ajudar, jornada de um resíduo, desafios, compromissos com conquistas, simulação de contribuição (sem pagamento real) e observatório de dados.

## Executar

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # reinicia ao editar
npm test           # 12 testes de API (node:test, sem dependências extras)
```

Requer Node.js 18.17+. Para só ver o visual, abra `public/index.html` direto no navegador: entra o **modo demonstração** (sem servidor), com banner e dados fictícios identificados.

## O que mudou da 2.0 para a 3.0

- Frontend dividido em CSS (`base`, `sections`, `motion`) e módulos JS por responsabilidade (`public/js/*`), em scripts clássicos para funcionar também via `file://`.
- Fontes (Space Grotesk, DM Sans, DM Mono) agora são **locais**. Na 2.0 eram declaradas mas nunca carregavam (a CSP bloqueava fontes externas).
- Novo: mapa do Brasil (3 camadas, filtros de região e ano, painel, comparação regional), "Onde você gostaria de ajudar?", jornada interativa, quiz e curiosidades, cartão de compromisso em PNG, 5 conquistas, simulação em 5 etapas com recibo, observatório com 3 abas (oficial / comunidade / demonstração), agenda com eventos confirmados × exemplos.
- Removida a antiga demonstração de pagamento. Veja `legacy/README.md`.

### API (compatível com a 2.0)

`/api/pledges`, `/api/impact`, `/api/leaderboard`, `/api/events` mantêm os campos antigos. Acrescentados: `uf` opcional em `POST /api/pledges`; `byRegion`, `byUf`, `byDay` em `/api/impact`; `badges` em `/api/leaderboard`; `GET /api/me/summary`, `GET /api/actions`, `POST /api/simulations`, `GET /api/simulations/stats`. Novas ações: `aprender-descarte`, `apoiar-preservacao`.

Mudança de comportamento: o mesmo compromisso (mesma ação + estado) só conta **uma vez por dia** por sessão e há teto de 12 registros/dia, para evitar inflar o painel.

## Dados: de onde vem cada número

| Tipo | Onde | Observação |
|---|---|---|
| Oficial | `public/js/data/indicators.js` | Fonte, ano e link em cada indicador |
| Comunidade | `data/pledges.json` via API | Participação digital, não lixo removido |
| Demonstração | `data/simulations.json` e semente do modo demo | Valores simbólicos; nada é arrecadado |

**Dados oficiais importados hoje:** coleta de lixo domiciliar, IBGE Censo 2022: Brasil (2000: 76,4%; 2010: 85,8%; 2022: 90,9%), São Paulo (99,0%, maior UF), Maranhão (69,8%, menor UF; +16,3 p.p. desde 2010), municípios com menos de 5 mil hab. (78,9%) e com mais de 500 mil (98,9%); referência global do PNUMA (19–23 Mt/ano de plástico em ecossistemas aquáticos).

**O que NÃO está importado (e o site diz isso):** valores das outras 25 UFs, dados municipais, SINIR, SINISA e qualquer medição direta de lixo em praias ou no mar. Para ampliar, acrescente valores em `indicators.js → ufs` copiando-os da fonte oficial e atualize ano/fonte. O mapa passa a colorir sozinho.

Coleta municipal **não** é quantidade de plástico no mar; isso está avisado em vários pontos da interface. A classificação de regiões e de litoral (17 UFs) segue a divisão territorial do IBGE.

## Segurança (revisão feita)

- CSP sem inline (`script-src 'self'; style-src 'self'; font-src 'self'`), HSTS em produção, `X-Frame-Options`, COOP.
- Escritas exigem `X-Requested-With`; validação de ação, UF, valor e destino; apelido com e-mail/link vira "Anônimo".
- Roblox OAuth (PKCE) preservado. **Novo:** o `state` também fica preso à sessão do navegador (evita login CSRF) e o `redirect_uri` vai na troca do código. `/api/me` devolve só nome, usuário, avatar e link do perfil. Nenhum segredo vai ao navegador.
- Rotas `/api` e `/auth` inexistentes retornam JSON 404; JSON inválido retorna 400.
- Simulação: sem cartão, CPF, senha, banco ou PIX; sem ligação com sessão ou participante; arquivo separado.

## Variáveis de ambiente

`SESSION_SECRET` (obrigatória em produção), `PORT`, `NODE_ENV`, `DATA_DIR`, e, só para o login Roblox, `ROBLOX_CLIENT_ID`, `ROBLOX_CLIENT_SECRET`, `ROBLOX_REDIRECT_URI`. Veja `.env.example`.

## Limitações conhecidas

- Armazenamento em JSON: bom para demonstração e pequeno porte. Em hospedagens com várias instâncias ou disco temporário os dados podem se perder ou divergir. Em uso público contínuo, migre para PostgreSQL com backup.
- Limite de requisições em memória (por processo). Apelidos públicos não têm moderação além do filtro básico.
- Sessões anônimas por cookie: limpar o cookie cria outro participante.
- Mapa: geometria simplificada de `@svg-maps/brazil`; só 27 UFs (sem municípios).
- Agenda real fica vazia até a equipe cadastrar eventos confirmados em `data/events.json` (`kind: "confirmado"`). Os 3 exemplos do site são fictícios e rotulados.
- Respostas do quiz são orientações gerais; regras de coleta variam por cidade.

## Créditos e fontes

Mapa: `@svg-maps/brazil`, Victor Cazanave (CC BY 4.0, ver `public/js/data/LICENSE-brazil-map.md`). Fontes tipográficas sob SIL OFL (`public/fonts/`). Referências: IBGE, PNUMA, NOAA (lista completa na seção "Fontes" do site).

## Estrutura

```text
public/  index.html, css/{base,sections,motion}.css, fonts/, js/{core,demo,motion,map,help,journey,learn,pledges,simulation,observatory,community,main}.js, js/data/{shared,brazil-map,indicators,content}.js
data/    events.json, pledges.json, simulations.json
legacy/  index-legacy.html (referência histórica), README.md
scripts/ build-map.js    test/ api.test.js
server.js  package.json  .env.example  .gitignore
```
