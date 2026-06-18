# Bolão Copa 2026 — Atualização v73

Nova seção em `/meus-resultados`: **"Seleções com maior potencial de pontos"**.
Agregação visual por seleção apostada, sem alterar banco, regra de pontuação,
recálculo ou ranking.

## Diagnóstico

| # | Resposta |
|---|---|
| 1 | `userQuals` chega via `app/meus-resultados/page.tsx` → `fetchAll('user_qualification_scores').eq('user_id', targetUserId)` e é passado como prop ao `MyResultsView`. |
| 2 | Dados suficientes: `userQuals` (phase, team_id, factor, points_base, points_final, is_correct), `teams` (id, name, group_code, flag_url), `settings` (já recebido na v71). |
| 3 | Multiplicador acumulado: `Σ (1 + q.factor)` agrupado por `team_id`. |
| 4 | Pontos potenciais: `Σ phasePointsBase(phase, settings) × (1 + q.factor)`. |
| 5 | **Fases pendentes (gate v72)**: uso `phasePointsBase(settings)` em vez de `q.points_base` — porque `q.points_base` está zerado pelo gate enquanto pendente, mas o potencial precisa mostrar o que **viria** quando a fase liberar. |
| 6 | `settings` e `phasePointsBase` já estão disponíveis (settings veio na v71, phasePointsBase em qualification.ts). |
| 7 | Arquivos: 1 — `components/MyResultsView.tsx`. |
| 8 | **Sem migration**. |
| 9 | Ranking/recálculo intactos — agregação puramente client-side. |

## O que aparece

Cada seleção apostada vira um card ordenado por **potencial desc**:

```
#1  🇧🇷 Brasil                                  Potencial: 152.4 pts
    Multiplicador acum.: 8.35×   Já conquistado: 12.5 pts   Fases apostadas: 6
    [Grupos · 1.12×] [16-avos · 1.18×] [Oitavas · 1.25×]
    [Quartas · 1.40×] [Vice · 1.60×] [Campeão · 1.80×]
```

- **#1** ganha destaque sutil com borda dourada (accent-gold).
- Chips de fase apostada: verde se já pontuou, cinza se ainda potencial.
- Tooltip no chip explica "Já pontuou X pts · multiplicador Y×".

## Cálculo (puramente agregação visual)

```ts
// Para cada team apostado:
//   sumMultiplier = Σ (1 + factor)                              ← raridade acumulada
//   sumPotential  = Σ phasePointsBase(phase, settings)·(1+factor)  ← potencial em pts
//   sumEarned     = Σ q.points_final                            ← já contou no ranking
//   phases        = [{ phase, multiplier, potential, earned }]  ← chips
//
// Ordena: potential DESC → nº fases DESC → nome ASC.
```

**Importante** — o `phasePointsBase(settings)` é a fonte do potencial, não
`q.points_base`. Por quê:
- `q.points_base` respeita o gate v72: vale 0 enquanto a fase está pendente.
- Para o **potencial** (que é o ponto desta seção), precisamos mostrar
  "se a fase liberar, quanto vale". `phasePointsBase` dá o valor configurado.
- `sumEarned` (`q.points_final`) continua sendo o que efetivamente já contou.

## Ordenação

1. Potencial total **desc**.
2. Nº de fases apostadas **desc** (desempate).
3. Nome da seleção **asc** (pt-BR).

## Arquivos alterados (1) · 0 migrations

| Arquivo | Mudança |
|---|---|
| `components/MyResultsView.tsx` | • Import `phasePointsBase`.<br>• `useMemo` `potentialBySelection` agrega `userQuals` por `team_id` e ordena.<br>• Nova seção JSX após "Classificados apostados".<br>• Sub-componente `PotentialCard` (com chips de fase apostada, destaque para #1).<br>• Mapa `PHASE_SHORT` com labels curtos para os chips. |

`app/meus-resultados/page.tsx` **não muda** — `userQuals` e `settings` já
estavam sendo passados (v70/v71).

## Mobile

- Cards empilhados, sem tabela larga.
- Cabeçalho do card: rank + bandeira+nome à esquerda, "Potencial" + valor à direita.
- Mini-cards de stats em `grid-cols-2 sm:grid-cols-3`.
- Chips de fases quebram em múltiplas linhas via `flex-wrap`.
- `TeamNameWithFlag responsive` (acrônimos no mobile).

## Acesso

- Usuário comum: usa o próprio `userQuals` (server-side força `user.id`).
- Admin: dropdown troca usuário → `router.push('?user=X')` → componente
  remonta → potencial recalcula para o novo usuário.
- E-mails não aparecem.

## Como aplicar e testar

```bash
# 1) Aplicar o arquivo do zip
rm -rf .next && npm run lint && npm run build && deploy

# 2) Smoke test:
#    a) Logar como usuário comum com qualification_scores preenchidos.
#    b) /meus-resultados → rolar até o final.
#    c) Ver nova seção "🎯 Seleções com maior potencial de pontos".
#    d) Cards ordenados por potencial desc.
#    e) Conferir matemática: 1.12 + 1.18 + 1.25 = 3.55 (multiplicador acumulado).
#    f) Conferir "Já conquistado" = soma de q.points_final dos chips.
#
# 3) Admin trocando jogador:
#    a) Selecionar outro jogador → seção recalcula com os UQS dele.
#
# 4) Mobile (DevTools responsivo):
#    a) Cards empilham; chips quebram em múltiplas linhas; OK.
```

## Checklist

- [ ] Seção aparece em `/meus-resultados` (depois de "Classificados apostados").
- [ ] Usuário comum vê apenas suas seleções.
- [ ] Admin vê do usuário selecionado.
- [ ] Agrupamento por `team_id` correto.
- [ ] Multiplicador acumulado = `Σ (1 + factor)`.
- [ ] Pontos potenciais = `Σ phasePointsBase(settings) × (1 + factor)`.
- [ ] Pontos conquistados = `Σ q.points_final` (separado do potencial).
- [ ] Fases apostadas listadas em chips (cor verde se já pontuou, cinza se potencial).
- [ ] Ordenação: potencial desc → nº fases desc → nome asc.
- [ ] Seleções com fases pendentes (gate v72) ainda aparecem (potencial mostra).
- [ ] **Não** altera ranking.
- [ ] **Não** altera `user_qualification_scores`.
- [ ] **Não** altera recálculo/banco/apostas.
- [ ] Layout funciona no mobile.
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Resumo

- **1 arquivo modificado**, **0 novos arquivos**, **0 migrations**.
- Reusa `phasePointsBase` da v58 e `userQuals`+`settings` já carregados (v70/v71).
- Sem nova query no banco.
- Sem nova regra de pontuação — só agregação visual sobre dados existentes.
- Destacado o conceito de **potencial** ≠ ponto conquistado.
