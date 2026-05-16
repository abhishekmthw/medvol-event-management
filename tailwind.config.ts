import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef9ff",
          100: "#d9f0ff",
          200: "#bbe5ff",
          300: "#8dd5ff",
          400: "#58bbff",
          500: "#319bff",
          600: "#1a7af5",
          700: "#1463de",
          800: "#1652b3",
          900: "#17488d",
          950: "#0f2b56",
        },
      },
      fontFamily: {
        sans: [
          "var(--font-sans)",
          "ITC Avant Garde Gothic",
          "Century Gothic",
          "system-ui",
          "sans-serif",
        ],
      },
      letterSpacing: {
        avantgarde: "0.005em",
      },
      backgroundImage: {
        "grid-light":
          "radial-gradient(circle at 1px 1px, rgba(15,23,42,0.06) 1px, transparent 0)",
        "grid-dark":
          "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.06) 1px, transparent 0)",
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(49,155,255,0.25), 0 10px 30px -10px rgba(26,122,245,0.45)",
      },
      animation: {
        "fade-in": "fade-in 0.25s ease-out",
        "slide-up": "slide-up 0.3s ease-out",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
