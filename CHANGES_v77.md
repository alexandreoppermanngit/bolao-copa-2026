# Bolão Copa 2026 — Atualização v77

`/meus-resultados` ganha **status visual "eliminado"** e **potencial perdido**
em vermelho — sem mexer em pontuação, regra ou banco.

## O que muda na UX

Antes da v77, a tela de classificados só sabia 2 estados:

- ✅ Acertou (a seleção já está confirmada na fase apostada)
- ⏳ Pendente (ainda não dá pra dizer)

O problema: ⏳ era usado **para tudo que não tinha acertado**, incluindo casos
em que a seleção **já foi eliminada e não pode mais pontuar naquela fase**.
Exemplos:

| Cenário | Antes (v76) | Agora (v77) |
|---|---|---|
| Apostou 4º de grupo, grupo fechou com outro 4º | ⏳ Pendente | ❌ Não vai pontuar |
| Apostou 3º (grupo); fase de grupos terminou e seu 3º não passou | ⏳ Pendente | ❌ Não vai pontuar |
| Apostou Brasil ir até Quartas; Brasil caiu na R16 | ⏳ Pendente | ❌ Não vai pontuar |
| Apostou Brasil Campeão; Brasil caiu nas SF | ⏳ Pendente | ❌ Não vai pontuar |
| Apostou Brasil 3º lugar; Brasil caiu na R16 | ⏳ Pendente | ❌ Não vai pontuar |
| Apostou 3º (grupo); fase ainda não terminou | ⏳ Pendente | ⏳ Pendente |
| Apostou um time vivo nas oitavas | ⏳ Pendente | ⏳ Pendente |

## Diagnóstico

| # | Resposta |
|---|---|
| 1 | "Eliminado" precisa de uma fonte autoritativa para cada fase. |
| 2 | Não tem coluna "eliminated" no banco. E não vamos criar. |
| 3 | A informação **já existe** implicitamente: standings reais (gate v72 + h2h v75) para grupos; derrotas em `matches` decididos para KO. |
| 4 | Solução: helper puro `evaluateTeamPhaseStatus(teamId, phase, matches, teams)` em `lib/bolao/qualification.ts`. |
| 5 | Reusa `extractAdvancingTeams(matches, undefined, { gateGroupStage: true, teams })` — fonte única dos classificados reais. |
| 6 | Para group_stage: standings reais (h2h v75) + posição. 4º = eliminated. 3º com fase incompleta = pending. 3º com fase completa fora top-8 = eliminated. |
| 7 | Para KO: percorre matches reais decididos; se o time perdeu em qualquer fase ≤ a apostada (com nuance para 3º lugar), é eliminated. |
| 8 | Caso especial **champion**: qualquer derrota = eliminated. |
| 9 | Caso especial **runner_up**: derrota antes da final = eliminated; perder a final não conta. |
| 10 | Caso especial **third_place**: perder SF é OK (vai pro jogo de 3º). Perder R32/R16/QF/3º elimina. |
| 11 | A view dos potenciais agrupa por seleção: somar potencial **vivo**, **conquistado** e **perdido** separadamente. |
| 12 | Cor da headline reflete estado dominante: tudo eliminado → vermelho; senão âmbar (padrão). |
| 13 | Chips por fase: verde / cinza / vermelho. Tooltip mostra pts em jogo. |
| 14 | **Sem migration**. Sem alterar pontuação. Sem alterar recálculo. Sem alterar UQS. |

## Como o helper decide

```ts
evaluateTeamPhaseStatus(teamId, phase, matches, teams): 'reached' | 'pending' | 'eliminated'
```

1. **Chama** `extractAdvancingTeams(matches, undefined, { gateGroupStage: true, teams })`
   — mesma fonte que o gate v72 + h2h v75 usa para definir quem "realmente" passou.
2. Se a seleção está em `real[phase]` → **`reached`** (já confirmou).
3. Senão:
   - **group_stage**: olha standings reais do grupo. Se grupo não fechou → `pending`.
     Se 4º → `eliminated`. Se 3º:
     - Fase toda completa + ranking dos 3ºs já calculado → `pending`/`eliminated` conforme top-8.
     - Senão (fase incompleta) → `pending`.
   - **round_of_32 / round_of_16 / quarter_finals / semi_finals**: percorre matches da
     fase apostada e anteriores. Se o time perdeu em qualquer match decidido → `eliminated`.
     Senão → `pending`.
   - **champion**: se o time perdeu em qualquer match decidido → `eliminated`. Senão `pending`.
   - **runner_up**: se perdeu antes da final → `eliminated`. Final perdida (vice) é tratada
     pelo gate normal. Senão `pending`.
   - **third_place**: se perdeu R32/R16/QF → `eliminated`. Se perdeu a final do 3º lugar →
     `eliminated`. Perder SF é OK (vai pro 3º). Senão `pending`.

**Zero duplicação de regra**: o helper só *interpreta* o estado do bracket;
quem decide pontos continua sendo `scoring.ts` + `recalc.ts`.

## Mudanças visuais em `/meus-resultados`

### Tabela "Classificados apostados"

| Coluna | Antes | Agora |
|---|---|---|
| Linha 4ª (grupo fechado) | branco, ⏳ | **fundo vermelho leve**, ❌ |
| Linha 3ª eliminado | branco, ⏳ | **fundo vermelho leve**, ❌ |
| Linha time eliminado em KO | branco, ⏳ | **fundo vermelho leve**, ❌ |
| Pts Finais (eliminado) | "—" | **"−X.XX"** em vermelho, com tooltip "Potencial perdido: X.X pts" |
| Legenda | "✅ ⏳" | "✅ ⏳ ❌" |

### Card "Seleções com maior potencial de pontos"

Cada card tem agora **4 métricas** (era 3):

| Métrica | Cor | Significado |
|---|---|---|
| Mult. acum. | cinza | soma de multiplicadores (intocada) |
| Já conquistado | verde | pontos efetivos da seleção |
| **Potencial vivo** | âmbar | fases que ainda podem render |
| **Potencial perdido** | vermelho | fases já perdidas pra essa seleção |

Headline number passa a ser **Potencial vivo** (em vez de "Potencial" global).
Se a seleção tem todas as fases apostadas eliminadas, o card fica **vermelho
discreto** e a headline mostra "Eliminada — —".

**Chips por fase**:

- `reached` → verde (igual antes, com tooltip dos pts).
- `pending` → cinza (antes era "earned ? verde : cinza").
- `eliminated` → **vermelho com tachado** + tooltip "Potencial perdido: X.X pts".

### Ordenação dos cards

Antes: `sumPotential` desc → nº fases apostadas desc → nome.
Agora: `(sumPotentialAlive + sumEarned)` desc → nº fases não-eliminadas desc → nome.

Faz com que seleções "vivas" subam e eliminadas afundem naturalmente.

## Arquivos alterados (2) · 0 migrations

| Arquivo | Mudança |
|---|---|
| `lib/bolao/qualification.ts` | + tipo `TeamPhaseStatus`<br>+ função `evaluateTeamPhaseStatus(teamId, phase, matches, teams)`<br>+ helper privado `evaluateKOPhaseStatus(teamId, phase, matches)` |
| `components/MyResultsView.tsx` | • Import dos novos helpers<br>• `classificationStatus()` reescrito — devolve `{ icon, label, status }`<br>• Linhas eliminadas pintadas `bg-red-50/60` na tabela<br>• "Pts Finais" mostra `−X.XX` em vermelho com tooltip de potencial perdido<br>• Legenda ganha "❌"<br>• `potentialBySelection` calcula 3 somas (alive/lost/earned) + status por fase<br>• Ordenação ajustada<br>• `PotentialCard` reescrito: 4 métricas, headline contextual, chips coloridos por status |

## O que **não** muda

- ✅ `user_qualification_scores` (não tocado)
- ✅ `points_final` / `is_correct` (não tocados)
- ✅ Regra de pontuação (`scoring.ts`, `recalc.ts`)
- ✅ Regra de desempate (gate v72, h2h v75)
- ✅ Bracket oficial e overrides
- ✅ Snapshots de apostas
- ✅ Banco / migrations / RLS / views
- ✅ Ranking (`/ranking`)
- ✅ Admin / apostas / comparativo / estatísticas

## Como aplicar e testar

```bash
# 1) Substituir os 2 arquivos do zip
# 2) Build
rm -rf .next && npm run lint && npm run build && npm run dev

# 3) Smoke /meus-resultados
#    a) Abrir como user com apostas variadas
#    b) Procurar linha com 4º de grupo fechado → deve ter ❌ e fundo vermelho
#    c) Procurar linha de time eliminado em KO → ❌ + fundo vermelho
#    d) Card de seleção 100% eliminada → header vermelho, headline "Eliminada"
#    e) Card de seleção viva → header âmbar, métrica "Potencial vivo" como headline
#    f) Chips de fase vermelhos têm tachado e tooltip de potencial perdido

# 4) Smoke regressão
#    a) /ranking inalterado
#    b) /comparativo inalterado
#    c) /admin/configuracao → "Recalcular tudo" → mesmos pontos de antes
```

## Cenários

### Cenário 1 — 4º colocado de grupo fechado
- Grupo A: 6 jogos rodados, classificação final definida.
- User apostou Time X como 4º.
- Time X terminou 3º (vivo) ou 1º/2º (acertou outro slot).
- **Antes**: ⏳ Pendente. **Agora**: ❌ Não vai pontuar.

### Cenário 2 — 3º colocado, fase incompleta
- User apostou Time Y como 3º.
- Fase de grupos rolando mas nem todos os grupos fecharam.
- Y terminou seu grupo em 3º com pts/saldo razoáveis.
- **Antes**: ⏳. **Agora**: ⏳ (correto — não dá pra saber se ele entra nos top-8).

### Cenário 3 — 3º eliminado após fase completa
- Todos os 12 grupos fecharam.
- User apostou Time Z como 3º.
- Z terminou 3º mas ficou em 9º+ na lista dos melhores 3ºs.
- **Antes**: ⏳. **Agora**: ❌.

### Cenário 4 — Brasil campeão, eliminado nas SF
- User apostou Brasil Campeão.
- Brasil perdeu a SF.
- **Antes**: ⏳. **Agora**: ❌ (champion: qualquer derrota = eliminated).

### Cenário 5 — Vice eliminado antes da final
- User apostou Argentina Vice.
- Argentina perdeu na R16.
- **Antes**: ⏳. **Agora**: ❌ (runner_up: derrota antes da final = eliminated).

### Cenário 6 — Vice perdeu a final (= vice de verdade)
- User apostou França Vice.
- França chegou na final e perdeu.
- **Agora**: ✅ Acertou (extractAdvancingTeams já marca como runner_up).

### Cenário 7 — Card todo eliminado
- User apostou Inglaterra em R16, QF, SF, Campeão.
- Inglaterra perdeu na R16.
- Card da Inglaterra: header vermelho, headline "Eliminada", chips R16=cinza
  (já passou — eliminada na fase apostada → vermelho), QF/SF/Campeão = vermelho com tachado.
- Ordenação: card vai pro final da lista.

### Cenário 8 — Card parcialmente eliminado
- User apostou Brasil em R16 (acertou), QF (acertou), SF (perdeu), Campeão.
- Card: header âmbar (não está 100% eliminado).
- Chips: R16 verde, QF verde, SF vermelho tachado, Campeão vermelho tachado.
- Métricas: Já conquistado = R16+QF, Potencial vivo = 0, Potencial perdido = SF+Campeão.

## Checklist

### Helper novo
- [ ] `evaluateTeamPhaseStatus` exportado de `qualification.ts`.
- [ ] Tipo `TeamPhaseStatus` exportado.
- [ ] Não chama nada que mexa em banco.
- [ ] Reusa `extractAdvancingTeams` (sem duplicar regra).

### Tabela classificados
- [ ] Linha de seleção eliminada: fundo `bg-red-50/60`.
- [ ] Coluna "Status": ❌ Não vai pontuar.
- [ ] Coluna "Pts Finais": `−X.XX` em vermelho com tooltip.
- [ ] Linha de seleção viva pendente: ⏳ como antes.
- [ ] Linha de seleção acertada: ✅ como antes.
- [ ] Legenda inclui ❌.

### Card potencial
- [ ] Card de seleção 100% eliminada: header vermelho.
- [ ] Card de seleção viva: header âmbar (ou dourado se rank 1).
- [ ] 4 métricas: Mult, Já conquistado, Potencial vivo, Potencial perdido.
- [ ] Chips coloridos por status (verde/cinza/vermelho).
- [ ] Tooltip de chip vermelho mostra "Potencial perdido: X.X pts".
- [ ] Ordenação: (vivo + conquistado) desc.

### Sem regressão
- [ ] `/ranking` inalterado.
- [ ] `/comparativo` inalterado.
- [ ] `/estatisticas` inalterado.
- [ ] `/apostas` inalterado.
- [ ] Recalc no admin produz os mesmos pontos.
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Resumo

- **2 arquivos modificados**, **0 novos**, **0 migrations**.
- 1 helper novo em `qualification.ts` (`evaluateTeamPhaseStatus`).
- Ajuste cirúrgico em `MyResultsView.tsx` (tabela + card).
- Zero duplicação de regra; tudo deriva de fontes existentes.
- Pontuação real, recálculo, ranking e banco **intocados**.
