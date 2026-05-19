# 🏆 Bolão Copa do Mundo FIFA 2026 — Aplicação Web

Aplicação web do bolão Copa do Mundo 2026 (USA · Canadá · México · 11/06 a 19/07/2026).
Construída como conversão fiel da planilha Excel original, com mesma lógica de classificação,
combinações oficiais do Anexo C FIFA, pontuação e ranking zebra.

**Stack:** Next.js 14 (App Router) · TypeScript · Tailwind CSS · Supabase (Postgres + Auth) · Vercel.

---

## 📂 Estrutura do projeto

```
bolao-2026/
├── app/                          # Rotas Next.js (App Router)
│   ├── page.tsx                  # Home
│   ├── login/page.tsx            # Login Google
│   ├── apostas/page.tsx          # Área principal de palpites (todas as fases)
│   ├── ranking/page.tsx          # Ranking geral
│   ├── ranking-zebra/page.tsx    # Ranking zebra
│   ├── comparativo/page.tsx      # % por jogo
│   ├── estatisticas/page.tsx     # Times mais apostados por fase
│   ├── admin/
│   │   ├── page.tsx              # Painel admin
│   │   ├── resultados/page.tsx   # Cadastrar resultados oficiais
│   │   ├── usuarios/page.tsx     # Lista de usuários
│   │   ├── apostas/page.tsx      # Todas as apostas + export CSV
│   │   └── configuracao/page.tsx # Prazos, pesos, recálculo manual
│   ├── auth/callback/route.ts    # OAuth callback Supabase
│   ├── api/
│   │   ├── bets/route.ts         # CRUD apostas
│   │   ├── results/route.ts      # Admin grava resultados + recalcula
│   │   └── recalc/route.ts       # Recálculo completo (admin/cron)
├── components/                   # Componentes React (BetForm, ResultsEditor, etc.)
├── lib/
│   ├── supabase/                 # Clientes browser / server / service role
│   └── bolao/                    # REGRAS DE NEGÓCIO (independentes da UI)
│       ├── scoring.ts            #   pontuação
│       ├── standings.ts          #   classificação grupos + 3ºs
│       ├── bracket.ts            #   resolução de placeholders KO
│       └── recalc.ts             #   orquestração de recálculo
├── supabase/
│   ├── migrations/001_schema.sql # Tabelas, RLS, triggers, views
│   └── seed/                     # Grupos, times, 104 jogos, 495 opções Anexo C
├── types/database.ts             # Tipos do schema
├── middleware.ts                 # Proteção de rotas (login + admin)
├── .env.example
└── README.md
```

---

## 🚀 Setup local

### 1. Pré-requisitos
- **Node.js 20+**
- **Conta Supabase** (plano free: 500 MB DB + 50k MAU)
- **Projeto Google Cloud** com OAuth Client ID configurado

### 2. Clonar e instalar
```bash
cd bolao-2026
npm install
cp .env.example .env.local
```

### 3. Criar projeto no Supabase
1. Acesse https://supabase.com/dashboard → **New project**
2. Anote a **URL** e as **chaves** em *Settings → API*
3. No **SQL Editor**, execute na ordem:
   - `supabase/migrations/001_schema.sql`
   - `supabase/seed/01_groups_teams.sql`
   - `supabase/seed/02_matches.sql`
   - `supabase/seed/03_fifa_annex_c.sql`

### 4. Configurar Google OAuth
1. **Google Cloud Console** → *APIs & Services → Credentials → Create OAuth Client ID*
   - Application type: **Web application**
   - Authorized redirect URIs: `https://<seu-projeto>.supabase.co/auth/v1/callback`
2. **Supabase** → *Authentication → Providers → Google* → cole Client ID + Secret → **Enable**
3. **Supabase** → *Authentication → URL Configuration*:
   - Site URL: `http://localhost:3000` (depois trocar para produção)
   - Redirect URLs: adicionar `http://localhost:3000/auth/callback` e o domínio de produção

### 5. Preencher `.env.local`
```env
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
NEXT_PUBLIC_SITE_URL=http://localhost:3000
ADMIN_EMAILS=alexandre.oppermann@gmail.com
CRON_SECRET=cole-aqui-uma-string-aleatoria-grande
```

### 6. Rodar
```bash
npm run dev
```
Abra http://localhost:3000.

---

## ☁️ Deploy em produção

### Vercel (front-end)
1. Faça push do repositório para GitHub
2. Em https://vercel.com → **New Project** → importe o repo
3. Em *Environment Variables*, adicione todas as variáveis do `.env.example`
4. Deploy. Vercel já configura HTTPS + domínio `.vercel.app`

### Atualizar Supabase com domínio de produção
1. *Authentication → URL Configuration* → Site URL: `https://seu-domain.vercel.app`
2. Adicionar `https://seu-domain.vercel.app/auth/callback` em Redirect URLs
3. Google Cloud → adicionar `https://<seu-projeto>.supabase.co/auth/v1/callback` (já estava) — sem mudança

### Limites do plano gratuito
- **Supabase free**: 500 MB de banco, 50.000 MAU, 5 GB bandwidth. **Suficiente** para um bolão de até ~200 apostadores e 100k requests/dia.
- **Vercel hobby**: ilimitado para uso pessoal/não-comercial.
- **Google OAuth**: gratuito para qualquer escala.

---

## 🎲 Como funciona o sistema

### Login
- Botão "Entrar com Google" → Supabase Auth → callback grava cookie de sessão.
- Trigger `handle_new_user()` cria automaticamente um `profile` para cada user novo.
- O e-mail `alexandre.oppermann@gmail.com` é marcado `is_admin = true` automaticamente.
- Para promover outro admin no futuro: `UPDATE profiles SET is_admin = true WHERE email = '...'`.

### Área de Apostas (`/apostas`)
**Página única** com todas as 7 fases:
1. Fase de grupos (12 grupos, 72 jogos) — inputs de placar
2. 16-avos · oitavas · quartas · semis · 3º lugar · final
3. **Cada palpite é salvo automaticamente** 800ms após o usuário parar de digitar
4. **Cruzamentos atualizam dinamicamente**: ao trocar um placar, a classificação dos grupos
   recalcula no cliente e os jogos do mata-mata mostram automaticamente os times correspondentes
   (incluindo a aplicação correta do Anexo C FIFA)
5. Painel "Identificação Anexo C" mostra a chave (ex: `BCEGHIJL`) e a opção (#93) atual

### Definição dos classificados
- Função `computeGroupStandings()` em `lib/bolao/standings.ts`
- Critérios: 1) Pontos, 2) Saldo, 3) GP, 4) ordem alfabética
- 1º e 2º de cada grupo + 8 melhores 3ºs colocados

### Classificação dos terceiros e Anexo C
- `computeThirdPlaceRanking()` rankeia os 12 terceiros por (pts, saldo, GP, nome)
- Os 8 melhores formam uma chave ordenada (ex: `BCEGHIJL`)
- Tabela `fifa_annex_c` contém as **495 combinações oficiais**
- `findAnnexCOption()` faz lookup pela chave → retorna a opção #N (1..495)
- Cada uma das 8 posições (1A, 1B, 1D, 1E, 1G, 1I, 1K, 1L) tem o grupo cedente do 3º

### Cruzamentos
- Tabela `matches` armazena placeholders simbólicos: `"1A"`, `"2C"`, `"3rd_pos_1E"`, `"winner_M73"`, `"loser_M101"`
- `resolvePlaceholder()` (`lib/bolao/bracket.ts`) traduz para time concreto usando:
  - Classificação dos grupos (para `"2A"`, `"1F"`)
  - Anexo C (para `"3rd_pos_*"`)
  - Resultado de jogos anteriores (para `"winner_M*"` / `"loser_M*"`)
- Função `populateKnockoutMatches()` aplica a resolução em cascata para toda a chave

### Ranking
- View `user_rankings` agrega `points_with_zebra` por usuário
- Atualizada em tempo real (não precisa recalcular)
- Posição via `RANK()` SQL window function

### Ranking zebra
- View `user_rankings_zebra` calcula `(points_with_zebra - points)` = bônus zebra
- Multiplicador zebra é aplicado quando o usuário acerta um resultado pouco apostado
  - **>35%** dos apostadores no mesmo outcome: **1.0×** (sem bônus)
  - **20-35%**: **1.5×**
  - **≤20%**: **2.0×**

### Admin: cadastro de resultados (`/admin/resultados`)
- Tabela editável com todos os 104 jogos
- Ao clicar 💾 em um jogo: POST `/api/results` → service role atualiza `matches` → dispara
  `recalcMatchAndAllBets()` → para cada aposta:
  1. Calcula pontos brutos via `calculateBasePoints()`
  2. Calcula distribuição de outcomes entre TODAS as apostas desse jogo
  3. Aplica multiplicador zebra
  4. Persiste `points` + `points_with_zebra`
- Em seguida `recalcBracket()` re-resolve placeholders do mata-mata
- Botão "Recalcular tudo" recomputa tudo do zero (útil após mudanças em massa)
- Toda ação fica registrada em `audit_log` com o e-mail do admin

### Controle de prazo
- **Global**: campo `settings.global_bets_deadline` (timestamp). Após esta data, API rejeita escrita.
- **Por jogo**: campos `matches.locked_for_bets` e `matches.bets_deadline` (não usado por padrão; ative pelo SQL Editor).
- **Bloqueio total**: `settings.bets_locked = true` impede qualquer escrita.

---

## 🧪 Como testar a aplicação

### Smoke test após deploy
1. Faça login com Google
2. Vá em **/apostas** → preencha 1-2 placares na fase de grupos → veja a tabela de classificação atualizar
3. Vá em **/admin/resultados** → cadastre placar real de um jogo → salve
4. Vá em **/ranking** → deve aparecer o usuário com pontuação calculada
5. Vá em **/comparativo** → distribuição % deve aparecer

### Teste do Anexo C
1. Em `/apostas`, preencha todos os 72 jogos da fase de grupos
2. Observe o painel "Identificação Anexo C FIFA" — deve mostrar uma chave de 8 letras (ex: `BCEGHIJL`) e a Opção #N
3. Role até "16-avos de Final" — os jogos com placeholder `3rd_pos_*` devem mostrar nomes concretos de seleções
4. Cross-reference com o PDF do regulamento FIFA para validar (ex.: chave `EFGHIJKL` = Opção #1)

### Teste do Ranking Zebra
1. Cadastre 2 usuários A e B
2. Ambos apostam no jogo X: A em `2x0` (vitória time 1), B em `0x2` (vitória time 2)
3. Admin cadastra resultado real `2x0` → A acerta, B não
4. Como **50% apostou na vitória do time 1** (≥35%), multiplicador zebra = 1.0× → A ganha 9 pontos sem bônus
5. Cadastre cenário inverso: 9 apostam `2x0`, 1 aposta `0x2`. Resultado real `0x2`. Como só **10%** acertou (≤20%), o "azarão" recebe **2.0×** → 18 pts. Esse usuário aparece no topo do `/ranking-zebra`.

---

## 📥 Como importar/cadastrar jogos

Os 104 jogos da Copa 2026 já estão pré-cadastrados via `02_matches.sql`. Para alterar:

```sql
-- Mudar data/hora de um jogo
update matches set match_date = '2026-06-15', kickoff_brt = '17:30'
where id = 13;

-- Trocar venue
update matches set venue = 'Cidade do México' where id = 1;
```

Para reimportar do zero:
```sql
truncate matches restart identity cascade;
-- depois reexecute 02_matches.sql
```

---

## 🔌 Integração com API de resultados (opcional)

A versão atual usa **entrada manual de resultados** (decisão do produto). Para adicionar
sincronização automática com Football-Data.org:

1. Cadastre-se em https://www.football-data.org/ (grátis: 10 req/min)
2. Adicione `FOOTBALL_DATA_API_KEY=...` no `.env.local`
3. Crie `app/api/sync/route.ts` chamando `https://api.football-data.org/v4/competitions/WC/matches`
   e mapeando os jogos pelos times.
4. Configure um Vercel Cron Job em `vercel.json`:

```json
{
  "crons": [{ "path": "/api/recalc", "schedule": "*/15 * * * *" }]
}
```

A rota `/api/recalc` aceita `Authorization: Bearer ${CRON_SECRET}`.

---

## 🛡️ Segurança implementada

- **RLS habilitado** em todas as tabelas — usuários só veem/editam suas próprias apostas
- **Service role key** nunca exposta ao client (usada só em route handlers server-side)
- **Middleware** bloqueia `/apostas` e `/admin` para não-logados; `/admin` exige `is_admin`
- **Zod** valida payloads das APIs
- **Constraint `unique (user_id, match_id)`** impede aposta duplicada
- **CSP**: pode ser endurecido em produção via `next.config.js` headers
- **Audit log** rastreia ações administrativas com e-mail do ator

---

## 🐛 Troubleshooting

| Problema | Causa provável | Solução |
|---|---|---|
| Login redireciona para erro | Redirect URLs não cadastradas no Supabase | *Authentication → URL Configuration* |
| `/admin` redireciona para home | `is_admin = false` no profile | Rode SQL: `update profiles set is_admin = true where email = '...'` |
| Cruzamentos não aparecem | Fase de grupos incompleta | Preencher TODOS os 72 jogos da fase de grupos |
| Pontuação não atualiza | Cache do navegador | Force refresh (Ctrl+Shift+R) ou clique "Recalcular tudo" no admin |
| 3ºs aparecem como placeholder `(3rd_pos_1A)` | Anexo C ainda não tem chave de 8 letras | Faltam grupos sem placar ainda; preencha mais jogos |

---

## 📚 Referências

- Planilha original do bolão (referência principal de UI/regras)
- Regulamento oficial FIFA 2026: https://digitalhub.fifa.com/m/636f5c9c6f29771f/original/FWC2026_regulations_EN.pdf
- Tabela Anexo C: 495 combinações dos 8 melhores 3ºs colocados
- Supabase Docs: https://supabase.com/docs
- Next.js Docs: https://nextjs.org/docs

---

## 📝 Limitações conhecidas e melhorias futuras

- **Critérios de desempate FIFA 4 (conduta) e 5 (ranking FIFA)** não estão automatizados — em
  empates extremos use SQL para ajustar manualmente algum gol.
- **Pênaltis em mata-mata**: admin preenche `home_pens` / `away_pens` quando o placar é empate.
  Apostadores não chutam pênaltis (segue a planilha original).
- **Notificações por e-mail** (jogos próximos, novo resultado) — não implementado. Use Supabase Edge Functions + Resend.
- **Multi-bolões** (várias copas no mesmo banco): coluna `tournament_id` futura.
