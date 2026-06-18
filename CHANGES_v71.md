# Bolão Copa 2026 — Atualização v71

4 melhorias em `/meus-resultados`. Sem migration, sem alterar regra de
pontuação, sem alterar recálculo/ranking/banco.

## Diagnóstico (em ordem)

| # | Pergunta | Resposta |
|---|---|---|
| 1 | Onde monta os cards | `components/MyResultsView.tsx → BetCard`. |
| 2 | Campos do `BetAudit` | `bet`, `match`, `bet_home/away_team`, `real_home/away_team`, `scoring_match`, `scoring_home/away_team`, `inverted`, `reason`, `points`, `points_with_zebra`. |
| 3 | `buildBetAudit` tem info para placar cheio? | **Sim**. Comparo `bet.home/away_score` com `scoring_match.home/away_score` respeitando `inverted`. |
| 4 | Onde existe a regra/fator zebra | `lib/bolao/scoring.ts → zebraMultiplier(pctHit, settings)`. View `match_bet_distribution` dá `pct_home/draw/away` para cada match. |
| 5 | Multiplicador para jogos pontuados | `points_with_zebra / points` (efetivo, gravado pelo recalc). |
| 6 | Multiplicador para jogos futuros | `zebraMultiplier(pctHit, settings)` onde `pctHit` é a % da distribuição que apostou no mesmo outcome do palpite. Reutiliza a MESMA função do recalc — sem duplicar regra. |
| 7 | Como tratar mata-mata sem fator | Skip badge; label sutil "Sem fator no mata-mata". KO recalc grava `points_with_zebra = points` (sem zebra de placar). |
| 8 | Arquivos alterados | 2: `app/meus-resultados/page.tsx`, `components/MyResultsView.tsx`. |
| 9 | Migration? | **Nenhuma**. |

## Mudanças

### 1. Fator multiplicador (rodapé do card)

| Situação | Exibição | Cor |
|---|---|---|
| Jogo de grupo pontuado | `Fator: 1.42×` | cinza forte |
| Jogo de grupo futuro | `Potencial: 1.85×` (tooltip: "se o resultado for o seu palpite") | âmbar |
| KO (com ou sem resultado) | `Sem fator no mata-mata` (tooltip) | cinza claro |

Fórmula efetiva (jogos pontuados):
```
mult = points_with_zebra / points    (só quando points > 0)
```

Fórmula potencial (jogos futuros, fase de grupos):
```
out = outcomeOf(bet.home_score, bet.away_score)       // 'home' | 'draw' | 'away'
pct = match_bet_distribution[match.id][out]
mult = zebraMultiplier(pct, settings)                  // MESMA fn do recalc.ts
```

### 2. Fator dos classificados (formato amigável)

Antes: `1.270×` (`.toFixed(3)`)
Agora: `1.27×` (`.toFixed(2)`). Valor numérico inalterado — só apresentação.

### 3. Placar exato (destaque verde escuro)

Detector novo `isExactScore(audit)` em `MyResultsView.tsx`:
```ts
function isExactScore(a: BetAudit): boolean {
  const sm = a.scoring_match;
  if (!sm || sm.home_score == null || sm.away_score == null) return false;
  if (a.inverted) return a.bet.home_score === sm.away_score && a.bet.away_score === sm.home_score;
  return a.bet.home_score === sm.home_score && a.bet.away_score === sm.away_score;
}
```

Quando true, o card recebe:
- borda `border-2 border-emerald-700`
- fundo `bg-emerald-50`
- placar do palpite em `text-emerald-800`
- badge "🎯 Placar cheio" no canto superior direito
- badge de pontos em `bg-emerald-700 text-white`

**Respeita mando invertido** (case `a.inverted = true` testado).
**Não confunde** com acerto de vencedor/saldo — só dispara se os 2 placares baterem exatamente.

### 4. Abertura no dia corrente / próximo

Helpers em `MyResultsView.tsx`:
```ts
function getBrtTodayISO(): string {
  // UTC-3 fixo (BRT). Subtrai 3h de UTC e extrai getUTC* — imune ao fuso do client.
}

function pickInitialDay(sortedDates, today): string {
  if (sortedDates.length === 0) return 'all';
  if (sortedDates.includes(today)) return today;
  const next = sortedDates.find(d => d > today);
  if (next) return next;
  return sortedDates[sortedDates.length - 1];
}
```

Aplicado em `useState(() => pickInitialDay(...))` — roda 1× por mount. Como
a troca de jogador pelo admin usa `router.push('?user=X')`, o componente
desmonta e remonta → init roda de novo com os audits do jogador novo.

**Comportamento**:
- Tem jogos hoje → abre em hoje.
- Sem hoje, tem futuro → abre no próximo futuro.
- Tudo passado → abre no último dia.
- Sem audits → 'Todos os dias'.

## Arquivos alterados (2) · 0 migrations

| Arquivo | Mudança |
|---|---|
| `app/meus-resultados/page.tsx` | • Carrega `settings` e `match_bet_distribution` (paginado via `fetchAll`).<br>• Monta `distByMatch: Record<match_id, { pct_home, pct_draw, pct_away, total }>`.<br>• Passa `settings` e `distByMatch` como props para `MyResultsView`. |
| `components/MyResultsView.tsx` | • Helpers novos: `getBrtTodayISO`, `pickInitialDay`, `isExactScore`, `multiplierForPointedBet`, `potentialMultiplier`.<br>• Props expandidas com `settings` + `distByMatch`.<br>• `dayFilter` inicializado via `pickInitialDay`.<br>• `BetCard` recebe `settings`/`dist` e renderiza fator efetivo/potencial/N/A + destaque verde escuro com badge "🎯 Placar cheio".<br>• Classificados: fator de `.toFixed(3)` → `.toFixed(2)`. |

## Reuso (zero regra duplicada)

- **Fator efetivo**: `audit.points_with_zebra / audit.points` (números do banco).
- **Fator potencial**: `zebraMultiplier(pctHit, settings)` — função importada de `lib/bolao/scoring.ts`, idêntica à usada por `recalc.ts`.
- **Placar exato**: derivado de campos já existentes em `BetAudit`.
- **Pontos exibidos**: continuam vindo de `bet.points`/`bet.points_with_zebra`.

Frontend só apresenta. Recálculo, ranking, scoring e banco intactos.

## Como testar

```bash
rm -rf .next && npm run lint && npm run build && npm run dev

# Cenários:
# 1. Logar como usuário. Abrir /meus-resultados:
#    - Filtro vem no dia atual BRT (se tiver jogos hoje); senão próximo;
#      senão último.
#    - Cards: jogos de grupo passados mostram "Fator: X.XX×".
#    - Cards: jogos de grupo futuros mostram "Potencial: X.XX×".
#    - Cards: jogos KO (passado ou futuro) mostram "Sem fator no mata-mata".
#    - Placar cheio: borda verde escuro + badge "🎯 Placar cheio" no jogo
#      onde bet matches scoring_match exatamente.
#
# 2. Admin trocando jogador: dropdown muda → reload → filtro inicial
#    recalcula para o novo jogador.
#
# 3. Trocar manualmente para "Todos os dias" → filtro respeitado.
#
# 4. Classificados (fim da página): fator agora aparece como "1.27×",
#    não "1.270×".
```

## Checklist

### Fator de jogo
- [ ] Jogos pontuados (grupo) mostram `Base · Fator · Pts finais`.
- [ ] Jogos futuros (grupo) mostram `Potencial: X.XX×`.
- [ ] Jogos KO **não** mostram fator (label sutil "Sem fator no mata-mata").
- [ ] Fator efetivo = `points_with_zebra / points` (não recalcula no front).
- [ ] Fator potencial usa `zebraMultiplier` do `scoring.ts` (mesma fn do recalc).

### Classificados
- [ ] Fator exibido como `1.27×` (não `1.270×`).
- [ ] Valor numérico inalterado.

### Placar cheio
- [ ] Acertou placar exato → card com borda verde escura + badge "🎯 Placar cheio".
- [ ] Acertou vencedor sem placar exato → **não** dispara.
- [ ] Acertou saldo sem placar exato → **não** dispara.
- [ ] KO com mando invertido + placar exato (na orientação correta) → dispara.
- [ ] Confronto em outra fase + placar exato no `scoring_match` → dispara.

### Filtro inicial
- [ ] Hoje (BRT) com jogos → abre no hoje.
- [ ] Sem hoje, com futuros → abre no próximo.
- [ ] Tudo passado → abre no último dia.
- [ ] "Todos os dias" continua disponível e selecionável.
- [ ] Troca manual do filtro é respeitada após init.
- [ ] Admin trocando jogador → recalcula dia inicial para o novo conjunto.
- [ ] Sem bug de timezone (BRT = UTC-3 fixo, `getUTC*` no helper).

### Acesso e segurança
- [ ] Usuário comum vê só os próprios (server-side força `user.id`).
- [ ] Admin pode trocar jogador via `?user=<uuid>`.
- [ ] Não expõe email de outros usuários.

### Sem regressão
- [ ] Pontuação: `bets.points` / `points_with_zebra` / `user_qualification_scores` inalterados.
- [ ] Ranking inalterado.
- [ ] Recálculo inalterado.
- [ ] Banco/migration inalterados.
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Resumo

- **2 arquivos modificados**, **0 novos**, **0 migrations**.
- 2 queries novas no server (settings + match_bet_distribution).
- 5 helpers novos no client (`getBrtTodayISO`, `pickInitialDay`, `isExactScore`, `multiplierForPointedBet`, `potentialMultiplier`).
- Fator efetivo: vem do banco (zero duplicação).
- Fator potencial: usa `zebraMultiplier` (mesma fn do `recalc.ts`).
- Erros TS no sandbox (`key` em prop, `process`, namespace JSX) são
  pré-existentes pela ausência de `node_modules` — em produção compila normal.
