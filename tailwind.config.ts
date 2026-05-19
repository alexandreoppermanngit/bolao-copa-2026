import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Cores referenciadas na planilha (azul institucional + acentos)
        brand: {
          50: '#eef5ff',
          100: '#d9e8ff',
          500: '#1f4e79',
          600: '#163a5a',
          700: '#0f2a42',
          900: '#08182a',
        },
        accent: { red: '#c00000', gold: '#d4a017' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
