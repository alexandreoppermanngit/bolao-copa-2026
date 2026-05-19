import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

const BetSchema = z.object({
  match_id: z.number().int().positive(),
  home_score: z.number().int().min(0).max(30),
  away_score: z.number().int().min(0).max(30),
  knockout_advancer: z.enum(['home', 'away']).optional().nullable(),
});

/** Endpoint alternativo (a página usa supabase client direto, mas API é útil p/ mobile). */
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = BetSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.format() }, { status: 400 });

  // Verifica se jogo está aberto para apostas
  const { data: match } = await supabase.from('matches').select('*').eq('id', parsed.data.match_id).single();
  if (!match) return NextResponse.json({ error: 'Jogo não encontrado' }, { status: 404 });
  if (match.locked_for_bets) return NextResponse.json({ error: 'Apostas fechadas para este jogo' }, { status: 403 });
  const { data: settings } = await supabase.from('settings').select('*').single();
  if (settings?.bets_locked) return NextResponse.json({ error: 'Apostas globais bloqueadas' }, { status: 403 });
  if (settings?.global_bets_deadline && new Date(settings.global_bets_deadline) < new Date()) {
    return NextResponse.json({ error: 'Prazo global encerrado' }, { status: 403 });
  }

  const { error } = await supabase.from('bets').upsert({
    user_id: user.id,
    match_id: parsed.data.match_id,
    home_score: parsed.data.home_score,
    away_score: parsed.data.away_score,
    knockout_advancer: parsed.data.knockout_advancer ?? null,
  }, { onConflict: 'user_id,match_id' });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data, error } = await supabase.from('bets').select('*').eq('user_id', user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ bets: data });
}
