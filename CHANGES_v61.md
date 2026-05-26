# Bolão Copa 2026 — Atualização v61

4 ajustes visuais em `/comparativo`, todos no client. Sem mexer em
pontuação, banco, API, recálculo, home, favicon ou hero.

## Diagnóstico (resumo)

| # | Pergunta | Resposta |
|---|---|---|
| 1 | Onde está o destaque hoje | `components/MatchComparison.tsx` — `pickSide(bet, isKO)` + `classesForSide(side)`. |
| 2 | Como sabe os times reais do jogo selecionado | `MatchHeader` usava `teamForOfficialSide`; a `BetsAuditTable` agora também recebe `realHomeId`/`realAwayId` via props. |
| 3 | Como sabe os times apostados pelo usuário | `a.bet_home_team`, `a.bet_away_team` da `BetAudit`. |
| 4 | Regra de match no KO | Novo helper `betTeamsMatchRealMatch(bet, realHomeId, realAwayId, isKO)` — checa as 2 combinações (cobre mando invertido). |
| 5 | Onde estão pontos e zebra | Colunas `a.points` e `a.points_with_zebra`. |
| 6 | Como obtenho a ordem do ranking | Nova query em `app/comparativo/page.tsx`: `user_rankings_full` (campo `position`). Passa como `rankPositions: Record<userId, number>` para `MatchComparison`. |
| 7 | Arquivos alterados | `app/comparativo/page.tsx`, `components/MatchComparison.tsx`. |
| 8 | Migration SQL | **Nenhuma.** |

## Arquivos alterados (2)

| Arquivo | Mudança |
|---|---|
| `app/comparativo/page.tsx` | Adiciona `supabase.from('user_rankings_full').select('user_id, position').order('position')` em `Promise.all`. Constrói `rankPositions: Record<string, number>` e passa como prop ao `MatchComparison`. |
| `components/MatchComparison.tsx` | • Novo helper `betTeamsMatchRealMatch`.<br>• `PickSide` ganha valor `'none'` (sem destaque).<br>• `classesForSide` ajustado: empate em CINZA + bold; vitória sem bold no placar; `none` sem destaque.<br>• `audits` ordenados por `rankPositions[user_id]`.<br>• `BetsAuditTable` recebe `realHomeId`, `realAwayId`, `rankPositions`.<br>• Nova coluna `#` mostrando posição no ranking.<br>• Células `Pts` e `Pts Zebra` com fundo verde quando > 0. |

## Migration SQL

**Nenhuma.** Reaproveita `user_rankings_full` da migration 003 (já presente
em produção).

## Regras visuais finais

### Vitória do mandante (`side = 'home'`)
- **Time A**: `bg-blue-100`, borda esquerda azul, `font-bold` no nome.
- **Placar**: `bg-blue-50` + texto azul (sem `font-bold` — refinamento da v61).
- **Time B**: `opacity-60` (menos destacado).

### Vitória do visitante (`side = 'away'`)
- **Time A**: `opacity-60`.
- **Placar**: `bg-red-50` + texto vermelho (sem `font-bold`).
- **Time B**: `bg-red-100`, borda direita vermelha, `font-bold` no nome.

### Empate na fase de grupos (`side = 'draw'`)
- **Time A / B**: neutros (sem destaque de vencedor).
- **Placar**: `bg-gray-200`, **`font-bold`**, `text-gray-800`. — antes era amarelo, agora cinza conforme spec.

### Empate em KO + `knockout_advancer`
- Vira `'home'` ou `'away'` como acima — destaque normal (azul/vermelho) e
  o placar vai pro tom da cor do classificado (sem bold).

### Empate em KO sem `knockout_advancer` (`side = 'pending'`)
- Placar `bg-gray-100 italic text-gray-600`. Times apagados.

### Mata-mata em que os times do palpite NÃO batem (`side = 'none'`)
- **Sem nenhum destaque** nas células de times nem no placar. Pontuação na
  coluna Status continua descrevendo o porquê dos pontos (ex.: "confronto
  ocorreu em outra fase"). Visualmente neutro.

### Times do palpite "batem" com o jogo real?

```ts
function betTeamsMatchRealMatch(bet, realHomeId, realAwayId, isKO) {
  if (!isKO) return true;                     // fase de grupos: slots fixos
  const bh = bet.bet_home_team?.id;
  const ba = bet.bet_away_team?.id;
  if (!bh || !ba) return false;
  return (
    (bh === realHomeId && ba === realAwayId) ||
    (bh === realAwayId && ba === realHomeId)   // cobre mando invertido
  );
}
```

Casos explícitos do spec:

| Real | Aposta | Destaque |
|---|---|---|
| Brasil × França | Brasil 2×1 França | 🟦 Brasil destacado |
| Brasil × França | França 1×2 Brasil (invertido) | 🟥 Brasil destacado (sim, Brasil — porque a `pickSide` olha o placar do palpite, e a coluna Time A da linha é Brasil… espere — neste caso Time A=Brasil e away_score=1, home_score=2 — então pickSide=home → Brasil destaca). |
| Brasil × França | Argentina × Alemanha | **sem destaque** |
| Brasil × França | Brasil 1×1 França + adv=home | 🟦 Brasil destacado (advancer) |
| Brasil × França | Argentina × Alemanha 1×1 + adv=away | **sem destaque** |

> Detalhe sobre "mando invertido": a `pickSide` lê o placar do PALPITE
> (não inverte). Como a coluna "Time A" exibe `bet_home_team`, o destaque
> acompanha o palpite. Se o usuário apostou "França 1×2 Brasil" (Brasil é
> Time B no palpite), `pickSide = 'away'` → coluna direita (Brasil)
> destaca. Visualmente o vencedor do palpite fica correto.

## Pontos em destaque (verde)

- `a.points > 0`           → célula **Pts**       com `bg-green-100 text-green-800 font-semibold`.
- `a.points_with_zebra > 0` → célula **Pts Zebra** com `bg-green-100 text-green-800 font-bold`.
- Caso contrário: neutro (sem fundo). Valores numéricos inalterados.

## Ordem por ranking geral

- Query nova em `app/comparativo/page.tsx`:
  ```ts
  supabase.from('user_rankings_full').select('user_id, position').order('position')
  ```
- `MatchComparison` recebe `rankPositions: Record<string, number>` e ordena
  `audits` com `posOf(user_id) = rankPositions[user_id] ?? Infinity`.
- Usuários sem entrada no ranking (ex.: ainda não pontuaram) caem no fim
  da lista, sem quebrar.
- Nova coluna **#** mostra `#1`, `#2`, … (ou `—` se ainda sem posição).

## Comandos para testar

```bash
# 1) Aplicar os 2 arquivos do zip
# 2) Limpar cache + dev
rm -rf .next
npm run dev

# 3) Abrir /comparativo
#    Cenário A — fase de grupos
#      ▸ aposta home > away: Time A azul + bold, placar azul sem bold.
#      ▸ aposta empate: placar cinza + bold, times neutros.
#      ▸ aposta away > home: Time B vermelho + bold, placar vermelho sem bold.
#    Cenário B — mata-mata, times do palpite = times reais
#      ▸ mesma regra (azul/vermelho/cinza) aplica.
#    Cenário C — mata-mata, times do palpite ≠ times reais
#      ▸ SEM destaque de vencedor. Status pode dizer "confronto em outra fase".
#    Cenário D — usuário pontuou
#      ▸ células Pts e Pts Zebra com fundo verde.
#    Cenário E — ordem
#      ▸ linha do #1 do ranking aparece primeiro, depois #2, etc.

# 4) Lint + build
npm run lint && npm run build
```

## Checklist de validação

### Destaque
- [ ] Vitória do mandante destaca **Time A** (azul + bold).
- [ ] Vitória do visitante destaca **Time B** (vermelho + bold).
- [ ] Placar em vitória **não** fica em negrito.
- [ ] Empate em grupos deixa placar **cinza + bold**, sem destacar times.
- [ ] Empate em grupos NÃO destaca mandante ou visitante como vencedor.

### Mata-mata
- [ ] KO com times do palpite = times reais (qualquer ordem) → destaque normal.
- [ ] KO com times do palpite ≠ times reais → SEM destaque.
- [ ] KO empatado + `advancer = home` (times batem) → Time A destacado.
- [ ] KO empatado + `advancer = away` (times batem) → Time B destacado.
- [ ] KO empatado + `advancer` mas times não batem → SEM destaque.
- [ ] Placar de empate em KO (com times batendo) → cinza+bold (ou cor do
      classificado, dependendo do fluxo `pickSide`).
- [ ] Mando invertido tratado corretamente (placar do palpite decide o lado).

### Pontos
- [ ] `points > 0` → célula **Pts** com fundo verde.
- [ ] `points_with_zebra > 0` → célula **Pts Zebra** com fundo verde.
- [ ] Sem pontos → células neutras.
- [ ] Valores numéricos não mudam.

### Ordem
- [ ] Linhas ordenadas por posição em `user_rankings_full`.
- [ ] `#1` aparece primeiro, `#2` depois, etc.
- [ ] Usuário sem ranking ainda aparece (no fim), sem quebrar layout.

### Sem regressão
- [ ] Pontuação intocada (`recalc.ts`, `scoring.ts`, `audit.ts`).
- [ ] Ranking geral intocado (`user_rankings_full` continua igual).
- [ ] `/apostas`, `/estatisticas`, `/admin/*` funcionam.
- [ ] Home, hero, PixCopyBox, TeamNameWithFlag, favicon intactos.
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Resumo

- **2 arquivos** alterados.
- **0 migrations**.
- **0 mudanças** em pontuação, audit, ranking, scoring, recalc, RLS, schema.
- 1 helper novo (`betTeamsMatchRealMatch`), 1 valor novo no `PickSide`
  (`'none'`), e 1 prop nova (`rankPositions`).
