# /public/images

## hero-copa-2026.webp

Arte horizontal usada como background da seção hero da home (`app/page.tsx`).

**Recomendações:**

- Formato: `.jpg` (compressão ~80%) ou `.webp` (preferível em produção).
- Resolução mínima: **1920×1080** (Full HD horizontal).
- Resolução ideal: **2400×1200** (cobre telas 2K sem perda perceptível).
- Tamanho de arquivo: idealmente < 350 KB. Se a sua versão estiver maior,
  passe por um otimizador (ex: squoosh.app, tinypng.com).
- Conteúdo sugerido: estádio, taça, jogadores, bandeiras dos 48 países.
- Importante: a imagem ficará com **overlay escuro/gradiente** para legibilidade
  do texto branco do hero. Você não precisa "deixar espaço" para o texto;
  o overlay já garante contraste.

**Como trocar a imagem:**

1. Coloque o arquivo aqui em `public/images/hero-copa-2026.webp` (mesmo nome).
2. Faça commit + push — Vercel publica em segundos.
3. Não é necessário alterar código.

Se preferir outro nome ou formato, atualize a referência em `app/page.tsx`
(busque por `/images/hero-copa-2026.webp`).

## hero-copa-2026.webp (fallback)

Placeholder em SVG que será exibido caso o JPG ainda não tenha sido enviado.
Não é usado em produção — apenas evita "imagem quebrada" antes do upload.
O `app/page.tsx` referencia o `.jpg`; o `.svg` é uma cópia para uso manual
caso queira testar antes de ter a arte definitiva.
