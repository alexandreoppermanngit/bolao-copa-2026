# Bolão Copa 2026 — Atualização v57

Corrigir o resumo Campeão/Vice/Terceiro no topo da página `/apostas`, que
ficava preso a valores antigos enquanto o resumo do fim da página atualizava
corretamente.

## Diagnóstico

### 1. Componente que renderiza o resumo no TOPO
`components/MyPointsSummary.tsx` — **Server Component**. Linhas 62–71 (antes do
fix), via `<Pick>`. Lê `user_qualification_scores` no Supabase.

### 2. Componente que renderiza o resumo no FINAL
`components/BetSummary.tsx` — Client Component, renderizado dentro de `BetForm`.
Linhas 384–397 do BetForm (antes do fix), via IIFE inline.

### 3. Dados de cada um
- **Topo**: `user_qualification_scores` — tabela persistida, populada apenas
  por `recalcAllQualificationScores()` (`lib/bolao/recalc.ts`), acionado
  pelo admin. Não muda quando o usuário salva uma aposta.
- **Final**: `resolvedMatches = simulateBracket(...)` derivado em tempo real
  do `useState` `bets` do BetForm. Atualiza imediato a cada digitação.

### 4. Duas fontes de verdade? SIM
Exatamente isso. O Pick do topo mostrava a previsão *salva no último
recálculo do admin*, o resumo do final mostrava a previsão *do palpite
atual do usuário*. `router.refresh()` re-renderizava o server component, mas
a tabela `user_qualification_scores` continuava no estado pré-recalc → topo
parecia "preso".

### 5. Origem do bug
Não é `useMemo` com deps incompletas, não é cache server-side (a página tem
`force-dynamic + revalidate=0 + fetchCache='force-no-store'`). É **fonte
divergente** entre topo (DB persistido) e final (estado local do form).

### 6. Arquivos alterados
- `components/MyPointsSummary.tsx`
- `components/BetForm.tsx`

### 7. Migration SQL
**Nenhuma.** Apenas TypeScript/React.

## Causa do bug (resumo)

O Pick "🥇 Campeão / 🥈 Vice / 🥉 3º Lugar" no topo era um Server Component
que lia `user_qualification_scores`. Essa tabela é populada exclusivamente
pelo recálculo do admin — não pelas mudanças locais do form. Quando o usuário
mudava a árvore, o `router.refresh()` recarregava o server component, mas a
tabela continuava igual → o topo ficava preso enquanto o resumo do final
(derivado do estado local do form) atualizava.

## Como o resumo passou a ser atualizado

1. No `BetForm` foi extraído um único `useMemo` chamado **`summaryTeams`**,
   derivado de `resolvedMatches` e `koHints`:
   ```ts
   const summaryTeams = useMemo(() => {
     const finalMatch = resolvedMatches.find(m => m.phase === 'final');
     const thirdMatch = resolvedMatches.find(m => m.phase === 'third_place');
     const winId   = finalMatch ? determineMatchWinnerId(finalMatch, koHints.get(finalMatch.id)) : null;
     const loseId  = finalMatch ? determineMatchLoserId(finalMatch,  koHints.get(finalMatch.id)) : null;
     const thirdId = thirdMatch ? determineMatchWinnerId(thirdMatch, koHints.get(thirdMatch.id)) : null;
     return {
       champion: winId   ? teamById.get(winId)   ?? null : null,
       vice:     loseId  ? teamById.get(loseId)  ?? null : null,
       third:    thirdId ? teamById.get(thirdId) ?? null : null,
     };
   }, [resolvedMatches, koHints, teamById]);
   ```

2. O `<BetSummary>` agora é renderizado **duas vezes** dentro do `BetForm`:
   - No **topo** (logo após o aviso de lock), consumindo `summaryTeams`;
   - No **final** (como já era antes), consumindo o mesmo `summaryTeams`.

   Como vêm da MESMA referência, topo e final sempre coincidem.

3. No `MyPointsSummary` o bloco de 3 cards Campeão/Vice/3º foi **removido**.
   Ficaram apenas os Stats agregados (Pontos por jogos, Pontos por
   classificação, Total + posição) — que dependem genuinamente do recalc do
   admin. O detalhamento `<details>` por fase ganhou uma nota explicando que
   é o estado do último recálculo.

## Comportamento esperado (validado)

- Mudar placar da **final** → Campeão/Vice atualizam no topo imediatamente.
- Mudar placar da **disputa de 3º** → 3º atualiza no topo imediatamente.
- Limpar placar ou criar empate sem `knockout_advancer` → topo volta para
  "A definir".
- Apostas bloqueadas (lock) → inputs desabilitados, resumo continua refletindo
  os dados salvos sem buscar valores antigos.

## Comandos para testar

```bash
# 1) Aplicar arquivos
# 2) Limpar cache + dev
rm -rf .next
npm run dev

# 3) Lint + build
npm run lint
npm run build
```

### Cenários

**Cenário 1 — Atualização em tempo real**
1. Logar com um usuário com palpites parciais.
2. Abrir `/apostas` → ver Campeão/Vice/3º no topo (igual ao do fim).
3. Mudar placar da final → ambos atualizam juntos.
4. Mudar 3º → ambos atualizam juntos.

**Cenário 2 — Empate KO**
1. Colocar 2x2 na final, escolher `knockout_advancer` = home.
2. Topo e final mostram Home como campeão e Away como vice.
3. Trocar `knockout_advancer` para away → topo e final invertem juntos.

**Cenário 3 — Limpar campos**
1. Apagar placar da final → Campeão e Vice voltam para "A definir" no topo
   e no final.

**Cenário 4 — Apostas bloqueadas**
1. Admin marca `bets_locked = true`.
2. Recarregar `/apostas` → resumo continua visível, inputs desabilitados,
   campeão/vice/3º refletem o palpite salvo (não vazio).

## Checklist de validação

- [ ] Resumo do topo mostra Campeão atualizado em tempo real.
- [ ] Resumo do topo mostra Vice atualizado em tempo real.
- [ ] Resumo do topo mostra 3º atualizado em tempo real.
- [ ] Topo e final exibem **os mesmos valores** em todos os cenários.
- [ ] Mudar placar da final → Campeão/Vice atualizam imediato.
- [ ] Mudar placar da disputa de 3º → 3º atualiza imediato.
- [ ] Limpar placar de fases anteriores → fases dependentes voltam para
      "A definir" automaticamente (cascata via `simulateBracket`).
- [ ] Não aparece valor antigo / cacheado.
- [ ] Apostas continuam sendo salvas no banco (`/api/bets/save`).
- [ ] `MyPointsSummary` continua mostrando Pontos por jogos / Pontos por
      classificação / Total + posição.
- [ ] Bloqueio de apostas (lock) continua funcionando.
- [ ] `/comparativo` não regrediu.
- [ ] `/estatisticas` não regrediu (mudanças do v56 preservadas).
- [ ] `app/page.tsx`, `app/globals.css`, `components/PixCopyBox.tsx`,
      `components/TeamNameWithFlag.tsx` **não alterados**.
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Resumo

- **2 arquivos** alterados (`components/BetForm.tsx`,
  `components/MyPointsSummary.tsx`).
- **0 migrations** novas.
- **0 mudanças** em scoring, recalc, admin, RLS, schema, página `/comparativo`
  ou `/estatisticas`.
- Topo e final passam a derivar Campeão/Vice/3º de uma **única** `useMemo`,
  recalculada a cada keystroke — sem dependência de
  `user_qualification_scores`/recalc do admin.
