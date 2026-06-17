# Bolão Copa 2026 — Atualização v70

Nova página `/meus-resultados`: lista todos os jogos apostados por um
usuário, com placar apostado, placar real, pontos e status. Admin pode
escolher outro jogador. Filtro por dia. Seção de classificados apostados.

Sem migration. Sem mudar pontuação. Sem mudar ranking. Reutiliza
`buildBetAudit` como fonte única de pontos.

## Diagnóstico (resumo)

| # | Pergunta | Resposta |
|---|---|---|
| 1 | Arquivos reutilizáveis | `lib/bolao/audit.ts → buildBetAudit`, `simulateBracketForUser`. `lib/supabase/fetchAll.ts`. `components/TeamNameWithFlag`. View `user_rankings_full`. |
| 2 | Helper de auditoria de jogo | `buildBetAudit` devolve `bet_home/away_team`, `real_home/away`, `scoring_match`, `inverted`, `reason`, `points`, `points_with_zebra`. **Reutilizado**. |
| 3 | Pontos por jogo | `bets.points` + `bets.points_with_zebra` (já calculados pelo recalc). |
| 4 | Pontos por classificados | `user_qualification_scores` (com regra v69: champion/runner_up/3º vêm da bet da final/3º). |
| 5 | Consulta por usuário | Server-side filtra `eq('user_id', targetUserId)`. |
| 6 | Filtro por dia | Client-side via `useState`, agrupando por `match.match_date`. Lista de datas + contagem. |
| 7 | Admin vs comum | `requireAdmin()` no server. Se admin + `?user=<uuid>`, troca o `targetUserId`. Senão força `user.id`. |
| 8 | Arquivos alterados | 2 novos + 2 modificados. |
| 9 | Migration SQL | **Nenhuma**. |
| 10 | Risco de duplicar pontuação | **Zero** — `buildBetAudit` lê `bet.points`/`bet.points_with_zebra` direto do banco. Frontend só exibe. |

## Arquivos (2 novos + 2 modificados)

### Novos
| Arquivo | Função |
|---|---|
| `app/meus-resultados/page.tsx` | Server Component. Carrega tudo paginado (`fetchAll`), filtra por `targetUserId`, monta audits via `buildBetAudit`, passa para o Client. |
| `components/MyResultsView.tsx` | Client Component. Cards responsivos (mobile-first), filtro por dia, resumo no topo, seção de classificados, seletor de usuário para admin. |

### Modificados
| Arquivo | Mudança |
|---|---|
| `components/HeaderClient.tsx` | Link "Meus Resultados" no `NAV_LINKS` (com `loggedOnly: true`). Aparece no menu desktop e no burger mobile automaticamente. |
| `lib/supabase/middleware.ts` | `requiresLogin` inclui `/meus-resultados` — usuário deslogado é redirecionado para login. |

## Layout

```
+---------------------------------------------------------+
| 📊 Meus Resultados            [Admin: jogador ▾]        |
| Lista de todos os jogos apostados...                    |
+---------------------------------------------------------+

+---------------------------------------------------------+
| Resumo (gradient brand)                                 |
|  [Total + posição] [Pts jogos] [Pts classif] [Zebra]   |
|  [Apostas] [Já pontuaram] [Aguardando]                 |
+---------------------------------------------------------+

+---------------------------------------------------------+
| 📅 Filtrar por dia: [Todos (1556 jogos) ▾]              |
+---------------------------------------------------------+

[Card de jogo #1]
  Fase · data · venue           [Status badge]
  Time A      X × Y      Time B
  (pênaltis se houver)
  --- placar real (se houver) ---
  Time real A   m × n   Time real B
  (motivo / pontos)
  Base: 5   |   [12.0 pts (verde se >0)]

[Card de jogo #2]
...

+---------------------------------------------------------+
| 🏅 Classificados apostados                              |
|  Fase | Seleção | Status | Base | Fator | Pts Finais   |
|  group_stage | Brasil | ⏳ | 10 | 1.5× | 0.00          |
|  ...                                                    |
+---------------------------------------------------------+
```

Tudo responsivo: cards usam `TeamNameWithFlag responsive` (acrônimos no mobile, nome completo desktop).

## Reutilização e segurança

- **`buildBetAudit`** é a fonte única de pontuação. Frontend só exibe
  `audit.points` e `audit.points_with_zebra` (ambos vindos de `bets`).
- **Não duplica regra de pontuação**.
- **Snapshots em `bets`** (`bet_home_team_id` / `bet_away_team_id`) são
  a fonte dos times apostados — robusto contra reset/recalc do bracket
  oficial (v65/v66/v67/v68/v69 garantiram isso).
- **Server-side filtering**: `eq('user_id', targetUserId)` — usuário
  comum nunca vê dados de outros, mesmo se manipular URL.
- **Admin gate**: `targetUserId = isAdmin && searchParams.user ? searchParams.user : user.id`.
- **Email não é exposto**: o seletor de admin usa só `id + display_name`.
- **`force-dynamic` + `revalidate=0`** na página.

## Paginação

Todas as 7 queries (matches, teams, annexC, bets, UQS, rank, profiles-admin)
usam `fetchAll` da v67. Imune ao limit 1000 do PostgREST. `bets` e `UQS`
já vêm filtrados por `eq('user_id', ...)`, então são leves.

## Como aplicar e testar

```bash
# 1) Aplicar os 4 arquivos do zip
# 2) Build + dev
rm -rf .next && npm run lint && npm run build && npm run dev

# 3) Smoke tests:
#    a) Logar como usuário comum → /meus-resultados → ver SEUS jogos.
#    b) Tentar /meus-resultados?user=<uuid-de-outro> → continua mostrando
#       SEUS jogos (server-side força user.id se não-admin).
#    c) Logar como admin → /meus-resultados → ver os próprios. Selecionar
#       outro jogador no dropdown → URL muda para ?user=<uuid> → página
#       recarrega com dados do outro.
#    d) Filtro por dia: clicar em uma data → lista filtra. "Todos os dias"
#       volta ao default.
#    e) Mobile (≥iPhone SE width): cards empilham, TeamNameWithFlag mostra
#       acrônimos, filtro fica fácil de tocar.
#    f) Não logado → tenta /meus-resultados → middleware redireciona /login.

# 4) Visual:
#    - Resumo de pontos no topo bate com /ranking.
#    - Seção de classificados bate com /admin/pontuacao?user=<seu-id>.
#    - Status (✅/❌/⏳) bate com a regra de fase concluída (mesma do v59).
```

## Checklist de validação

### Acesso e segurança
- [ ] Usuário comum vê apenas próprios resultados (mesmo manipulando `?user=` na URL).
- [ ] Admin consegue selecionar outro jogador via dropdown.
- [ ] Deslogado → redirect /login (middleware).
- [ ] Email de outros usuários **não** é exposto (dropdown só tem `display_name`).

### Conteúdo
- [ ] Página mostra todos os jogos apostados do usuário-alvo.
- [ ] Times apostados vêm dos snapshots (`bet_home_team_id` / `bet_away_team_id`).
- [ ] Placar apostado é exibido para todo jogo.
- [ ] Placar real só aparece quando `matches.home_score != null`.
- [ ] Pontos exibidos batem com `bets.points` e `bets.points_with_zebra`.
- [ ] Motivo/status via `AUDIT_REASON_LABEL` (não recalcula no front).
- [ ] Empate de KO mostra "Avança nos pênaltis: <time>".

### Filtro e resumo
- [ ] Filtro por dia lista todas as datas com contagem de jogos.
- [ ] "Todos os dias" funciona.
- [ ] Limpar filtro restaura.
- [ ] Resumo no topo: total/posição, pts jogos, pts classific., bônus zebra,
      total apostas, já pontuaram, aguardando.

### Classificados
- [ ] Seção lista todas as fases em ordem `PHASE_DISPLAY_ORDER`
      (group_stage → r32 → r16 → quarters → semis → third_place → runner_up → champion).
- [ ] Status tri-estado correto (✅/❌/⏳).
- [ ] Pts finais bate com `user_qualification_scores`.

### Menu
- [ ] Link "Meus Resultados" aparece no menu desktop quando logado.
- [ ] Link aparece no burger mobile.
- [ ] Quando deslogado, link não aparece (loggedOnly).

### Geral
- [ ] Nenhum dado de outro usuário leakado para usuário comum.
- [ ] Sem migration.
- [ ] Sem mudança em pontuação/ranking/scoring/recalc.
- [ ] Home/hero/favicon/PixCopyBox/TeamNameWithFlag intactos.
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Resumo

- **2 arquivos novos** (`app/meus-resultados/page.tsx`, `components/MyResultsView.tsx`).
- **2 arquivos modificados** (`HeaderClient.tsx`, `middleware.ts`).
- **0 migrations**, **0 novas rotas de API**, **0 alterações em scoring/recalc/ranking**.
- Reutiliza `buildBetAudit` (fonte única de pontos), `fetchAll` (paginação),
  `TeamNameWithFlag` (responsivo), `user_rankings_full` (resumo),
  `user_qualification_scores` (classificados).
- Erros TS no sandbox (TS 6.0) por ausência de `@types/react`/`process` são
  pré-existentes e não bloqueiam — em produção com TS 5.6.2 compila normal.
