import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".next-*/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      // Estado local de perfiles y artefactos de pruebas (informe HTML de Playwright, U-QA-02).
      ".biblib/**",
    ],
  },
];

export default eslintConfig;
