/**
 * Status de bloqueio de apostas — função central usada por:
 *   - API que salva apostas (`/api/bets/save`)
 *   - UI da página `/apostas` (desabilitar inputs)
 *   - Server-side render para mostrar banner
 *
 * Regra: apostas BLOQUEADAS quando QUALQUER uma é verdadeira:
 *   - settings.bets_locked = true
 *   - settings.global_bets_deadline <= now()  (UTC)
 *   - match.locked_for_bets = true  (por jogo, opcional)
 *   - match.bets_deadline <= now()  (por jogo, opcional)
 */

import type { Settings, Match } from '@/types/database';

export type LockReason =
  | 'global_lock'        // admin marcou checkbox
  | 'global_deadline'    // global_bets_deadline expirou
  | 'match_lock'         // match.locked_for_bets
  | 'match_deadline';    // match.bets_deadline expirou

export interface LockStatus {
  locked: boolean;
  reason: LockReason | null;
  deadline?: string | null;  // ISO timestamp, se aplicável
  message: string;
}

export function getGlobalLockStatus(
  settings: Pick<Settings, 'bets_locked' | 'global_bets_deadline'> | null,
  now: Date = new Date(),
): LockStatus {
  if (!settings) return { locked: false, reason: null, message: '' };
  if (settings.bets_locked === true) {
    return {
      locked: true, reason: 'global_lock',
      message: 'Apostas encerradas pelo administrador.',
    };
  }
  if (settings.global_bets_deadline) {
    const deadline = new Date(settings.global_bets_deadline);
    if (deadline.getTime() <= now.getTime()) {
      return {
        locked: true, reason: 'global_deadline',
        deadline: settings.global_bets_deadline,
        message: `Apostas encerradas em ${deadline.toLocaleString('pt-BR')}.`,
      };
    }
  }
  return {
    locked: false, reason: null,
    deadline: settings.global_bets_deadline ?? null,
    message: settings.global_bets_deadline
      ? `Apostas abertas até ${new Date(settings.global_bets_deadline).toLocaleString('pt-BR')}.`
      : 'Apostas abertas.',
  };
}

/**
 * Verifica bloqueio considerando TANTO global quanto por-jogo.
 * Use em `/api/bets/save` para validar uma aposta específica.
 */
export function getMatchBetLockStatus(
  settings: Pick<Settings, 'bets_locked' | 'global_bets_deadline'> | null,
  match: Pick<Match, 'locked_for_bets' | 'bets_deadline'> | null,
  now: Date = new Date(),
): LockStatus {
  const global = getGlobalLockStatus(settings, now);
  if (global.locked) return global;
  if (!match) return global;
  if (match.locked_for_bets === true) {
    return {
      locked: true, reason: 'match_lock',
      message: 'Apostas encerradas para este jogo.',
    };
  }
  if (match.bets_deadline) {
    const dl = new Date(match.bets_deadline);
    if (dl.getTime() <= now.getTime()) {
      return {
        locked: true, reason: 'match_deadline',
        deadline: match.bets_deadline,
        message: `Apostas para este jogo encerraram em ${dl.toLocaleString('pt-BR')}.`,
      };
    }
  }
  return global;
}
