"use client";

import { useState } from "react";

type PixCopyBoxProps = {
  pixKey?: string;
  amount?: string;
};

export default function PixCopyBox({
  pixKey = "21982276364",
  amount = "R$ 50",
}: PixCopyBoxProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(pixKey);
      setCopied(true);

      window.setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      setCopied(false);
      alert("Não foi possível copiar o PIX. Copie manualmente: " + pixKey);
    }
  }

  return (
    <div className="rounded-2xl border border-white/20 bg-black/30 p-4 text-white shadow-lg backdrop-blur">
      <p className="text-sm uppercase tracking-[0.2em] text-white/70">
        Valor do bolão
      </p>

      <p className="mt-1 text-2xl font-bold">{amount}</p>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-white/70">PIX</p>
          <p className="font-mono text-lg font-semibold">{pixKey}</p>
        </div>

        <button
          type="button"
          onClick={handleCopy}
          className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-white/90"
        >
          {copied ? "PIX copiado" : "Copiar PIX"}
        </button>
      </div>
    </div>
  );
}
