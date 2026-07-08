import type { Config } from "tailwindcss";

/**
 * Design-system theme (Phase 1). Colors, fonts, radius, and shadow all resolve to the CSS
 * variables defined in app/globals.css — components reference semantic names (bg-surface,
 * text-ink-muted, border-line, text-primary, bg-hot-weak, …) instead of raw Tailwind scales.
 * Default Tailwind colors remain available for not-yet-migrated components.
 */
const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        canvas: "var(--canvas)",
        surface: {
          DEFAULT: "var(--surface)",
          muted: "var(--surface-muted)",
        },
        line: {
          DEFAULT: "var(--line)",
          strong: "var(--line-strong)",
        },
        ink: {
          DEFAULT: "var(--ink)",
          muted: "var(--ink-muted)",
          subtle: "var(--ink-subtle)",
        },
        primary: {
          DEFAULT: "var(--primary)",
          strong: "var(--primary-strong)",
          weak: "var(--primary-weak)",
          fg: "var(--primary-fg)",
        },
        good: { DEFAULT: "var(--good)", weak: "var(--good-weak)" },
        warn: { DEFAULT: "var(--warn)", weak: "var(--warn-weak)" },
        danger: { DEFAULT: "var(--danger)", weak: "var(--danger-weak)" },
        hot: { DEFAULT: "var(--hot)", weak: "var(--hot-weak)" },
        warm: { DEFAULT: "var(--warm)", weak: "var(--warm-weak)" },
        cold: { DEFAULT: "var(--cold)", weak: "var(--cold-weak)" },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      borderRadius: {
        card: "16px",
      },
      boxShadow: {
        card: "var(--shadow-card)",
        pop: "var(--shadow-pop)",
      },
      ringColor: {
        DEFAULT: "var(--ring)",
      },
    },
  },
  plugins: [],
};

export default config;
