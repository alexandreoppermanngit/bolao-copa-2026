# Bolão Copa 2026 — Atualização v67

Snapshots já estão completos no banco (v66). Esta versão conserta:

1. **`/comparativo` truncando bets em 1000** (mesmo bug da v65, mas dentro da página);
2. **`/estatisticas` truncando bets em 1000** (idem);
3. **BetForm não cascateava snapshots** — quando o usuário mudava placar de
   fase de grupos, os snapshots dos KO downstream ficavam com os times
   antigos no banco.

Sem migration. Sem repair. Sem alterar bets existentes.

## Diagnóstico

### 1. `/comparativo` não mostrava todas as apostas
`app/comparativo/page.tsx` fazia 2 `Promise.all` com `sb.from('bets').select('*')`
e `supabase.from('bets').select('*')` sem `range`. **Truncado em 1000** —
e com 1.556 bets, ~36% ficavam invisíveis na tela. Mesma raiz da v65/v66.

A leitura dos snapshots em `MatchComparison` / `BetsAuditTable` / `buildBetAudit`
já estava correta desde a v65 — só não tinha **dado** completo para ler.

### 2. `/estatisticas` não mostrava todas as seleções
`app/estatisticas/page.tsx` linhas 86 e 90: idem, `sb.from('bets').select('*')`
sem paginação. `extractUserPrediction` em `qualification.ts` (corrigido v65)
já lê snapshots prioritariamente, mas dependia de receber TODAS as bets.

### 3. Snapshot do banco não atualiza quando usuário mexe em grupos
`BetForm.tsx` → `saveBet` envia snapshot só do match alterado. Quando o
usuário mexe num placar de fase de grupos, o `resolvedMatches` recalcula
toda a árvore visual — mas o `saveBet` não conhece os KO downstream que
ficaram defasados.

Concreto: usuário aposta "Argentina 3×0 Paraguai" no grupo, isso muda quem
passa de 1º/2º, isso muda o cruzamento de R32, isso muda o snapshot do bet
de R32 do usuário — mas o `bets.bet_home_team_id` daquele R32 segue com o
time antigo.

### 4/5/6/7. Demais perguntas
- `/api/bets/save` (v65) persiste snapshots ✓
- `BetForm` envia snapshots no save individual ✓
- Apostas bloqueadas: continuam impedindo (lock global preserva a regra) ✓
- Sobrescrita acidental: o ref `knownSnapshotsRef` evita disparar sync para
  matches sem mudança ✓

### 8. Cache
`/comparativo` e `/estatisticas` já tinham `force-dynamic + revalidate=0 + fetchCache='force-no-store'`. Mantido.

## Arquivos alterados (3 novos + 3 modificados)

### Novos
| Arquivo | Mudança |
|---|---|
| `lib/supabase/fetchAll.ts` | Helper de paginação reutilizável. `fetchAll<T>(query => sb.from(...).select(...).range(from, to))` lê todas as páginas até esvaziar. Extrai a lógica que estava inline na v66. |
| `app/api/bets/sync-team-snapshots/route.ts` | POST batch. Usuário autenticado sincroniza snapshots dos PRÓPRIOS bets (até 200 por chamada). Não toca em scores/advancer/points. Respeita lock global. |

### Modificados
| Arquivo | Mudança |
|---|---|
| `app/comparativo/page.tsx` | `sb.from('bets').select('*')` e `supabase.from('bets').select('*')` agora usam `fetchAll`. Idem para `profiles` em ambos os ramos. |
| `app/estatisticas/page.tsx` | Idem para `bets`. |
| `components/BetForm.tsx` | • Novo `knownSnapshotsRef: Map<matchId, { home, away }>` inicializado de `existingBets`.<br>• Novo `cascadeTimerRef` para debounce 600ms.<br>• Nova função `scheduleCascadeSync()` que detecta KO downstream defasados e POSTs em batch.<br>• `saveBet` atualiza o ref + agenda cascade após cada save bem-sucedido. |

## Como funciona o cascade

```
[usuário muda Argentina 3×0 Paraguai no grupo]
   ↓
setBets() → resolvedMatches recalcula (useMemo)
   ↓
scheduleSave(match_grupo) → debounce 800ms → saveBet(match_grupo)
   ↓
saveBet salva grupo COM snapshot do próprio jogo (Argentina × Paraguai)
   ↓
on success:
   knownSnapshotsRef.set(match_grupo, snap)
   debounce 600ms → scheduleCascadeSync()
   ↓
scheduleCascadeSync compara cada KO em resolvedMatches com knownSnapshotsRef:
   - bet de R32 #74 = antes {home: Argentina, away: Equador}, agora {home: Argentina, away: Bolívia}
   - bet de R16 #87 = antes {home: France, away: Argentina}, agora {home: France, away: Brasil}
   - ...
   ↓
POST /api/bets/sync-team-snapshots { updates: [...] }
   ↓
Servidor UPDATE bets SET bet_home_team_id=..., bet_away_team_id=...
   WHERE user_id = auth.uid() AND match_id = X
   (NÃO toca em scores/advancer/points)
   ↓
knownSnapshotsRef atualizado com os novos valores
```

## Proteções

- `scheduleCascadeSync` só dispara se `isLocked === false`.
- Servidor refusa silenciosamente (200 + `skipped_locked`) se lock estiver ativo.
- Servidor só atualiza bets do `auth.uid()` (não há vetor cross-user).
- Cascade só inclui KO onde o usuário JÁ tem aposta (`existingBets`).
- Snapshots de grupos não são tocados pelo cascade (têm slots fixos).
- Debounce 600ms agrupa múltiplos saves consecutivos em 1 chamada.
- Race com saves diretos: o save individual sempre vence (cascade é
  reativo, não preventivo).

## Comandos para testar

```bash
# 1) Aplicar os 6 arquivos do zip
rm -rf .next
npm run dev

# 2) Smoke local
#    a) Logar como user
#    b) Abrir DevTools → Network filter "sync-team-snapshots"
#    c) Mudar um placar de grupo (ex: Argentina 3×0) → ver:
#       - POST /api/bets/save (do match de grupo)
#       - POST /api/bets/sync-team-snapshots (~600ms depois) com lista de KO
#    d) Recarregar a página → snapshots persistem; KO mostram novos times

# 3) Smoke /comparativo
#    a) Logar como admin (ou esperar lock)
#    b) Abrir /comparativo
#    c) Cards devem mostrar TODAS as apostas (verifique total).
#       Antes da v67: a página truncava em 1000 → faltavam ~556 bets.

# 4) Smoke /estatisticas
#    a) Idem — cards de cada fase devem agora ter contagens consistentes
#       com a query SQL de validação.

# 5) Query SQL de validação (a sua, que confirmou pendentes=0):
#    Comparar os números do banco com o que aparece na UI.

# 6) Lint + build
npm run lint && npm run build
```

## Comportamento esperado pós-v67

- **Apostas existentes**: continuam intactas. Snapshots gravados pela v66 +
  bets antigas ficam como estavam. Nenhum UPDATE em massa.
- **Nova aposta**: o BetForm já enviava snapshot (v65). Continua igual.
- **Alteração de aposta** (placar de grupo que muda KO): cascade sincroniza
  os snapshots dos KO afetados automaticamente, em batch, debounce 600ms.
- **Apostas bloqueadas**: cascade não dispara, servidor recusa.
- **Apostas não tocadas pelo usuário**: cascade não as inclui (filtra por
  `existingBets`).

## Checklist de validação

### /comparativo
- [ ] Mostra todas as apostas (a query SQL de validação bate com a UI).
- [ ] Times A e B aparecem para todos os jogos KO (via snapshots).
- [ ] Regra de visibilidade preservada (aberto = só própria; bloqueado/admin = todas).
- [ ] Email mascarado para não-admin.
- [ ] Sem corte por ranking ou limit 1000.

### /estatisticas
- [ ] Mostra todas as seleções apostadas por fase (consultando snapshots).
- [ ] Card Vice / Campeão / 3º preenchido conforme bets.
- [ ] Não corta por limit 1000.

### Salvamento
- [ ] Nova aposta salva: `bet_home_team_id` / `bet_away_team_id` no banco.
- [ ] Alteração de placar de grupo dispara `POST /api/bets/sync-team-snapshots`
      em ~600ms (visível no Network).
- [ ] Cascade NÃO dispara se a árvore não mudou.
- [ ] Cascade NÃO dispara se apostas bloqueadas.
- [ ] Cascade NÃO toca em scores/advancer/points (`bets.points` inalterado).
- [ ] Race com save direto: bet salvo individualmente sempre tem
      precedência (cascade é reativo).

### Geral
- [ ] Banco não foi alterado por scripts (só pelo cascade quando usuário mexe).
- [ ] Pontuação inalterada.
- [ ] Ranking inalterado.
- [ ] Migrations inalteradas.
- [ ] Home / hero / favicon / PixCopyBox / TeamNameWithFlag intactos.
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Resumo

- **3 arquivos novos** (`fetchAll.ts`, rota `sync-team-snapshots`, `CHANGES_v67.md`).
- **3 arquivos modificados** (`/comparativo`, `/estatisticas`, `BetForm.tsx`).
- **0 migrations**.
- **0 alterações em RLS, scoring, recalc, ranking, schema**.
- Erros TS aparentes em `BetForm.tsx` linhas 373/379/393/467 são
  pré-existentes (narrowing do `LocalBet` que TS 6.0 do sandbox detecta,
  TS 5.6.2 do projeto aceita).
