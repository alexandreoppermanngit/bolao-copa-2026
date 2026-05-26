# Bolão Copa 2026 — Atualização v60

Duas melhorias visuais simples, sem mexer em pontuação, banco ou API:

1. **Favicon** — bola de futebol na aba do navegador.
2. **Destaque no `/comparativo`** — cada linha da tabela mostra visualmente
   qual lado o usuário apostou (azul = mandante, vermelho = visitante,
   amarelo = empate, cinza = pendente).

## Diagnóstico

### Favicon
- `app/layout.tsx` tem `metadata` mas sem `icons`. Não existia `app/icon.svg`
  nem `app/favicon.ico`.
- Next.js 14 App Router detecta automaticamente `app/icon.svg` (ou `.png`,
  `.ico`) e injeta `<link rel="icon">` no `<head>` — sem precisar editar
  `layout.tsx` nem `metadata.icons`.

### Comparativo
| Pergunta | Resposta |
|---|---|
| Arquivo que renderiza | `components/MatchComparison.tsx`, especificamente o sub-componente `BetsAuditTable`. |
| Onde estão os placares apostados | `a.bet.home_score`, `a.bet.away_score` (já vinham do audit). |
| Campo `knockout_advancer` | `a.bet.knockout_advancer` (`'home' \| 'away' \| null`). |
| Como determinar o lado | Novo helper `pickSide(bet, isKO): 'home'\|'away'\|'draw'\|'pending'`. |
| Arquivos alterados | 1 novo (`app/icon.svg`) + 1 modificado (`components/MatchComparison.tsx`). |
| Migration SQL | **Nenhuma.** |

## Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `app/icon.svg` | **NOVO.** SVG de bola de futebol em viewBox 64×64. Detectado automaticamente pelo Next 14 → vira favicon. |
| `components/MatchComparison.tsx` | • Novo tipo `PickSide` e helper `pickSide(bet, isKO)`.<br>• Novo helper `classesForSide(side)` que devolve classes Tailwind para 3 células: Time A, Time B e Placar.<br>• Tabela `BetsAuditTable` aplica essas classes em cada linha. |

## Favicon

Arquivo `app/icon.svg` (SVG inline, sem dependências externas). Next.js
gera o `<link rel="icon">` automaticamente — não precisa importar nem
declarar em `metadata.icons`. Verificável após build: o HTML do `<head>`
terá `<link rel="icon" href="/icon.svg?<hash>" type="image/svg+xml"`.

## Regra do destaque visual

```ts
function pickSide(bet, isKO): 'home' | 'away' | 'draw' | 'pending' {
  if (bet.home_score > bet.away_score) return 'home';
  if (bet.away_score > bet.home_score) return 'away';
  // Empate
  if (!isKO) return 'draw';
  if (bet.knockout_advancer === 'home') return 'home';
  if (bet.knockout_advancer === 'away') return 'away';
  return 'pending';
}
```

Aplicação visual nas 3 células da linha:

| Lado | Time A (col esquerda) | Placar (col central) | Time B (col direita) |
|---|---|---|---|
| `'home'`    | `bg-blue-100` + borda esquerda azul + bold | `bg-blue-50` + bold | `opacity-60` (apagado) |
| `'away'`    | `opacity-60` | `bg-red-50` + bold | `bg-red-100` + borda direita vermelha + bold |
| `'draw'`    | levemente apagado | `bg-amber-100` + borda + bold | levemente apagado |
| `'pending'` | apagado | `bg-gray-100 italic text-gray-600` | apagado |

Vantagem do design: o destaque sai do PLACAR (sempre presente) + cor do
lado vencedor (mandante azul / visitante vermelho), e a coluna oposta fica
"empurrada para o fundo" via `opacity-60`. Mantém a tabela legível com
muitos usuários e funciona em mobile (classes responsivas inalteradas —
tabela continua com `overflow-x-auto`).

## Cuidado preservado

- Nenhuma alteração em pontuação (`a.points`, `a.points_with_zebra`).
- Nenhuma alteração no audit (`a.reason`, `AUDIT_REASON_LABEL`).
- Nenhuma alteração em `app/page.tsx` (home), header, hero, PixCopyBox,
  TeamNameWithFlag.
- Nenhuma alteração em API, RLS, migrations.

## Comandos para testar

```bash
# 1) Aplicar os 2 arquivos do zip (app/icon.svg + components/MatchComparison.tsx)
# 2) Limpar cache e rodar dev
rm -rf .next
npm run dev

# 3) Conferir o favicon
#    - Abrir http://localhost:3000 → aba do navegador mostra a bolinha.
#    - Em produção (Vercel), o SVG vai servido em /icon.svg
#    - Se a aba ainda mostrar o ícone antigo, fazer hard-reload (Ctrl+Shift+R).

# 4) Conferir o comparativo
#    - Logar e abrir /comparativo
#    - Selecionar um jogo de FASE DE GRUPOS:
#        ▸ aposta home > away → coluna esquerda em azul, placar azul.
#        ▸ aposta away > home → coluna direita em vermelho, placar vermelho.
#        ▸ aposta empate → placar em amarelo (Time A e B suavizados).
#    - Selecionar um jogo de MATA-MATA com empates + knockout_advancer:
#        ▸ advancer = home → destaque azul.
#        ▸ advancer = away → destaque vermelho.
#        ▸ sem advancer → placar cinza italic ("pendente").

# 5) Lint + build
npm run lint && npm run build
```

## Checklist de validação

### Favicon
- [ ] Aba do navegador mostra a bola.
- [ ] Funciona em dev (`npm run dev`).
- [ ] Funciona após `npm run build` + `npm start`.
- [ ] Funciona em produção (Vercel) — SVG é servido em `/icon.svg`.
- [ ] Não quebra o layout nem o `app/layout.tsx`.

### Comparativo — destaque
- [ ] Vitória do mandante destacada em **azul** (Time A + Placar).
- [ ] Vitória do visitante destacada em **vermelho** (Time B + Placar).
- [ ] Empate em fase de grupos destacado em **amarelo** (Placar).
- [ ] KO empatado com `knockout_advancer = 'home'` → destaque **azul**.
- [ ] KO empatado com `knockout_advancer = 'away'` → destaque **vermelho**.
- [ ] KO empatado SEM `knockout_advancer` → placar em **cinza italic**
      ("pendente"), sem azul nem vermelho.
- [ ] Tabela continua legível no desktop e no mobile (`overflow-x-auto`
      preserva scroll horizontal).

### Sem regressão
- [ ] Pontos do usuário continuam iguais (`a.points`, `a.points_with_zebra`).
- [ ] Coluna "Status" continua usando `AUDIT_REASON_LABEL` (intocada).
- [ ] `/apostas` não afetado.
- [ ] `/estatisticas` não afetado.
- [ ] Home, hero, PixCopyBox, TeamNameWithFlag **não alterados**.
- [ ] `npm run lint` passa.
- [ ] `npm run build` passa.

## Resumo

- **1 arquivo novo** (`app/icon.svg`) + **1 modificado** (`MatchComparison.tsx`).
- **0 migrations**.
- **0 mudanças** em pontuação, audit, ranking, scoring, recalc, RLS, schema.
- 2 helpers novos no `MatchComparison.tsx`: `pickSide(bet, isKO)` e
  `classesForSide(side)` — isolados ao próprio componente.
