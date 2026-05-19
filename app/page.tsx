import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';

export default async function HomePage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { count: totalUsers } = await supabase.from('profiles').select('*', { count: 'exact', head: true });
  const { count: totalBets } = await supabase.from('bets').select('*', { count: 'exact', head: true });

  return (
    <div className="space-y-8">
      <section className="bg-gradient-to-br from-brand-500 to-brand-700 text-white rounded-xl p-8 md:p-12 shadow-lg">
        <h1 className="text-3xl md:text-5xl font-bold mb-3">🏆 Bolão Copa do Mundo 2026</h1>
        <p className="text-lg opacity-90">Estados Unidos · Canadá · México · 11/06 a 19/07/2026</p>
        <p className="mt-4 text-brand-100 max-w-2xl">
          48 seleções · 12 grupos · 104 jogos. Faça seus palpites para todos os jogos, da fase de grupos
          até a final, e dispute o ranking geral e o ranking zebra com os outros apostadores.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          {user
            ? <Link href="/apostas" className="btn bg-white text-brand-600">Ir para minhas apostas →</Link>
            : <Link href="/login" className="btn bg-white text-brand-600">Entrar com Google</Link>}
          <Link href="/ranking" className="btn bg-brand-700 text-white border border-brand-100">Ver Ranking</Link>
        </div>
      </section>

      <section className="grid sm:grid-cols-3 gap-4">
        <Card title="Apostadores" value={totalUsers ?? 0} />
        <Card title="Apostas registradas" value={totalBets ?? 0} />
        <Card title="Total de jogos" value={104} />
      </section>

      <section className="bg-white rounded-xl p-6 shadow-sm">
        <h2 className="text-xl font-bold mb-3">📋 Como funciona a pontuação</h2>
        <ul className="space-y-1 text-sm">
          <li><strong>Acertou resultado</strong> (vitória/empate/derrota): <strong>5 pts</strong></li>
          <li><strong>+ placar do time 1:</strong> +2 pts</li>
          <li><strong>+ placar do time 2:</strong> +2 pts</li>
          <li><strong>+ diferença de gols:</strong> +1 pt</li>
          <li><strong>Multiplicador Zebra:</strong> até 2.0x quando o resultado foi pouco apostado</li>
        </ul>
      </section>

      <section className="bg-white rounded-xl p-6 shadow-sm">
        <h2 className="text-xl font-bold mb-3">🏟️ Estrutura</h2>
        <div className="grid sm:grid-cols-2 gap-4 text-sm">
          <div>
            <h3 className="font-semibold mb-1">Fase de Grupos</h3>
            <p>12 grupos (A–L) · 4 seleções por grupo · 72 jogos</p>
          </div>
          <div>
            <h3 className="font-semibold mb-1">Mata-mata</h3>
            <p>16-avos → Oitavas → Quartas → Semis → Final (32 jogos)</p>
            <p className="text-xs text-gray-600 mt-1">
              Classificados: 1º e 2º de cada grupo (24) + 8 melhores 3ºs colocados
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function Card({ title, value }: { title: string; value: number }) {
  return (
    <div className="bg-white rounded-xl p-4 shadow-sm">
      <div className="text-sm text-gray-600">{title}</div>
      <div className="text-3xl font-bold text-brand-500 mt-1">{value}</div>
    </div>
  );
}
