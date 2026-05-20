import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import PixCopyBox from '@/components/PixCopyBox';

export default async function HomePage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { count: totalUsers } = await supabase.from('profiles').select('*', { count: 'exact', head: true });
  const { count: totalBets } = await supabase.from('bets').select('*', { count: 'exact', head: true });

  return (
    <div className="space-y-6 sm:space-y-8">
      {/*
        HERO — background image + overlay gradiente para legibilidade.
        Imagem em /public/images/hero-copa-2026.webp.
        Mobile:  min-height ~54vh
        Desktop: min-height 580px
        Overlay: gradient escuro garante contraste do texto branco.
      */}
      <section
  className="hero-copa-2026 text-white relative overflow-hidden
             left-1/2 right-1/2 w-screen -ml-[50vw] -mr-[50vw]
             px-6 py-10 sm:px-8 md:px-16
             flex flex-col justify-end
             min-h-[54vh] md:min-h-[58vh] max-h-[580px]"
>
  <div className="relative z-10 mx-auto w-full max-w-7xl">
    <div className="max-w-3xl">
      <h1 className="text-3xl sm:text-4xl md:text-6xl font-bold mb-3 drop-shadow-lg">
        🏆 Bolão Copa do Mundo 2026
      </h1>

      <p className="text-base sm:text-lg md:text-xl opacity-95 drop-shadow">
        Estados Unidos · Canadá · México · 11/06 a 19/07/2026
      </p>

      <p className="mt-4 max-w-2xl text-sm sm:text-base md:text-lg opacity-90 drop-shadow">
        48 seleções · 12 grupos · 104 jogos. Faça seus palpites em todos os jogos,
        da fase de grupos até a final, e dispute o ranking geral e o ranking zebra.
      </p>

      <div className="mt-6 flex flex-wrap gap-3">
        {user ? (
          <Link href="/apostas" className="btn bg-white text-brand-600 hover:bg-brand-50">
            Ir para minhas apostas →
          </Link>
        ) : (
          <Link href="/login" className="btn bg-white text-brand-600 hover:bg-brand-50">
            Entrar com Google
          </Link>
        )}

        <Link
          href="/ranking"
          className="btn bg-white/10 backdrop-blur text-white border border-white/40 hover:bg-white/20"
        >
          Ver Ranking
        </Link>
      </div>

      <p className="mt-4 text-sm sm:text-base font-medium drop-shadow">
        Valor: <strong>R$ 50</strong> · PIX:{' '}
        <code className="font-mono">21982276364</code>
      </p>
    </div>
  </div>
</section>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3  sm:gap-4">
        <Card title="Apostadores" value={totalUsers ?? 0} />
        <Card title="Apostas registradas" value={totalBets ?? 0} />
        <Card title="Total de jogos" value={104} />
      </section>

      {/* PIX / valor do bolão */}
      <PixCopyBox pixKey="21982276364" amount="R$50" />

      {/* Como funciona — Fase de Grupos */}
      <section className="bg-white rounded-xl p-5 sm:p-6 shadow-sm">
        <h2 className="text-lg sm:text-xl font-bold mb-3">📋 Como funciona a pontuação — Fase de Grupos</h2>
        <ul className="space-y-1 text-sm sm:text-base">
          <li><strong>Acertou resultado</strong> (vitória/empate/derrota): <strong>5 pts</strong></li>
          <li><strong>+ placar do time 1:</strong> +2 pts</li>
          <li><strong>+ placar do time 2:</strong> +2 pts</li>
          <li><strong>+ diferença de gols:</strong> +1 pt</li>
          <li><strong>Multiplicador Zebra:</strong> até 2,0× quando o resultado foi pouco apostado pelos demais</li>
        </ul>
      </section>

      {/* NOVO — Mata-mata */}
      <section className="bg-white rounded-xl p-5 sm:p-6 shadow-sm border-l-4 border-brand-500">
        <h2 className="text-lg sm:text-xl font-bold mb-3">🥊 Pontuação na 2ª fase em diante (mata-mata)</h2>
        <ul className="space-y-2 text-sm sm:text-base">
          <li>
            ✅ <strong>Você pontua o placar de um jogo de mata-mata APENAS se acertou o confronto</strong>
            {' '}(os dois times que jogaram).
          </li>
          <li>
            🔄 <strong>Vale mesmo se o confronto acontecer em outra fase do mata-mata.</strong>
            {' '}Ex: você apostou Brasil x França nas quartas, mas Brasil x França rolou nas oitavas
            — você ainda pontua o placar do jogo.
          </li>
          <li>
            ↔️ <strong>Vale também se o mando estiver invertido.</strong>
            {' '}Brasil 2×1 França equivale a França 1×2 Brasil — o sistema reconhece e ajusta.
          </li>
          <li>
            ❌ <strong>Se o confronto apostado não aconteceu</strong> em nenhuma fase, o placar não pontua.
          </li>
          <li>
            🚫 <strong>No mata-mata não há multiplicador zebra de placar.</strong>
            {' '}A pontuação é a base (5/+2/+2/+1).
          </li>
        </ul>
      </section>

      {/* NOVO — Classificação de seleções */}
      <section className="bg-white rounded-xl p-5 sm:p-6 shadow-sm border-l-4 border-accent-gold">
        <h2 className="text-lg sm:text-xl font-bold mb-3">🏅 Pontuação por seleção classificada</h2>
        <p className="text-sm sm:text-base mb-3 text-gray-700">
          Além dos pontos por jogos, você ganha pontos sempre que acertar uma seleção que avança
          para uma fase do mata-mata.
        </p>
        <div className="overflow-x-auto">
          <table className="text-xs sm:text-sm w-full">
            <thead className="text-gray-600">
              <tr className="border-b">
                <th className="text-left py-1">Avançou para…</th>
                <th className="text-right py-1">Pts base</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Fase de grupos → R32</td><td className="text-right font-mono">10</td></tr>
              <tr><td>Venceu R32 → R16</td><td className="text-right font-mono">12</td></tr>
              <tr><td>Venceu R16 → Quartas</td><td className="text-right font-mono">15</td></tr>
              <tr><td>Venceu Quartas → Semis</td><td className="text-right font-mono">25</td></tr>
              <tr><td>Finalista (Semis → Final)</td><td className="text-right font-mono">30</td></tr>
              <tr><td>Terceiro lugar</td><td className="text-right font-mono">30</td></tr>
              <tr><td>Campeão</td><td className="text-right font-mono font-bold">40</td></tr>
            </tbody>
          </table>
        </div>
        <p className="text-xs sm:text-sm mt-3 text-gray-700">
          🦓 <strong>Fator zebra de classificação:</strong> quanto mais raro for o palpite (poucos
          apostadores escolheram aquela seleção), maior o multiplicador. Pode chegar a 2,0× quando
          quase ninguém acreditou.
        </p>
      </section>

      <section className="bg-white rounded-xl p-5 sm:p-6 shadow-sm">
        <h2 className="text-lg sm:text-xl font-bold mb-3">🏟️ Estrutura</h2>
        <div className="grid sm:grid-cols-2 gap-4 text-sm sm:text-base">
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
    <div className="bg-white rounded-xl p-3 sm:p-4 shadow-sm">
      <div className="text-xs sm:text-sm text-gray-600">{title}</div>
      <div className="text-2xl sm:text-3xl font-bold text-brand-500 mt-1">{value}</div>
    </div>
  );
}
