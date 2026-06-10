'use client';

import { useMemo, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type {
  Match, Team, Bet, Settings, AnnexCOption, GroupCode,
} from '@/types/database';
import { getGlobalLockStatus } from '@/lib/bolao/lockStatus';
import {
  computeGroupStandings,
  computeThirdPlaceRanking,
  sortedKeyOfQualifyingThirds,
  countPlayedGamesPerGroup,
  areAllGroupsMature,
  MIN_GAMES_PER_GROUP_FOR_BRACKET,
} from '@/lib/bolao/standings';
import {
  findAnnexCOption, simulateBracket,
  determineMatchWinnerId, determineMatchLoserId,
  type KoTiebreakHint,
} from '@/lib/bolao/bracket';
import { TeamNameWithFlag } from './TeamNameWithFlag';
import { BetSummary } from './BetSummary';

interface Props {
  userId: string;
  matches: Match[];
  teams: Team[];
  existingBets: Bet[];
  annexCOptions: AnnexCOption[];
  settings: Settings | null;
}

type LocalBet = {
  home: string;
  away: string;
  advancer?: 'home' | 'away' | null;
  saved: boolean;
  saving: boolean;
};

export function BetForm({ userId, matches, teams, existingBets, annexCOptions, settings }: Props) {
  const lock = getGlobalLockStatus(settings);
  const isLocked = lock.locked;

  const initial = useMemo(() => {
    const map = new Map<number, LocalBet>();
    for (const m of matches) {
      const b = existingBets.find(x => x.match_id === m.id);
      map.set(m.id, {
        home: b?.home_score?.toString() ?? '',
        away: b?.away_score?.toString() ?? '',
        advancer: b?.knockout_advancer ?? null,
        saved: !!b,
        saving: false,
      });
    }
    return map;
  }, [matches, existingBets]);

  const [bets, setBets] = useState<Map<number, LocalBet>>(initial);
  const [saveStatus, setSaveStatus] = useState<string>('');
  const router = useRouter();

  /**
   * Guard contra race condition: cada save recebe um seqId por match.
   * Se uma resposta mais antiga chegar depois de uma mais nova, é descartada.
   */
  const saveSeqRef = useRef<Map<number, number>>(new Map());

  /**
   * Debounce timers por matchId — para que digitar rápido em vários campos
   * não dispare múltiplos saves intermediários nem perca o último valor.
   */
  const debounceTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  /**
   * v67 — CASCADE de snapshots: mapa do último snapshot conhecido por match
   * (`bet_home_team_id` / `bet_away_team_id`) no banco.
   *
   * Por que: ao mudar um placar de fase de grupos, a árvore visual do usuário
   * muda imediatamente em `resolvedMatches`, MAS o salvamento individual de
   * `/api/bets/save` só persiste o match alterado. Os snapshots dos KO
   * downstream ficam com os times antigos no banco — o que é exatamente o
   * problema reportado: "comparativo não mostra todos os times".
   *
   * Solução: após cada `saveBet` bem-sucedido, comparar `resolvedMatches`
   * com este ref e disparar `POST /api/bets/sync-team-snapshots` em batch
   * para os KO downstream cujos snapshots ficaram defasados.
   */
  const knownSnapshotsRef = useRef<Map<number, { home: number | null; away: number | null }>>(
    new Map(existingBets.map(b => [
      b.match_id,
      { home: b.bet_home_team_id ?? null, away: b.bet_away_team_id ?? null },
    ])),
  );

  /**
   * Debounce do cascade — agrega vários saves consecutivos numa única chamada
   * de sync. Evita N requests quando o usuário muda rápido vários grupos.
   */
  const cascadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const teamById = useMemo(() => new Map(teams.map(t => [t.id, t])), [teams]);

  /** Matches da fase de GRUPOS com placar do palpite aplicado. */
  const simulatedGroupMatches: Match[] = useMemo(() => matches.map(m => {
    const lb = bets.get(m.id);
    if (lb && lb.home !== '' && lb.away !== '') {
      const hs = Number(lb.home);
      const as = Number(lb.away);
      if (!Number.isNaN(hs) && !Number.isNaN(as)) {
        return { ...m, home_score: hs, away_score: as };
      }
    }
    return m;
  }), [matches, bets]);

  const standings = useMemo(
    () => computeGroupStandings(teams, simulatedGroupMatches),
    [teams, simulatedGroupMatches]
  );
  const thirds = useMemo(() => computeThirdPlaceRanking(standings), [standings]);
  const qualifyingKey = useMemo(() => sortedKeyOfQualifyingThirds(thirds), [thirds]);
  const annexCOption = useMemo(
    () => qualifyingKey.length === 8 ? findAnnexCOption(qualifyingKey, annexCOptions) : null,
    [qualifyingKey, annexCOptions]
  );

  const groupsMature = useMemo(() => areAllGroupsMature(simulatedGroupMatches), [simulatedGroupMatches]);
  const gamesPerGroup = useMemo(() => countPlayedGamesPerGroup(simulatedGroupMatches), [simulatedGroupMatches]);

  /**
   * Hints de pênaltis (knockout_advancer) extraídos dos palpites do usuário,
   * para alimentar a propagação no mata-mata.
   */
  const koHints: Map<number, KoTiebreakHint> = useMemo(() => {
    const map = new Map<number, KoTiebreakHint>();
    for (const [matchId, lb] of bets) {
      if (lb.advancer) map.set(matchId, { knockout_advancer: lb.advancer });
    }
    return map;
  }, [bets]);

  /**
   * Bracket simulado: matches com home_team_id/away_team_id já resolvidos
   * com base nos palpites do usuário (fase de grupos + KO).
   */
  const resolvedMatches: Match[] = useMemo(() => {
    // Para o KO, precisamos APLICAR os palpites do usuário no array de matches
    // (não só fase de grupos) — para que determineMatchWinnerId enxergue os scores.
    const withBets = matches.map(m => {
      const lb = bets.get(m.id);
      if (lb && lb.home !== '' && lb.away !== '') {
        return { ...m, home_score: Number(lb.home), away_score: Number(lb.away) };
      }
      return m;
    });
    return simulateBracket(withBets, teams, standings, thirds, annexCOption, koHints);
  }, [matches, bets, teams, standings, thirds, annexCOption, koHints]);

  /**
   * FONTE ÚNICA do resumo (campeão / vice / 3º) — derivada do estado local
   * `bets` via `resolvedMatches`. Usada simultaneamente pelos `<BetSummary>`
   * do TOPO e do FINAL desta página. Atualiza a cada digitação, sem depender
   * de `router.refresh()` nem de recálculo no admin (`user_qualification_scores`
   * só é populada por `recalcAllQualificationScores`, então não serve aqui).
   */
  const summaryTeams = useMemo(() => {
    const finalMatch = resolvedMatches.find(m => m.phase === 'final');
    const thirdMatch = resolvedMatches.find(m => m.phase === 'third_place');
    const winId = finalMatch ? determineMatchWinnerId(finalMatch, koHints.get(finalMatch.id)) : null;
    const loseId = finalMatch ? determineMatchLoserId(finalMatch, koHints.get(finalMatch.id)) : null;
    const thirdId = thirdMatch ? determineMatchWinnerId(thirdMatch, koHints.get(thirdMatch.id)) : null;
    return {
      champion: winId ? teamById.get(winId) ?? null : null,
      vice:     loseId ? teamById.get(loseId) ?? null : null,
      third:    thirdId ? teamById.get(thirdId) ?? null : null,
    };
  }, [resolvedMatches, koHints, teamById]);

  function teamForMatchSide(m: Match, side: 'home' | 'away'): Team | null {
    // Para grupos, usa o team_id original (já populado no DB)
    // Para KO, usa resolvedMatches (cascateado)
    if (m.group_code) {
      const id = side === 'home' ? m.home_team_id : m.away_team_id;
      return id ? teamById.get(id) ?? null : null;
    }
    const res = resolvedMatches.find(r => r.id === m.id);
    if (!res) return null;
    const id = side === 'home' ? res.home_team_id : res.away_team_id;
    return id ? teamById.get(id) ?? null : null;
  }

  /**
   * v67 — CASCADE de snapshots downstream.
   *
   * Compara cada match KO desta árvore visual atual (`resolvedMatches`)
   * com o último snapshot conhecido no banco (`knownSnapshotsRef`). Se
   * mudou (ex.: o usuário ajustou um placar de grupo e os classificados
   * mudaram), enfileira um update.
   *
   * Só inclui matches em que o usuário JÁ tem aposta (existingBets) —
   * snapshots de jogos não apostados não entram na cascata.
   *
   * Faz POST batch para `/api/bets/sync-team-snapshots`, que NÃO toca em
   * placar/advancer/points. Se a sync chegar de volta com sucesso,
   * atualiza `knownSnapshotsRef` com os novos valores.
   */
  const scheduleCascadeSync = useCallback(async () => {
    if (isLocked) return;  // bloqueado: deixa quieto

    // Bets KO existentes que o usuário tem
    const userBetMatchIds = new Set(existingBets.map(b => b.match_id));

    type Update = { match_id: number; bet_home_team_id: number | null; bet_away_team_id: number | null };
    const updates: Update[] = [];

    for (const m of resolvedMatches) {
      if (m.group_code) continue;             // grupos têm slots fixos
      if (!userBetMatchIds.has(m.id)) continue; // só sincroniza apostas existentes
      const known = knownSnapshotsRef.current.get(m.id) ?? { home: null, away: null };
      const currentHome = m.home_team_id ?? null;
      const currentAway = m.away_team_id ?? null;
      if (known.home !== currentHome || known.away !== currentAway) {
        updates.push({
          match_id: m.id,
          bet_home_team_id: currentHome,
          bet_away_team_id: currentAway,
        });
      }
    }

    if (updates.length === 0) return;

    try {
      const res = await fetch('/api/bets/sync-team-snapshots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ updates }),
      });
      const j = await res.json().catch(() => null);
      if (res.ok && j?.success) {
        // Sucesso parcial é OK — atualizamos os snapshots para o que ENVIAMOS.
        // Race-safe: o BetForm é single-user, a chance de conflito é mínima,
        // e mesmo que algo divirja, o próximo save corrige.
        for (const u of updates) {
          knownSnapshotsRef.current.set(u.match_id, {
            home: u.bet_home_team_id,
            away: u.bet_away_team_id,
          });
        }
      }
    } catch {
      // Silencioso — o autosave normal continua tentando.
    }
  }, [isLocked, existingBets, resolvedMatches]);

  // ============================================================
  // SAVE — com race-guard por seqId e router.refresh() após sucesso
  // ============================================================
  const saveBet = useCallback(async (matchId: number, lb: LocalBet) => {
    if (isLocked) {
      setSaveStatus(`🔒 ${lock.message}`);
      return;
    }
    if (lb.home === '' || lb.away === '') return;
    const hs = Number(lb.home), as = Number(lb.away);
    if (!Number.isInteger(hs) || !Number.isInteger(as) || hs < 0 || as < 0) return;

    const m = matches.find(x => x.id === matchId);
    const isKO = m && !m.group_code;
    if (isKO && hs === as && !lb.advancer) {
      setSaveStatus('⚠️ Empate no mata-mata: defina quem avança nos pênaltis');
      return;
    }

    // Sequência incremental por match — usada para descartar respostas antigas
    const prevSeq = saveSeqRef.current.get(matchId) ?? 0;
    const mySeq = prevSeq + 1;
    saveSeqRef.current.set(matchId, mySeq);

    setSaveStatus('💾 Salvando…');
    setBets(prev => {
      const next = new Map(prev);
      const cur = next.get(matchId);
      if (cur) next.set(matchId, { ...cur, saving: true });
      return next;
    });

    // Migration 008 — snapshot dos times naquele slot. Para grupos
    // teamForMatchSide vai do team_id direto; para KO resolve via
    // resolvedMatches. Se ainda não resolvido (KO com palpites parciais
    // de grupo), envia null — o backfill cuida depois.
    const matchObj = matches.find(x => x.id === matchId) ?? null;
    const snapHome = matchObj ? teamForMatchSide(matchObj, 'home')?.id ?? null : null;
    const snapAway = matchObj ? teamForMatchSide(matchObj, 'away')?.id ?? null : null;

    let errorMsg: string | null = null;
    try {
      const res = await fetch('/api/bets/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          match_id: matchId,
          home_score: hs,
          away_score: as,
          knockout_advancer: isKO && hs === as ? (lb.advancer ?? null) : null,
          bet_home_team_id: snapHome,
          bet_away_team_id: snapAway,
        }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.success) errorMsg = j?.error ?? `HTTP ${res.status}`;
    } catch (e) {
      errorMsg = (e as Error).message;
    }

    // Se outro save mais novo já partiu para este match, descarta este resultado
    if (saveSeqRef.current.get(matchId) !== mySeq) return;

    setBets(prev => {
      const next = new Map(prev);
      const cur = next.get(matchId);
      if (cur) next.set(matchId, { ...cur, saving: false, saved: !errorMsg });
      return next;
    });

    if (errorMsg) {
      setSaveStatus(`❌ Erro: ${errorMsg}`);
    } else {
      setSaveStatus(`✓ Salvo às ${new Date().toLocaleTimeString('pt-BR')}`);

      // Atualiza o known-snapshot para o match que acabou de ser salvo —
      // o cascade abaixo vai comparar com este valor.
      knownSnapshotsRef.current.set(matchId, { home: snapHome, away: snapAway });

      // CASCADE — agenda sync dos snapshots downstream em background. O
      // debounce de 600ms agrupa múltiplos saves consecutivos (ex.: o
      // usuário ajustando vários jogos de grupo) num único POST.
      if (cascadeTimerRef.current) clearTimeout(cascadeTimerRef.current);
      cascadeTimerRef.current = setTimeout(() => {
        cascadeTimerRef.current = null;
        scheduleCascadeSync();
      }, 600);

      // Invalida Router Cache: /apostas, /comparativo, /ranking etc voltam
      // a buscar dados frescos no servidor na próxima navegação/foco.
      try { router.refresh(); } catch { /* ignore */ }
    }
    void userId;
  }, [userId, matches, isLocked, lock.message, router, scheduleCascadeSync]);

  function scheduleSave(matchId: number, lb: LocalBet, delay: number) {
    const timers = debounceTimersRef.current;
    const existing = timers.get(matchId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      timers.delete(matchId);
      saveBet(matchId, lb);
    }, delay);
    timers.set(matchId, t);
  }

  function updateScore(matchId: number, field: 'home' | 'away', value: string) {
    setBets(prev => {
      const next = new Map(prev);
      const cur = next.get(matchId) ?? { home: '', away: '', advancer: null, saved: false, saving: false };
      const updated = { ...cur, [field]: value };
      // Se não é mais empate, limpa advancer
      if (updated.home !== '' && updated.away !== '' && updated.home !== updated.away) {
        updated.advancer = null;
      }
      next.set(matchId, updated);
      // Debounce para salvar — sempre cancela timer anterior, garantindo
      // que o ÚLTIMO valor digitado é o que vai para o banco.
      if (updated.home !== '' && updated.away !== '') {
        scheduleSave(matchId, updated, 800);
      }
      return next;
    });
  }

  function updateAdvancer(matchId: number, advancer: 'home' | 'away') {
    setBets(prev => {
      const next = new Map(prev);
      const cur = next.get(matchId);
      if (!cur) return prev;
      const updated = { ...cur, advancer };
      next.set(matchId, updated);
      scheduleSave(matchId, updated, 200);
      return next;
    });
  }

  // ============================================================
  // RENDER
  // ============================================================
  const groupStageByGroup = useMemo(() => {
    const byGroup = new Map<GroupCode, Match[]>();
    matches
      .filter(m => m.group_code != null)
      .forEach(m => {
        const arr = byGroup.get(m.group_code as GroupCode) ?? [];
        arr.push(m);
        byGroup.set(m.group_code as GroupCode, arr);
      });
    for (const arr of byGroup.values()) arr.sort((a, b) => a.id - b.id);
    return byGroup;
  }, [matches]);

  const groupCodes: GroupCode[] = ['A','B','C','D','E','F','G','H','I','J','K','L'];
  const koMatches = matches.filter(m => m.group_code == null);
  const r32 = koMatches.filter(m => m.phase === 'round_of_32').sort((a, b) => a.id - b.id);
  const r16 = koMatches.filter(m => m.phase === 'round_of_16').sort((a, b) => a.id - b.id);
  const qf = koMatches.filter(m => m.phase === 'quarter_finals').sort((a, b) => a.id - b.id);
  const sf = koMatches.filter(m => m.phase === 'semi_finals').sort((a, b) => a.id - b.id);
  const tp = koMatches.find(m => m.phase === 'third_place');
  const fn = koMatches.find(m => m.phase === 'final');

  return (
    <div className="space-y-8">
      {isLocked && (
        <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-4 text-amber-900">
          <h2 className="font-bold flex items-center gap-2">🔒 Apostas encerradas</h2>
          <p className="text-sm mt-1">{lock.message}</p>
          <p className="text-xs mt-1 opacity-80">Os palpites já feitos continuam visíveis em modo de consulta.</p>
        </div>
      )}
      {saveStatus && (
        <div
          className={
            'fixed top-20 right-4 px-4 py-2 rounded shadow z-50 text-sm max-w-xs border ' +
            (saveStatus.startsWith('❌')
              ? 'bg-red-50 border-red-200 text-red-800'
              : saveStatus.startsWith('💾')
              ? 'bg-blue-50 border-blue-200 text-blue-800'
              : saveStatus.startsWith('⚠️') || saveStatus.startsWith('🔒')
              ? 'bg-amber-50 border-amber-200 text-amber-900'
              : 'bg-green-50 border-green-200 text-green-800')
          }
          role="status"
          aria-live="polite"
        >
          {saveStatus}
        </div>
      )}

      {/* ====== RESUMO DO TOPO ======
          Mesma fonte de verdade do resumo do final: `summaryTeams` (derivado
          de `resolvedMatches`, recalculado a cada mudança no estado local).
          Não depende de user_qualification_scores nem do recalc do admin. */}
      <BetSummary
        champion={summaryTeams.champion}
        vice={summaryTeams.vice}
        third={summaryTeams.third}
      />

      {/* ====== FASE DE GRUPOS ====== */}
      <section>
        <h2 className="text-xl font-bold mb-3">📋 Fase de Grupos</h2>
        <div className="grid lg:grid-cols-2 gap-6">
          {groupCodes.map(g => (
            <GroupCard
              key={g}
              group={g}
              matches={groupStageByGroup.get(g) ?? []}
              bets={bets}
              teamById={teamById}
              standings={standings.get(g) ?? []}
              onScoreChange={updateScore}
              gamesPlayed={gamesPerGroup.get(g) ?? 0}
              disabled={isLocked}
            />
          ))}
        </div>
      </section>

      {/* ====== Anexo C identificado ====== */}
      <section className="bg-brand-50 border border-brand-100 rounded-xl p-4">
        <h2 className="text-lg font-bold mb-2">🔍 Identificação Anexo C FIFA</h2>
        <div className="text-sm space-y-1">
          {!groupsMature && (
            <p className="text-amber-700">
              ⏳ Aguardando ao menos <strong>{MIN_GAMES_PER_GROUP_FOR_BRACKET} jogos preenchidos</strong> em cada grupo para liberar o mata-mata.
            </p>
          )}
          {groupsMature && (
            <>
              <p>Grupos com 3º colocado classificado: <strong className="font-mono">{qualifyingKey || '—'}</strong></p>
              <p>Opção FIFA: <strong className="font-mono">{annexCOption ? `#${annexCOption.option_number}` : '—'}</strong></p>
              {annexCOption && (
                <p className="text-xs text-gray-600">
                  1A vs 3{annexCOption.pos_1a} · 1B vs 3{annexCOption.pos_1b} · 1D vs 3{annexCOption.pos_1d} · 1E vs 3{annexCOption.pos_1e} ·
                  1G vs 3{annexCOption.pos_1g} · 1I vs 3{annexCOption.pos_1i} · 1K vs 3{annexCOption.pos_1k} · 1L vs 3{annexCOption.pos_1l}
                </p>
              )}
            </>
          )}
        </div>
      </section>

      {/* ====== MATA-MATA ====== */}
      <KnockoutBracket title="🥊 16-avos de Final" matches={r32} bets={bets}
        teamForSide={teamForMatchSide} onScoreChange={updateScore} onAdvancerChange={updateAdvancer}
        groupsMature={groupsMature} disabled={isLocked} />
      <KnockoutBracket title="🥊 Oitavas de Final" matches={r16} bets={bets}
        teamForSide={teamForMatchSide} onScoreChange={updateScore} onAdvancerChange={updateAdvancer}
        groupsMature={groupsMature} disabled={isLocked} />
      <KnockoutBracket title="🥊 Quartas de Final" matches={qf} bets={bets}
        teamForSide={teamForMatchSide} onScoreChange={updateScore} onAdvancerChange={updateAdvancer}
        groupsMature={groupsMature} disabled={isLocked} />
      <KnockoutBracket title="🥊 Semifinais" matches={sf} bets={bets}
        teamForSide={teamForMatchSide} onScoreChange={updateScore} onAdvancerChange={updateAdvancer}
        groupsMature={groupsMature} disabled={isLocked} />
      {tp && (
        <KnockoutBracket title="🥉 Disputa do 3º Lugar" matches={[tp]} bets={bets}
          teamForSide={teamForMatchSide} onScoreChange={updateScore} onAdvancerChange={updateAdvancer}
          groupsMature={groupsMature} disabled={isLocked} />
      )}
      {fn && (
        <KnockoutBracket title="🏆 Final" matches={[fn]} bets={bets}
          teamForSide={teamForMatchSide} onScoreChange={updateScore} onAdvancerChange={updateAdvancer}
          groupsMature={groupsMature} disabled={isLocked} />
      )}

      {/* ====== RESUMO FINAL ======
          Mesmo `summaryTeams` do resumo do topo — garante que TOPO e FINAL
          exibam exatamente os mesmos valores. */}
      <BetSummary
        champion={summaryTeams.champion}
        vice={summaryTeams.vice}
        third={summaryTeams.third}
      />
    </div>
  );
}

// ================================================================
// SUB-COMPONENTS
// ================================================================

function GroupCard({
  group, matches, bets, teamById, standings, onScoreChange, gamesPlayed, disabled,
}: {
  group: GroupCode;
  matches: Match[];
  bets: Map<number, LocalBet>;
  teamById: Map<number, Team>;
  standings: { rank: number; team_name: string; points: number; goal_diff: number; goals_for: number }[];
  onScoreChange: (id: number, field: 'home' | 'away', val: string) => void;
  gamesPlayed: number;
  disabled?: boolean;
}) {
  return (
    <div className="bg-white rounded-xl shadow-sm overflow-hidden">
      <div className="bg-brand-500 text-white px-4 py-2 font-bold flex justify-between items-center">
        <span>Grupo {group}</span>
        <span className="text-xs opacity-80">{gamesPlayed}/{matches.length} jogos</span>
      </div>
      <div className="p-3 space-y-1">
        {matches.map(m => {
          const home = teamById.get(m.home_team_id ?? -1);
          const away = teamById.get(m.away_team_id ?? -1);
          const lb = bets.get(m.id) ?? { home: '', away: '', saved: false, saving: false };
          const dateStr = `${m.match_date.slice(8, 10)}/${m.match_date.slice(5, 7)}`;
          const timeStr = m.kickoff_brt.slice(0, 5);
          const dateTimeFull = `${dateStr} ${timeStr}`;
          return (
            <div key={m.id} className="flex items-center text-sm gap-1.5 sm:gap-2 py-1">
              {/* Data/hora: mobile compacto / desktop completo */}
              <div className="text-[10px] sm:text-xs text-gray-500 shrink-0 w-12 sm:w-20" title={dateTimeFull}>
                <span className="block sm:hidden leading-tight">{dateStr}<br/>🕐{timeStr}</span>
                <span className="hidden sm:inline">{dateStr} {timeStr}</span>
              </div>
              <div className="flex-1 text-right truncate min-w-0">
                <TeamNameWithFlag team={home} reverse maxChars={18} responsive />
              </div>
              <input type="number" min="0" max="20" inputMode="numeric" className="score-input"
                disabled={disabled}
                value={lb.home} onChange={e => onScoreChange(m.id, 'home', e.target.value)} />
              <span className="text-gray-400">×</span>
              <input type="number" min="0" max="20" inputMode="numeric" className="score-input"
                disabled={disabled}
                value={lb.away} onChange={e => onScoreChange(m.id, 'away', e.target.value)} />
              <div className="flex-1 truncate min-w-0">
                <TeamNameWithFlag team={away} maxChars={18} responsive />
              </div>
              <div className="w-4 shrink-0">{lb.saving ? '…' : lb.saved ? '✓' : ''}</div>
            </div>
          );
        })}
      </div>
      <div className="bg-gray-50 px-3 py-2 border-t text-xs">
        <table className="w-full">
          <thead>
            <tr className="text-gray-600">
              <th className="text-left">Time</th><th>P</th><th>SG</th><th>GP</th>
            </tr>
          </thead>
          <tbody>
            {standings.map(s => (
              <tr key={s.team_name}>
                <td><TeamNameWithFlag name={s.team_name} size="sm" /></td>
                <td className="text-center font-semibold">{s.points}</td>
                <td className="text-center">{s.goal_diff >= 0 ? `+${s.goal_diff}` : s.goal_diff}</td>
                <td className="text-center">{s.goals_for}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function KnockoutBracket({
  title, matches, bets, teamForSide, onScoreChange, onAdvancerChange, groupsMature, disabled,
}: {
  title: string;
  matches: Match[];
  bets: Map<number, LocalBet>;
  teamForSide: (m: Match, side: 'home' | 'away') => Team | null;
  onScoreChange: (id: number, field: 'home' | 'away', val: string) => void;
  onAdvancerChange: (id: number, advancer: 'home' | 'away') => void;
  groupsMature: boolean;
  disabled?: boolean;
}) {
  if (matches.length === 0) return null;
  return (
    <section className="bg-white rounded-xl shadow-sm">
      <div className="bg-brand-500 text-white px-4 py-2 font-bold rounded-t-xl">{title}</div>
      <div className="p-3 divide-y">
        {!groupsMature && (
          <div className="text-center text-gray-500 italic py-6">
            ⏳ Aguardando definição da fase de grupos (mínimo {MIN_GAMES_PER_GROUP_FOR_BRACKET} jogos por grupo)
          </div>
        )}
        {groupsMature && matches.map(m => {
          const lb = bets.get(m.id) ?? { home: '', away: '', advancer: null, saved: false, saving: false };
          const home = teamForSide(m, 'home');
          const away = teamForSide(m, 'away');
          const isTie = lb.home !== '' && lb.away !== '' && lb.home === lb.away;

          const dateStr = `${m.match_date.slice(8, 10)}/${m.match_date.slice(5, 7)}`;
          const timeStr = m.kickoff_brt.slice(0, 5);
          const dateTimeFull = `#${m.id} · ${dateStr} ${timeStr}${m.venue ? ` · ${m.venue}` : ''}`;
          return (
            <div key={m.id} className="py-3">
              <div className="flex items-center text-sm gap-1.5 sm:gap-2 flex-wrap">
                <div className="text-[10px] sm:text-xs text-gray-500 shrink-0 w-12 sm:w-24" title={dateTimeFull}>
                  <span className="block sm:hidden leading-tight">#{m.id}<br/>{dateStr}</span>
                  <span className="hidden sm:inline">#{m.id} · {dateStr} {timeStr}</span>
                </div>
                <div className="flex-1 min-w-0 text-right">
                  {home ? <TeamNameWithFlag team={home} reverse maxChars={20} responsive /> :
                    <span className="text-gray-400 italic text-xs">aguardando…</span>}
                </div>
                <input type="number" min="0" max="20" inputMode="numeric" className="score-input"
                  disabled={!home || !away || disabled}
                  value={lb.home} onChange={e => onScoreChange(m.id, 'home', e.target.value)} />
                <span className="text-gray-400">×</span>
                <input type="number" min="0" max="20" inputMode="numeric" className="score-input"
                  disabled={!home || !away || disabled}
                  value={lb.away} onChange={e => onScoreChange(m.id, 'away', e.target.value)} />
                <div className="flex-1 min-w-0">
                  {away ? <TeamNameWithFlag team={away} maxChars={20} responsive /> :
                    <span className="text-gray-400 italic text-xs">aguardando…</span>}
                </div>
                {/* Sede só no desktop */}
                <div className="hidden sm:block w-16 text-xs text-gray-500">{m.venue}</div>
                <div className="w-4 shrink-0">{lb.saving ? '…' : lb.saved ? '✓' : ''}</div>
              </div>
              {/* Pênaltis: só se empate e KO */}
              {isTie && home && away && (
                <div className="mt-2 ml-0 sm:ml-24 flex items-center gap-2 sm:gap-3 text-xs bg-amber-50 border border-amber-200 rounded p-2 flex-wrap">
                  <span className="font-medium text-amber-900">Empate! Quem avança nos pênaltis?</span>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input type="radio" name={`adv_${m.id}`} checked={lb.advancer === 'home'}
                      disabled={disabled}
                      onChange={() => onAdvancerChange(m.id, 'home')} />
                    <TeamNameWithFlag team={home} size="sm" />
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input type="radio" name={`adv_${m.id}`} checked={lb.advancer === 'away'}
                      disabled={disabled}
                      onChange={() => onAdvancerChange(m.id, 'away')} />
                    <TeamNameWithFlag team={away} size="sm" />
                  </label>
                  {!lb.advancer && <span className="text-red-600 ml-2">⚠️ obrigatório</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
