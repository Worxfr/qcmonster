# QCMonster, front PWA (lot 4)

- Dev: `npm run mock` (racine, port 4010) puis `npm run dev -w web`. `.env.development` active le mode mock (`VITE_AUTH_MODE=mock`); il est ignore dans tout build de production.
- Build: `npm run build -w web` (types, tests, build, controle PWA et CSP).
- Variables de build de production, toutes obligatoires: `VITE_API_URL`, `VITE_COGNITO_POOL_ID`, `VITE_COGNITO_CLIENT_ID`. Sans elles l'ecran de connexion affiche une erreur de configuration.
- Jetons Cognito: `sessionStorage` (perdus a la fermeture de l'onglet).
- CSP: posee en `<meta>` au build (voir `vite.config.ts`). Pour la poser en en-tete CloudFront, reprendre les memes directives: `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' <origine API> https://cognito-idp.<region>.amazonaws.com https://*.s3.<region>.amazonaws.com; img-src 'self' data: blob: https://*.s3.<region>.amazonaws.com; form-action 'self' https://*.s3.<region>.amazonaws.com; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'`.
- Badges: affiches seulement ceux renvoyes par `POST /answers` pendant la session (voir demande de contrat dans la PR).
