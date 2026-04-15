/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Space Grotesk"', "system-ui", "sans-serif"],
        sans: ['"DM Sans"', "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        canvas: "#FAFAF8",
        gold: {
          DEFAULT: "#88952E",
          50: "#f7f8ec",
          100: "#eef0d5",
          200: "#dce3ac",
          300: "#c4d077",
          400: "#abbe4b",
          500: "#88952E",
          600: "#6b7525",
          700: "#525a1d",
          800: "#3e4417",
          900: "#2e3211",
        },
        surface: "#FFFFFF",
        border: "#E8E6E0",
        muted: "#9B9589",
      },
      borderRadius: {
        xl: "12px",
        "2xl": "16px",
      },
      boxShadow: {
        card: "0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.04)",
        "card-hover":
          "0 4px 12px 0 rgb(0 0 0 / 0.08), 0 2px 4px -1px rgb(0 0 0 / 0.06)",
      },
    },
  },
  plugins: [],
};
