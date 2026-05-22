/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    'src/client/kanban/**/*.{tsx,ts}',
    '../../packages/ui/src/kanban/**/*.{tsx,ts}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
