# AI WA Agent

Agent IA WhatsApp **gratuit** — connexion simple, **sans préfixe**, prompt configurable avant la première utilisation.

## Comportement

- Tu écris n'importe quel message → l'agent répond automatiquement
- **Aucun préfixe** nécessaire (`.ai`, `.menu`, etc. ne sont plus obligatoires)
- Le **prompt système** définit le rôle de l'agent **avant** qu'il reçoive le premier message

## Déploiement sur Render

### 1. Nouveau Web Service
- [render.com](https://render.com) → **New +** → **Web Service**
- Repo : `ai-wa-agent`
- Runtime : **Docker**
- Plan : **Free**

### 2. Variables d'environnement (très important)

| Variable | Description | Exemple |
|----------|-------------|--------|
| `GEMINI_API_KEY` | Clé gratuite Gemini | `AIza...` |
| `SYSTEM_PROMPT` | **Prompt de l'agent** (rôle + règles) | Voir exemple ci-dessous |
| `OWNER_NUMBER` | Ton numéro (pour le pairing) | `2376XXXXXXXX` |
| `BOT_NAME` | Nom affiché | `CMR AI Agent` |

#### Exemple de `SYSTEM_PROMPT`

```
Tu es un professeur de Maths et Physique pour les classes de Seconde, Première et Terminale au Cameroun. Tu expliques clairement, tu donnes des exemples simples, et tu encourages l'élève. Réponds toujours en français, de façon courte et adaptée à WhatsApp.
```

Tu peux changer ce prompt à tout moment dans Render → Environment → puis redéployer.

### 3. Connexion WhatsApp
1. Ouvre les **Logs** de Render
2. Note le **code de pairing**
3. WhatsApp → Appareils connectés → Lier avec un numéro → entre le code

### 4. Utilisation
Écris simplement un message (ex: *Explique la photosynthèse*) → l'agent répond.

## Clé Gemini gratuite
[aistudio.google.com/apikey](https://aistudio.google.com/apikey)

## Notes
- Plan Free Render : le service s'endort après inactivité. Il se réveille au prochain message (parfois 30–60 s).
- Les messages de **groupe** sont ignorés par défaut (pour éviter le spam).
- Ne partage jamais ta `GEMINI_API_KEY`.
