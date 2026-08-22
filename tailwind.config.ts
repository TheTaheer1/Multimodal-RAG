import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#172026",
        paper: "#f7f4ef",
        moss: "#2d5f54",
        rust: "#a4502a",
        steel: "#496778"
      }
    }
  },
  plugins: []
};

export default config;
