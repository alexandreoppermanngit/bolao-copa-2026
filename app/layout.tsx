import './globals.css';
import type { Metadata } from 'next';
import { Header } from '@/components/Header';

export const metadata: Metadata = {
  title: 'Bolão Copa do Mundo FIFA 2026',
  description: 'USA · Canadá · México — 11/06 a 19/07/2026',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1 max-w-7xl mx-auto px-4 py-6 w-full">{children}</main>
        <footer className="border-t bg-white py-4 text-center text-sm text-gray-600">
          Bolão Copa 2026 · Dados conforme regulamento oficial FIFA.
        </footer>
      </body>
    </html>
  );
}
