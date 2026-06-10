// Tipos do banco — espelham o schema SQL. Quando gerar via supabase-cli pode substituir.

export type MatchPhase =
  | 'group_stage_1'
  | 'group_stage_2'
  | 'group_stage_3'
  | 'round_of_32'
  | 'round_of_16'
  | 'quarter_finals'
  | 'semi_finals'
  | 'third_place'
  | 'final';

export type GroupCode =
  'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L';

export interface Team {
  id: number;
  name: string;
  group_code: GroupCode;
  flag_url?: string | null;
}

export interface Match {
  id: number;
  phase: MatchPhase;
  group_code: GroupCode | null;
  match_date: string;             // ISO date
  kickoff_brt: string;            // HH:MM
  venue: string | null;
  home_team_id: number | null;
  away_team_id: number | null;
  home_placeholder: string | null;
  away_placeholder: string | null;
  home_score: number | null;
  away_score: number | null;
  home_pens: number | null;
  away_pens: number | null;
  result_code: 'home' | 'away' | 'draw' | null;
  locked_for_bets: boolean;
  bets_deadline: string | null;
}

export interface Bet {
  id: number;
  user_id: string;
  match_id: number;
  home_score: number;
  away_score: number;
  knockout_advancer: 'home' | 'away' | null;
  points: number;
  points_with_zebra: number;
  updated_at: string;
  // Migration 008 — snapshot dos times do palpite. Nullable porque bets
  // criadas antes da migration ficam null até o backfill rodar (e bets
  // de KO em que a simulação não conseguiu resolver permanecem null).
  bet_home_team_id?: number | null;
  bet_away_team_id?: number | null;
}

export interface Profile {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  is_admin: boolean;
  /**
   * Permissão intermediária (migration 004). Quando true (e is_admin = false),
   * o usuário acessa apenas /admin/resultados + APIs de resultado/recálculo.
   */
  can_edit_results: boolean;
}

export interface AnnexCOption {
  option_number: number;
  sorted_key: string;
  pos_1a: string; pos_1b: string; pos_1d: string; pos_1e: string;
  pos_1g: string; pos_1i: string; pos_1k: string; pos_1l: string;
}

export interface GroupStanding {
  team_id: number;
  team_name: string;
  group_code: GroupCode;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goals_for: number;
  goals_against: number;
  goal_diff: number;
  points: number;
}

export interface Settings {
  global_bets_deadline: string | null;
  bets_locked: boolean;
  pts_correct_result: number;
  pts_correct_home: number;
  pts_correct_away: number;
  pts_correct_diff: number;
  zebra_threshold_easy: number;
  zebra_threshold_mid: number;
  zebra_mult_easy: number;
  zebra_mult_mid: number;
  zebra_mult_hard: number;
  // Pontuação de classificados por fase (migration 003 + 006)
  pts_qual_groups: number;
  pts_qual_r32: number;
  pts_qual_r16: number;
  pts_qual_quarters: number;
  pts_qual_semis: number;
  pts_qual_third: number;
  pts_qual_runner_up: number;  // migration 006 — vice-campeão (perdedor da final)
  pts_qual_champion: number;
}

export type QualificationPhase =
  | 'group_stage' | 'r32' | 'r16' | 'quarters' | 'semis'
  | 'third_place' | 'runner_up' | 'champion';

export interface BracketOverride {
  id: number;
  match_id: number;
  side: 'home' | 'away';
  team_id: number | null;
  reason: string | null;
  created_by: string | null;
  created_at: string;
}

export interface UserQualificationScore {
  id: number;
  user_id: string;
  phase: QualificationPhase;
  team_id: number;
  predicted: boolean;
  is_correct: boolean;
  points_base: number;
  factor: number;
  points_final: number;
  updated_at: string;
}
