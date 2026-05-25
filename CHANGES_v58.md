# Bolão Copa 2026 — Atualização v58

Vice-campeão (perdedor da final) passa a pontuar como fase oficial do bolão,
editável pelo admin. Home ganha bloco de premiação estimada (60/30/10 sobre
participantes × R$ 50).

## Diagnóstico

### 1. Onde campeão e terceiro são calculados
`lib/bolao/qualification.ts`:
- `extractAdvancingTeams(matches, hints?)` extrai os times que chegaram a
  cada fase (incluindo `champion` = vencedor da final e `third_place` =
  vencedor da disputa de 3º).
- `extractUserPrediction(...)` simula a árvore do palpite do usuário e
  retorna o mesmo formato.
- `calculateUserQualificationScores(...)` itera `PHASE_ORDER` e gera uma
  linha em `user_qualification_scores` para cada (usuário, fase, team_id)
  previsto, aplicando `phasePointsBase(phase, settings) × (1 + zebraFactor)`.

### 2. Por que o vice não estava pontuando
Não existia a fase `runner_up` no enum `qualification_phase` nem em
`PHASE_ORDER`/`phasePointsBase`. O campo `settings.pts_qual_runner_up`
também não existia. A v56 adicionou um `extractRunnerUp` *apenas para
exibição* em `/estatisticas`, mas o vice nunca entrava em
`user_qualification_scores`, então nunca pontuava no ranking nem na
auditoria.

### 3. Extração do vice já existia?
Parcialmente: `extractRunnerUp(matches, hints)` (v56) usa
`determineMatchLoserId` no jogo da final, considerando `knockout_advancer`
e pênaltis corretamente. Faltava plugar essa extração no fluxo de scoring.

### 4. Onde os pontos por fase são configurados
Tabela `settings` (migration 003) — colunas `pts_qual_*`. Editáveis em
`/admin/configuracao` via `SettingsForm` → POST `/api/settings`.

### 5. Como incluir `pts_qual_runner_up`
Migration 006 (idempotente):
- `ALTER TYPE qualification_phase ADD VALUE IF NOT EXISTS 'runner_up' AFTER 'champion'`
- `ALTER TABLE settings ADD COLUMN IF NOT EXISTS pts_qual_runner_up int NOT NULL DEFAULT 30`
- `UPDATE settings SET pts_qual_groups=10, pts_qual_r32=12, ..., pts_qual_runner_up=30, pts_qual_champion=40 WHERE id=1`

### 6. Migration SQL
**SIM** — `supabase/migrations/006_runner_up_phase.sql`. Idempotente, não
apaga bets/resultados/usuários/overrides/audit_log/RLS.

### 7. Arquivos alterados
| Arquivo | Mudança |
|---|---|
| `supabase/migrations/006_runner_up_phase.sql` | **NOVO** — adiciona enum + coluna + UPDATE pesos. |
| `types/database.ts` | `QualificationPhase` ganha `'runner_up'`. `Settings` ganha `pts_qual_runner_up: number`. |
| `lib/bolao/scoring.ts` | `DEFAULT_SETTINGS.pts_qual_runner_up = 30`. |
| `lib/bolao/qualification.ts` | `PHASE_ORDER` inclui `'runner_up'`. `phasePointsBase` retorna `settings.pts_qual_runner_up`. `extractAdvancingTeams` popula `result.runner_up` com o perdedor da final. `extractUserPrediction` simplificado (vice já entra em `byPhase`). `buildPredictionCensus` mantém `runnerUpCounts` como alias para compat. |
| `app/api/settings/route.ts` | Zod schema aceita `pts_qual_runner_up`. |
| `components/SettingsForm.tsx` | Campo editável "Vice-campeão (perdedor da final)" em `QUAL_DEFAULTS`/`QUAL_LABELS`. |
| `components/MyPointsSummary.tsx` | `PHASE_LABEL.runner_up = 'Vice-campeão'`. |
| `app/estatisticas/page.tsx` | Card "Vice-campeão" agora é fase normal (não pseudo); usa o fluxo regular `rowsForPhase('runner_up')`. Ordem de exibição mantém: ...Campeão → Vice → Terceiro. |
| `components/PrizeEstimateBox.tsx` | **NOVO** — bloco de premiação estimada na home. |
| `app/page.tsx` | • Import de `PrizeEstimateBox` + render logo após `PixCopyBox` (cirúrgico — não toca hero/PixCopyBox).<br>• Linha "Vice-campeão (perdedor da final)" entre Terceiro e Campeão na tabela de pontuação. |

### 8. Como a premiação da home é calculada
```
total = participantes × R$ 50
1º lugar = total × 60%
2º lugar = total × 30%
3º lugar = total × 10%
```
Usa o `totalUsers` que a home **já busca** (`profiles count exact head`) —
nenhuma query nova. Sem distinguir pago/não pago neste momento.

### 9. A home usa `totalUsers` já disponível?
Sim. `app/page.tsx` já faz `count: totalUsers` em `profiles`. O componente
`<PrizeEstimateBox participants={totalUsers ?? 0} perParticipant={50} />`
apenas reaproveita o número.

## Migration SQL (rodar 1× no Supabase)

```sql
-- supabase/migrations/006_runner_up_phase.sql
alter type public.qualification_phase
  add value if not exists 'runner_up' after 'champion';

alter table public.settings
  add column if not exists pts_qual_runner_up int not null default 30;

update public.settings set
  pts_qual_groups    = 10,
  pts_qual_r32       = 12,
  pts_qual_r16       = 15,
  pts_qual_quarters  = 25,
  pts_qual_semis     = 30,
  pts_qual_third     = 30,
  pts_qual_runner_up = 30,
  pts_qual_champion  = 40
where id = 1;
```

Idempotente. Não apaga bets, resultados, usuários, overrides, audit_log ou RLS.

**Se você já editou pontos via admin com valores customizados**, comente o
bloco `update settings set ...` antes de rodar — o `ALTER TYPE` e o
`ADD COLUMN` continuam idempotentes.

## Nova regra do vice (objetiva)

1. `phasePointsBase('runner_up', settings)` retorna `settings.pts_qual_runner_up`
   (default 30).
2. O perdedor da final (real ou simulado) é detectado por
   `determineMatchLoserId(finalMatch, knockoutHint)` — respeita pênaltis
   reais e `knockout_advancer` do palpite.
3. `extractAdvancingTeams` agora popula 2 fases a partir da final:
   `champion = vencedor` e `runner_up = perdedor`.
4. `buildPredictionCensus` itera `PHASE_ORDER` (que inclui `runner_up`) e
   conta o vice em `counts.get('runner_up:<teamId>')`.
5. `calculateUserQualificationScores` gera uma linha em
   `user_qualification_scores` para `(user_id, 'runner_up', team_id)`.
6. View `user_rankings_full` agrega tudo (já é `sum(points_final)` sobre
   todas as fases — não precisa mudar a view).

## Fator zebra do vice

Idêntico a campeão e terceiro:
```
factor = (totalApostadores − apostadoresNoMesmoTimeNaMesmaFase) / totalApostadores
pontosFinais = pts_qual_runner_up × (1 + factor)
```
- Se muita gente apostou no mesmo vice → factor ≈ 0 → ~30 pts.
- Se poucos apostaram nesse vice e ele realmente foi vice → factor ≈ 1 → ~60 pts.

## Premiação na home (objetiva)

Componente `PrizeEstimateBox`:
- Server Component sem hooks, recebe `participants: number` e
  `perParticipant?: number` (default 50).
- Formata em BRL via `Intl.NumberFormat('pt-BR', { style: 'currency' })`.
- Exibe: participantes, total, 1º (60%), 2º (30%), 3º (10%).
- Não toca em `PixCopyBox`, hero ou cards reposicionados.

## Comandos para testar

```bash
# 1) Aplicar arquivos do zip
# 2) Rodar a migration 006 no Supabase (SQL Editor):
#    Cole o conteúdo de supabase/migrations/006_runner_up_phase.sql → Run
# 3) Dev local
rm -rf .next
npm run dev

# 4) Em /admin/configuracao, ver o novo campo "Vice-campeão (perdedor da final)".
#    Ajustar se quiser (default 30) → Salvar → Recalcular tudo.

# 5) Lint + build
npm run lint
npm run build
```

### Cenários de teste

**Cenário A — Recálculo gera fase runner_up**
1. Após migration 006 + recalc, abrir `/admin/pontuacao` → entrar em um usuário
   com palpite completo → ver linha `runner_up` na tabela de "Pontuação por
   Classificação de Seleções", com Base/Fator/Pts Finais preenchidos.

**Cenário B — Vice real definido**
1. Admin preenche o resultado da final (com ou sem pens). Recálculo
   identifica o perdedor como vice real (`real.runner_up = {team_id}`).
2. Em `/estatisticas`, card "Vice-campeão (1 seleção)" mostra ✅ na seleção
   que realmente foi vice.

**Cenário C — Empate com knockout_advancer**
1. Palpite do usuário: final empatada + `knockout_advancer = home`.
2. `extractUserPrediction` → `byPhase.champion = {home_id}` e
   `byPhase.runner_up = {away_id}`.
3. Auditoria mostra ambos os times com pontuação correspondente.

**Cenário D — Final ainda sem resultado**
1. Sem placar real na final: `real.runner_up` é vazio.
2. `/estatisticas` mostra todas as previsões com "Avançou? —" (sem ✅).
3. Pontuação só é creditada quando a final for preenchida + recálculo rodado.

**Cenário E — Edição via admin**
1. Em `/admin/configuracao`, alterar "Vice-campeão" para 35 → Salvar →
   Recalcular tudo.
2. Pontuação no ranking dos usuários que acertaram o vice aumenta
   proporcionalmente. Auditoria reflete novo `points_base = 35`.

**Cenário F — Home com premiação**
1. Abrir `/` → ver bloco "💰 Premiação estimada" logo após o PIX.
2. Total = participantes × R$ 50; 1º/2º/3º = 60/30/10%.

## Checklist de validação

### Pontuação do vice
- [ ] Vice-campeão vale 30 pontos base (editável em `/admin/configuracao`).
- [ ] Vice usa o mesmo fator zebra de campeão/terceiro.
- [ ] Usuário que acertar vice recebe pontos no ranking.
- [ ] Usuário que errar vice não recebe pontos.
- [ ] Final com pênaltis/knockout_advancer define vice corretamente
      (`determineMatchLoserId` respeita ambos).
- [ ] Ranking geral inclui pontos de vice (view `user_rankings_full` já
      soma todas as fases).
- [ ] Auditoria em `/admin/pontuacao` mostra linha `runner_up` com
      seleção / acertou? / base / fator / pts finais.
- [ ] Admin de pontuação permite editar pontos do vice.
- [ ] Alterar pontos e recalcular atualiza ranking/auditoria.
- [ ] Estatísticas continuam mostrando o card "Vice-campeão (1 seleção)".

### Home / premiação
- [ ] Home mostra "Premiação estimada" próximo ao PIX.
- [ ] Total = nº participantes × R$ 50.
- [ ] 1º = 60%, 2º = 30%, 3º = 10%.
- [ ] Valores formatados em BRL (`R$ XXX,XX`).
- [ ] Hero **não** alterado.
- [ ] PixCopyBox **não** alterado.
- [ ] Cards reposicionados (Apostadores/Apostas/Total de jogos) intactos.

### Geral
- [ ] `/apostas` continua funcionando.
- [ ] `/comparativo` continua funcionando.
- [ ] `/estatisticas` continua funcionando.
- [ ] Admin (`/admin/*`) continua funcionando.
- [ ] Migrations antigas (001–005) **não** alteradas.
- [ ] `app/page.tsx` recebeu apenas inserções pontuais (1 import + 2 blocos),
      sem reescrita.
- [ ] `app/globals.css`, `components/PixCopyBox.tsx`,
      `components/TeamNameWithFlag.tsx` **não** alterados.
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Resumo

- **9 arquivos** alterados + **2 novos** (migration 006 + PrizeEstimateBox).
- **1 migration SQL** (idempotente, segura).
- Vice agora é fase oficial em `PHASE_ORDER` → pontua, entra no
  ranking/auditoria/estatísticas. Editável via `/admin/configuracao`.
- Home ganha bloco de premiação estimada sem tocar em hero/PixCopyBox.
- Próximo passo após aplicar: **clicar "🔄 Recalcular tudo" em
  `/admin/configuracao`** para regerar `user_qualification_scores` com a
  fase `runner_up`.
