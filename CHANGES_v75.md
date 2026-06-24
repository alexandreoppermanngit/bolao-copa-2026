# Bolão Copa 2026 — Atualização v75

Dois ajustes:

1. **Warning de lint** em `BetForm.tsx` (`useCallback` sem `teamForMatchSide` nas deps).
2. **Confronto direto** na classificação REAL/oficial dos grupos —
   simulações dos usuários **preservadas** com a regra antiga.

Sem migration. Sem alterar apostas/snapshots.

## Diagnóstico

### Ajuste 1 — Warning
- `useCallback(saveBet)` chamava `teamForMatchSide` (function declarada
  inline no componente, depende de `teamById` + `resolvedMatches`).
- Solução cirúrgica: envolver `teamForMatchSide` em `useCallback([teamById, resolvedMatches])`
  e adicionar nas deps do `saveBet`. Identidade estável; comportamento
  do autosave/snapshots inalterado.

### Ajuste 2 — Confronto direto

| # | Resposta |
|---|---|
| 1 | Classificação calculada em `lib/bolao/standings.ts → computeGroupStandings(teams, matches)`. Ordem antiga: pontos → saldo → gols pró → nome. |
| 2 | Usuários da fn: `bracket.ts` (via `simulateBracket`), `qualification.ts` (extractAdvancingTeams gate v72 / extractUserPrediction), `recalc.ts` (recalcBracket, recalcKnockoutMatchupsForAllUsers, recalcAllQualificationScores). |
| 3 | Mesma fn em REAL **e** simulação por usuário. |
| 4 | Risco de mudar global: alteraria interpretação dos palpites (snapshots usaram a regra antiga). Inaceitável. |
| 5 | Separação: parâmetro opcional `opts.tieBreakerMode: 'simple' \| 'head_to_head'`. Default `'simple'`. Caminhos REAIS passam `'head_to_head'`. |
| 6 | Melhores 3ºs em `computeThirdPlaceRanking(standings)` — ordena 3ºs de grupos DIFERENTES (não jogaram entre si). Continua sem head-to-head — não se aplica. |
| 7 | `bracket_overrides` aplicados em `recalcBracket` **depois** de `populateKnockoutMatches`. **Override permanece prioritário** — não muda. |
| 8 | Garantido pelo fluxo atual; verificamos em recalc.ts:175–225. |
| 9 | 4 arquivos: `standings.ts`, `recalc.ts`, `qualification.ts`, `BetForm.tsx`. |
| 10 | **Sem migration**. |
| 11 | Testar com "Recalcular tudo" após aplicar — apostas/snapshots intocados. |

## Regra nova

**Modo `'simple'`** (default — preserva comportamento atual):
```
pontos → saldo → gols pró → nome (estabilidade)
```

**Modo `'head_to_head'`** (v75 — apenas para REAL):
```
1) pontos
2) confronto direto entre os empatados (mini-tabela: pts H2H → saldo H2H → gols pró H2H)
3) saldo geral
4) gols pró geral
5) nome (estabilidade)
```

Algoritmo para 2+ empates: particiona times por pontos; para cada partição
com ≥2 times, monta mini-tabela apenas com os jogos entre eles e ordena
por (pts → saldo → gols) dentro da mini-tabela; fallback para saldo geral
→ gols pró geral → nome.

## Onde aplica head-to-head

| Caminho | Modo | Razão |
|---|---|---|
| `recalc.ts → recalcBracket` | **head_to_head** | Bracket oficial — usa standings reais. |
| `qualification.ts → extractAdvancingTeams` com `gateGroupStage=true` | **head_to_head** | Caminho REAL do gate v72 — define quem realmente classificou. |
| `recalc.ts → recalcKnockoutMatchupsForAllUsers` | **simple** | Simulação POR USUÁRIO — preserva interpretação dos palpites. |
| `qualification.ts → extractUserPrediction` | **simple** | Árvore prevista do usuário — preserva. |
| `bracket.ts → simulateBracket` | (recebe standings já calculado) | Não muda — quem chama decide o modo. |

## Bracket overrides

Em `recalcBracket`, override é aplicado **depois** da resolução automática:

```ts
return sb.from('matches').update({
  home_team_id: homeOv !== undefined ? homeOv : u.home_team_id,
  away_team_id: awayOv !== undefined ? awayOv : u.away_team_id,
}).eq('id', u.match_id);
```

Continua prioritário — não mexemos nessa parte.

## Arquivos alterados (4) · 0 migrations

| Arquivo | Mudança |
|---|---|
| `lib/bolao/standings.ts` | Doc atualizado. `computeGroupStandings` recebe `opts?: { tieBreakerMode? }`. Nova fn local `sortStandingsWithHeadToHead`. Tipo exportado `TieBreakerMode`. |
| `lib/bolao/recalc.ts` | `recalcBracket` passa `{ tieBreakerMode: 'head_to_head' }` ao `computeGroupStandings`. As demais calls em recalc (simulações por usuário) **não passam** — usam default 'simple'. |
| `lib/bolao/qualification.ts` | `extractAdvancingTeams` com `gateGroupStage=true` passa `{ tieBreakerMode: 'head_to_head' }`. `extractUserPrediction` segue sem opts (simple). |
| `components/BetForm.tsx` | `teamForMatchSide` virou `useCallback([teamById, resolvedMatches])`; adicionada nas deps do `saveBet`. |

## Como aplicar e testar

```bash
# 1) Aplicar os 4 arquivos do zip
rm -rf .next && npm run lint && npm run build && deploy

# 2) IMPORTANTE — após aplicar, rodar:
/admin/configuracao → 🔄 Recalcular tudo
# Isso regenera o bracket real + UQS usando o novo desempate H2H.
# Apostas e snapshots NÃO mudam.
```

### Cenário 1 — Simulação do usuário não muda
- Logue como user com apostas; abra `/meus-resultados` ou `/comparativo`.
- Times apostados (snapshots) e simulações exibem **igual ao antes**.

### Cenário 2 — Empate em pontos, A bateu B
- 2 grupos com mesmos pontos: A 5 pts (venceu B), B 5 pts (perdeu pra A).
- B tem saldo melhor (+3 vs +1).
- ANTES da v75: B em 1º (saldo).
- AGORA: A em 1º (confronto direto vence). Bracket oficial reflete.

### Cenário 3 — Empate em pontos + empate H2H
- A e B empataram entre si.
- Fallback para saldo geral → gols pró geral.

### Cenário 4 — 3 empatados
- Mini-tabela com apenas jogos entre A, B, C.
- Se algum sair na frente, ele lidera. Restantes seguem o algoritmo.
- Empate persistente → fallback saldo geral.

### Cenário 5 — Override manual
- Admin força um time no slot via `/admin/bracket-overrides`.
- A nova regra calcula automaticamente, mas o override **vence** no UPDATE final.

### Cenário 6 — Gate da v72 + nova regra
- Grupo incompleto → não pontua (gate v72 intacto).
- Grupo completo → 1º/2º vêm da regra nova (head_to_head).
- Todos completos → melhores 3ºs entram (gate intacto).

## Checklist

- [ ] Warning em `BetForm.tsx` desaparece no `npm run lint`.
- [ ] `computeGroupStandings` default ainda `'simple'` (preserva simulações).
- [ ] `recalcBracket` usa `head_to_head` no real.
- [ ] `extractAdvancingTeams` com gate usa `head_to_head` no real.
- [ ] `extractUserPrediction` e simulação por usuário em recalc continuam `'simple'`.
- [ ] Empate em pontos entre 2 → confronto direto resolve.
- [ ] Empate no H2H → fallback saldo/gols/nome.
- [ ] 3+ empatados → mini-tabela H2H.
- [ ] Bracket overrides continuam prioritários.
- [ ] Gate da v72 inalterado.
- [ ] Apostas e snapshots **não** alterados.
- [ ] `npm run lint` passa sem o warning.
- [ ] `npm run build` passa.

## Resumo

- **4 arquivos modificados**, **0 novos**, **0 migrations**.
- 1 helper local novo em `standings.ts`: `sortStandingsWithHeadToHead`.
- Default `simple` (preserva); `head_to_head` opt-in para caminhos REAIS.
- Próximo passo após aplicar: "Recalcular tudo" no admin para regerar
  o bracket real + UQS com o novo desempate.
